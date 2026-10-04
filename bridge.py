# -*- coding: utf-8 -*-
"""
提示词管理器 × 豆啦啦浏览器批量生成 —— 桥接模块。

复用 dola_browser_bridge 插件（dola_plugin）的生成引擎：连接实例、分发、同步提示词、
生成、校验 MP4、写盘，全部由插件的 generate() 完成。
本模块只负责：
  1. 定位并加载插件（同项目目录 dola_browser_bridge/dola_browser_bridge/main.py）；
  2. 把「管理器当前文件的分镜」组织成 generate() 需要的上下文；
  3. 管理一个批量任务的生命周期：并发、进度、取消、结果。

仅依赖 Python 标准库。
"""
import os
import sys
import threading
import time
import uuid
import concurrent.futures

BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.join(BRIDGE_DIR, "dola_browser_bridge", "dola_browser_bridge")

_plugin = None
_plugin_err = None
_plugin_lock = threading.Lock()


def _load_plugin():
    """加载豆啦啦浏览器插件 main.py（只加载一次）。"""
    global _plugin, _plugin_err
    if _plugin is not None or _plugin_err is not None:
        return
    with _plugin_lock:
        if _plugin is not None or _plugin_err is not None:
            return
        try:
            if PLUGIN_DIR not in sys.path:
                sys.path.insert(0, PLUGIN_DIR)
            import importlib
            _plugin = importlib.import_module("main")
        except Exception as ex:  # noqa: BLE001
            _plugin_err = f"无法加载豆啦啦浏览器插件：{ex}"


def plugin_ready():
    _load_plugin()
    return _plugin is not None


def plugin_err():
    _load_plugin()
    return _plugin_err


def list_instances(port=17823):
    """读取豆啦啦浏览器实例清单（含未启动）。"""
    _load_plugin()
    if _plugin is None:
        return {"ok": False, "error": _plugin_err}
    try:
        result = _plugin.handle_action(
            "test_connection", {"port": int(port) or 17823}, None
        )
        return result if isinstance(result, dict) else {"ok": False, "error": "接口异常"}
    except Exception as ex:  # noqa: BLE001
        return {"ok": False, "error": f"连接失败：{ex}"}


# ---------------------------------------------------------------
#  批量任务管理
# ---------------------------------------------------------------

_runs = {}
_runs_lock = threading.Lock()
_round_counter = 0
_round_lock = threading.Lock()

# 终端状态（用于进度统计）：done / rejected / service_error / unknown / gate_failed / error
_TERMINAL = ("done", "rejected", "service_error", "unknown", "gate_failed", "error")
# 已发生发送/受理的状态（结果未知也算已投递，不能当“未发送”重发）
_SENT = ("done", "rejected", "service_error", "unknown", "error")


def _classify_outcome(exception):
    """把 generate() 抛出的异常归入平台结果分类（对齐 CDP 工作流的受理判定）。

    返回 (outcome, 人话描述)。
    """
    m = str(exception or "")
    if any(k in m for k in ("出了点问题", "请稍后重试", "服务繁忙", "系统繁忙", "暂时无法")):
        return "service_error", "平台服务临时错误（未明确拒绝）"
    if any(k in m for k in ("未认证人脸", "人脸", "额度不足", "额度", "版权", "生成失败", "违规", "风险提示")):
        return "rejected", "平台拒绝生成"
    if any(k in m for k in (
            "toolbar_video_generation_not_found", "not_found", "超时", "timeout",
            "连接失败", "未启动", "接口不可用", "unreachable", "登出", "logged out",
            "无印浏览器未启动", "浏览器未启动")):
        return "unknown", "结果未知（浏览器/插件未就绪或超时）——请到豆啦啦确认是否已受理，勿盲目重发"
    return "error", None


def _verify_output(path):
    """下载后核验：文件存在、非空、MP4 需带 ftyp 盒（对齐 CDP 工作流的成片核验）。"""
    if not path:
        return False, "生成未返回文件路径"
    if not os.path.isfile(path):
        return False, f"文件不存在：{path}"
    size = os.path.getsize(path)
    if size < 1024 * 1024:
        return False, f"文件过小（{size}B），疑似未生成完整"
    if os.path.splitext(path)[1].lower() == ".mp4":
        try:
            with open(path, "rb") as fh:
                head = fh.read(12)
            if head[4:8] != b"ftyp":
                return False, f"文件不是合法 MP4（缺 ftyp 盒）：{path}"
        except OSError as ex:
            return False, f"无法读取 MP4：{ex}"
    return True, size


def _next_round():
    global _round_counter
    with _round_lock:
        _round_counter += 1
        return _round_counter


def _inject_assets(context, assets):
    """把该分镜的有序资产图注入生成上下文。

    assets: [{slot, name, type, path}]，按 图一、图二… 顺序。
    只注入已匹配到路径的资产；在 prompt 顶部补一行「参考图说明：图1是角色X…」，
    并把 reference_items 传给插件，浏览器端按顺序把图片作为参考图上传。
    """
    refs = []
    decl = []
    for i, ast in enumerate(assets):
        path = (ast.get("path") or "").strip()
        if not path:
            continue
        name = (ast.get("name") or "").strip()
        typ = (ast.get("type") or "资产").strip()
        refs.append({"path": path, "name": name, "reference_type": typ})
        decl.append(f"图{i + 1}是{typ}{name}")
    if refs:
        context["reference_items"] = refs
        prompt = context.get("prompt") or ""
        prefix = "参考图说明：" + "，".join(decl)
        context["prompt"] = prefix + "\n" + prompt if prompt else prefix


def start_batch(shots, output_dir, params):
    """启动一个批量生成任务，立即返回 run_id。

    shots:  [{index, label, prompt, duration?}, ...]
    output_dir: 用户选择的输出目录（不存在会自动创建）
    params: 插件参数覆盖（port/timeout/use_30s/duration_mode/allow_launch 等）
    """
    if not plugin_ready():
        return {"ok": False, "error": plugin_err()}
    if not isinstance(shots, list) or not shots:
        return {"ok": False, "error": "没有可生成的分镜"}
    cleaned = []
    for i, s in enumerate(shots):
        if not isinstance(s, dict):
            continue
        prompt = (s.get("prompt") or "").strip()
        if not prompt:
            continue
        idx = int(s.get("index") or (i + 1))
        cleaned.append({
            "index": idx,
            "label": (s.get("label") or f"分镜{idx}").strip() or f"分镜{idx}",
            "prompt": prompt,
            "duration": float(s.get("duration") or 0),
            "assets": s.get("assets") or [],
        })
    if not cleaned:
        return {"ok": False, "error": "所有分镜提示词均为空，无法生成"}

    run_id = uuid.uuid4().hex[:12]
    params = dict(params or {})
    parallel_limit = max(1, int(params.get("parallel_limit") or 10))
    run = {
        "id": run_id,
        "output_dir": (output_dir or "").strip(),
        "params": params,
        "parallel_limit": parallel_limit,
        "round": _next_round(),
        "gate": None,          # 批量发送前门禁结果 {ok, error}
        "shots": [{
            "index": s["index"],
            "label": s["label"],
            "prompt": s["prompt"],
            "duration": s["duration"],
            "assets": s["assets"],
            "status": "queued",      # queued / running / done / rejected / service_error / unknown / gate_failed / error
            "text": "排队中",
            "pct": 0,
            "path": None,
            "error": None,
        } for s in cleaned],
        "cancel": threading.Event(),
        "done": False,
        "started": time.time(),
    }
    with _runs_lock:
        _runs[run_id] = run

    global _current_run_params
    _current_run_params = params
    threading.Thread(target=_run_batch, args=(run_id,), daemon=True).start()
    return {"ok": True, "run_id": run_id}


def _run_batch(run_id):
    run = _runs.get(run_id)
    if not run:
        return

    # ── 发送前门禁：浏览器/插件未就绪则整批 fail-fast，不消耗额度、不盲发 ──
    gate_ok, gate_msg = _batch_gate()
    run["gate"] = {"ok": gate_ok, "error": gate_msg}
    if not gate_ok:
        for shot in run["shots"]:
            shot["status"] = "gate_failed"
            shot["text"] = "门禁未通过（未提交）"
            shot["error"] = gate_msg
        run["done"] = True
        return

    def _one(shot):
        if run["cancel"].is_set():
            shot["status"] = "error"
            shot["text"] = "已取消"
            shot["error"] = "任务已取消"
            return
        shot["status"] = "running"
        shot["text"] = "生成中…"
        shot["pct"] = 5
        context = {
            "prompt": shot["prompt"],
            "output_dir": run["output_dir"],
            "viewer_index": shot["index"],
            "unique_name": shot["label"],
            "scene_duration": shot["duration"],
            "generation_round": run["round"],
            "plugin_params": run["params"],
            "is_cancelled": run["cancel"].is_set,
            "progress_callback": lambda text, pct, _s=shot: _on_progress(_s, text, pct),
        }
        _inject_assets(context, shot.get("assets") or [])
        try:
            paths = _plugin.generate(context)
            path = paths[0] if paths else None
            # 记录实际使用的浏览器实例（供前端“重新生成”标废号并切换下一个实例）
            shot["instance_id"] = context.get("used_instance_id")
            # ── 下载后核验：文件合法才算 done；无文件归为结果未知 ──
            ok, detail = _verify_output(path)
            if not ok:
                shot["status"] = "unknown" if not path else "error"
                shot["error"] = str(detail)
                shot["text"] = "下载核验未通过" if path else "结果未知（未返回文件）"
                if path:
                    shot["path"] = path
                return
            shot["status"] = "done"
            shot["path"] = path
            shot["text"] = "完成"
            shot["pct"] = 100
        except Exception as ex:  # noqa: BLE001
            outcome, human = _classify_outcome(ex)
            shot["status"] = outcome
            shot["error"] = str(ex)
            shot["text"] = human or "失败"
        finally:
            _record_ledger(run, shot)

    workers = min(max(1, len(run["shots"])), run["parallel_limit"])
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        pool.map(_one, run["shots"])
    run["done"] = True


def _on_progress(shot, text, pct):
    shot["status"] = "running"
    if text:
        shot["text"] = text
    if pct is not None:
        shot["pct"] = pct


# ---------------------------------------------------------------
#  发送前门禁 + 结果台账
# ---------------------------------------------------------------

def _batch_gate(port=None):
    """发送前门禁：豆啦啦浏览器可达且 health 正常才允许整批提交。

    直接探测 http://127.0.0.1:<port>/api/health（同步、线程安全、快速），
    不经过插件异步 test_connection（在后台线程会卡）。未就绪 → 整批 gate_failed，不消耗额度。
    """
    try:
        p = int(port) if port is not None else None
        if not p:
            raw = (_current_run_params or {}).get("port")
            p = int(raw) if raw is not None else 17823
    except Exception:
        p = 17823
    try:
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{p}/api/health", timeout=5) as resp:
            data = json_loads(resp.read().decode("utf-8"))
    except Exception as ex:  # noqa: BLE001
        return False, f"豆啦啦浏览器未就绪（端口 {p} 不可达）：{ex}"
    if not isinstance(data, dict) or not data.get("ok"):
        return False, f"豆啦啦 /api/health 返回异常（端口 {p}）"
    instances = data.get("instances")
    if not isinstance(instances, list):
        return False, f"豆啦啦 health 缺少实例清单（端口 {p}）"
    return True, f"就绪（{len(instances)} 个实例）"


_current_run_params = {}


def _record_ledger(run, shot):
    """把每个分镜的最终结果写进输出目录台账，作为“不可丢失的状态/提交标记”。

    结果未知（unknown/service_error）也记录为已投递，提醒勿盲目重发。
    """
    out = (run.get("output_dir") or "").strip()
    if not out:
        return
    try:
        os.makedirs(out, exist_ok=True)
        ledger_path = os.path.join(out, ".generation_ledger.json")
        data = {}
        if os.path.isfile(ledger_path):
            try:
                with open(ledger_path, "r", encoding="utf-8") as fh:
                    data = json_loads(fh.read())
            except Exception:  # noqa: BLE001
                data = {}
        entry = {
            "shot": shot["index"],
            "label": shot["label"],
            "status": shot["status"],
            "sent": shot["status"] in _SENT,
            "text": shot["text"],
            "path": shot.get("path"),
            "error": shot.get("error"),
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "round": run.get("round"),
        }
        data[f"shot_{shot['index']}"] = entry
        tmp = ledger_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(json_dumps(data, ensure_ascii=False, indent=2))
        os.replace(tmp, ledger_path)
    except Exception:  # noqa: BLE001
        pass


def json_loads(text):
    import json
    return json.loads(text or "{}")


def json_dumps(data, **kw):
    import json
    return json.dumps(data, **kw)


def get_status(run_id):
    with _runs_lock:
        run = _runs.get(run_id)
    if not run:
        return {"ok": False, "error": "任务不存在"}
    shots = run["shots"]
    finished = sum(1 for s in shots if s["status"] in _TERMINAL)
    return {
        "ok": True,
        "done": run["done"],
        "total": len(shots),
        "finished": finished,
        "ok_count": sum(1 for s in shots if s["status"] == "done"),
        "fail_count": sum(1 for s in shots if s["status"] in ("error", "gate_failed", "rejected", "service_error", "unknown")),
        "rejected": sum(1 for s in shots if s["status"] == "rejected"),
        "service_error": sum(1 for s in shots if s["status"] == "service_error"),
        "unknown": sum(1 for s in shots if s["status"] == "unknown"),
        "gate_failed": sum(1 for s in shots if s["status"] == "gate_failed"),
        "gate": run.get("gate"),
        "parallel_limit": run.get("parallel_limit"),
        "cancelled": run["cancel"].is_set(),
        "output_dir": run["output_dir"],
        "shots": [{
            "index": s["index"],
            "label": s["label"],
            "status": s["status"],
            "text": s["text"],
            "pct": s["pct"],
            "path": s["path"],
            "error": s["error"],
        } for s in shots],
    }


def cancel(run_id):
    with _runs_lock:
        run = _runs.get(run_id)
    if not run:
        return {"ok": False, "error": "任务不存在"}
    run["cancel"].set()
    return {"ok": True, "run_id": run_id}
