# -*- coding: utf-8 -*-
"""
CDP 生成引擎：从号池取号 → 启动隔离 Edge（注入 Cookie）→ 填提示词/参考图 →
点真实发送 → 读受理文案 → 轮询成片 → 插件下载核验 → 关闭。
顺序执行：上一镜明确受理才开始下一镜。

基于 dola-cdp-workflow 的 Node CDP 脚本（tools/*.mjs）+ 号池模块（pool.py）。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import socket

import pool
import proxy as proxy_pool

ROOT = Path(__file__).resolve().parent
TOOLS = ROOT / "tools"
STATE = ROOT / "state"
RUNS = STATE / "runs"
SCENES = STATE / "scenes"

# ---------------------------------------------------------------- node 调用
def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _find_node() -> str:
    """优先系统安装的 Node 绝对路径（避免 PATH 里没有 node 时 WinError 2）；找不到再退回 PATH。"""
    for cand in (r"C:\Program Files\nodejs\node.exe",
                 r"C:\Program Files (x86)\nodejs\node.exe"):
        if os.path.isfile(cand):
            return cand
    return "node"


NODE_BIN = os.environ.get("DOLA_NODE") or _find_node()


def _run_node(script: str, args: list, stdin_json=None, timeout: int = 240):
    """spawn 一个 Node CDP 脚本，stdin 传 JSON（如账号凭据），返回 stdout JSON。"""
    cmd = [NODE_BIN, str(TOOLS / script), *[str(a) for a in args]]
    p = subprocess.Popen(
        cmd, cwd=str(TOOLS),
        stdin=subprocess.PIPE if stdin_json is not None else None,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if stdin_json is not None:
        p.stdin.write(json.dumps(stdin_json).encode("utf-8"))
        p.stdin.close()
    out, err = p.communicate(timeout=timeout)
    stdout = out.decode("utf-8", "replace").strip()
    stderr = err.decode("utf-8", "replace").strip()
    if p.returncode != 0:
        raise RuntimeError(stderr or stdout or f"{script} 失败")
    # 提取最后一个完整 JSON 对象（兼容单行与 console.log(...,null,2) 多行缩进输出）
    for pos in [m.start() for m in re.finditer(r"\s*\{", stdout)][::-1]:
        try:
            obj = json.loads(stdout[pos:])
            if isinstance(obj, dict):
                return obj
        except Exception:
            continue
    raise RuntimeError(f"{script} 无有效 JSON 输出：{stdout[:300]}")


# ---------------------------------------------------------------- 分镜受理判定
def classify(tail: str) -> str:
    """按 Dola 页面尾部文案判定受理结果。"""
    if any(t in tail for t in (
            "不支持30秒", "仅支持10秒", "只能10秒", "仅10秒", "最大10秒",
            "暂不支持30秒", "仅支持10s", "只能生成10秒", "不支持30s",
            "30秒暂不可用", "无法使用30秒", "没有30秒", "只有10秒")):
        return "no_30s"
    if "本次使用 Dreamina Seedance 2.5 生成" in tail and "将消耗" in tail:
        return "accepted_generating"
    if "出了点问题，请稍后重试" in tail:
        return "service_error"
    if any(t in tail for t in ("未认证人脸暂不支持", "视频生成额度不足", "生成失败", "该内容涉嫌违规")):
        return "rejected"
    return "sent_outcome_unknown"


# ---------------------------------------------------------------- 单镜流水线
def _launch_browser(account: dict, params: dict, profile_key: str, chat_url: str = ""):
    """启动 Edge CDP 并注入 Cookie，返回 {profile, port, pid, login_state, extension_loaded, url}。"""
    req = {
        "account": {"email": account["email"], "cookies": account["cookies"]},
        "proxy": params.get("proxy") or "http://127.0.0.1:7897",
        "visible": bool(params.get("visible", True)),  # 可见模式必须（无头下视频模式/扩展不可用）
        "profile_key": profile_key,
    }
    if chat_url:
        req["chat_url"] = chat_url
    out = _run_node("browser.mjs", [], stdin_json=req, timeout=240)
    return out


def _write_manifest(run_id: str, shot: dict, assets: list) -> Path:
    SCENES.mkdir(parents=True, exist_ok=True)
    manifest = {
        "run_id": run_id,
        "scene_no": shot.get("scene_no") or shot.get("idx", 0) + 1,
        "prompt": shot.get("prompt") or "",
        "assets": [{"path": p} for p in assets],
    }
    path = SCENES / f"{run_id}_{manifest['scene_no']}.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    return path


def _fill(port: int, manifest: Path):
    return _run_node("fill_scene.mjs", [port, str(manifest)], timeout=180)


def _submit(port: int, manifest: Path):
    return _run_node("submit_one.mjs", [port, str(manifest)], timeout=180)


def _observe(port: int):
    return _run_node("observe_scene.mjs", [port], timeout=60)


def _window_alive(port) -> bool:
    """检测 CDP 调试端口是否仍在监听（浏览器窗口未关闭）。直连端口，不走代理。"""
    try:
        s = socket.create_connection(("127.0.0.1", int(port)), timeout=3)
        s.close()
        return True
    except Exception:
        return False


def _wait_completed(port: int, chat_url: str, cancel_ev=None, max_wait: float = 900):
    """轮询该对话直到出现视频完成卡片。返回观察结果。"""
    deadline = time.monotonic() + max_wait
    last = None
    while time.monotonic() < deadline:
        if cancel_ev and cancel_ev.is_set():
            return {"tail": "", "videoCards": 0, "cancelled": True}
        try:
            last = _observe(port)
        except Exception as e:
            last = {"tail": "", "videoCards": 0, "error": str(e)[:100]}
        if last.get("videoCards", 0) > 0 or "你的视频生成好了" in last.get("tail", ""):
            return last
        tail = last.get("tail", "")
        if classify(tail) == "no_30s":
            last["no_30s"] = True
            return last
        # 失败文案提前终止：含提交后二次审核拒绝（肖像/版权/违规等），均视为失败
        if any(t in tail for t in (
                "未认证人脸", "额度不足", "生成失败", "出了点问题",
                "肖像", "版权", "侵权", "涉嫌违规", "违规内容", "无法生成",
                "内容不合规", "审核未通过", "被驳回")):
            last["rejected"] = True
            return last
        time.sleep(15)
    return last


def _download(port: int, dest: str, chat_url: str):
    # 无水印嗅探/下载可能因网速偶发失败：内部重试多次，仍失败才抛给上层降级原片
    last = None
    for _ in range(3):
        try:
            return _run_node("download_scene.mjs", [port, dest, chat_url], timeout=600)
        except Exception as e:
            last = e
            time.sleep(5)
    raise last


def _download_original(port: int, dest: str, chat_url: str):
    return _run_node("download_original.mjs", [port, dest], timeout=600)


def _video_name(out_dir: str, series: str, scene_no) -> str:
    """视频命名：集数+镜号+序号（同集同镜存在则序号递增）。"""
    prefix = (series or "").strip()
    base = f"{prefix}_镜{scene_no}" if prefix else f"镜{scene_no}"
    n = 1
    while os.path.exists(os.path.join(out_dir, f"{base}_{n}.mp4")):
        n += 1
    return f"{base}_{n}.mp4"


def _video_name_original(out_dir: str, series: str, scene_no) -> str:
    """原片命名：前缀"原片"标注（集数+镜号+序号）。"""
    prefix = (series or "").strip()
    base = f"原片_{prefix}_镜{scene_no}" if prefix else f"原片_镜{scene_no}"
    n = 1
    while os.path.exists(os.path.join(out_dir, f"{base}_{n}.mp4")):
        n += 1
    return f"{base}_{n}.mp4"


def _close(port: int, chat_url: str, video: str):
    try:
        _run_node("close_scene_cdp.mjs", [port, chat_url, video], timeout=60)
    except Exception:
        pass


def _close_failed(port: int):
    # 任何失败场景：无条件关闭 CDP 浏览器（避免 Edge/profile 残留）
    try:
        _run_node("close_any.mjs", [port], timeout=30)
    except Exception:
        pass


def _wait_acceptance(port: int, initial_tail: str, timeout: float = 60):
    """发送后轮询观察，直到出现明确受理/拒绝文案（Dola 受理确认有延迟）。"""
    tail = initial_tail or ""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        outcome = classify(tail)
        if outcome != "sent_outcome_unknown":
            return outcome, tail
        try:
            obs = _observe(port)
            tail = (obs.get("tail") or "")[-2000:]
        except Exception:
            pass
        time.sleep(3)
    return "sent_outcome_unknown", tail


# 未登录/需同意 Cookie 等特征：这类不视为失败、不占重试额度，直接换号重试
_LOGGED_OUT_MARKERS = ("Cookie", "请确认并同意", "确认并同意", "登录即代表", "注册 登录",
                       "同意并继续", "使用 Cookie 与类似技术", "请同意", "同意使用我们的")


def _looks_logged_out(tail: str) -> bool:
    t = tail or ""
    return any(m in t for m in _LOGGED_OUT_MARKERS)


# 连续未登录达到该上限即停止整个任务生成（仅针对未登录情况）
_LOGGED_OUT_LIMIT = 10


# ---------------------------------------------------------------- 长效收片记录
# 提交成功(accepted_generating)的分镜立即入队，收片(等出片/下载/归档)走独立线程，
# 记录持久化到磁盘，后端重启/刷新页面后也能恢复，避免切换剧本丢失在途视频。
PENDING_PATH = STATE / "pending_shots.json"


def _load_pending() -> list:
    try:
        if PENDING_PATH.exists():
            data = json.loads(PENDING_PATH.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
    except Exception:
        pass
    return []


def _save_pending(recs: list):
    try:
        STATE.mkdir(parents=True, exist_ok=True)
        PENDING_PATH.write_text(json.dumps(recs, ensure_ascii=False, indent=2),
                                encoding="utf-8")
    except Exception:
        pass


def _upsert_pending(rec) -> list:
    recs = _load_pending()
    for i, r in enumerate(recs):
        if r.get("run_id") == rec.get("run_id") and r.get("scene_no") == rec.get("scene_no"):
            recs[i] = rec
            break
    else:
        recs.append(rec)
    _save_pending(recs)
    return recs


_REJECT_MARKERS = (
    "未认证人脸", "额度不足", "生成失败", "出了点问题", "肖像", "版权", "侵权",
    "涉嫌违规", "违规内容", "无法生成", "内容不合规", "审核未通过", "被驳回",
    "额度未扣除", "服务繁忙",
)
_WAIT_POLL = 1200  # 无水印收片失败后的二次嗅探间隔（秒）：20 分钟
_DETECT_POLL = 30  # 主循环检测出片轮询间隔（秒）：视频生成完成即及时收到，避免等满 20 分钟


def _collect_pending(rec, cancel_ev=None):
    """收片：无限等待出片→下载→归档→更新长效记录。
    收片时长不限、窗口保留；只要未出现明确失败文案（肖像/错误/版权/违规等）都不视为失败、不重试。
    未出片（仍在生成）持续等待；「无水印失败已下载原片」后每 20 分钟再嗅探一次无水印，成功则下载并置完成。
    独立线程可复用（含后端重启恢复）。
    """
    port = rec.get("port")
    chat_url = rec.get("chat_url") or ""
    account_email = rec.get("account")
    scene_no = rec.get("scene_no")
    series = rec.get("series") or ""
    out_dir = rec.get("output_dir") or "."
    os.makedirs(out_dir, exist_ok=True)
    try:
        if rec.get("status") == "original":
            _retry_watermark(rec, port, chat_url, cancel_ev)
            return rec
        while True:
            if cancel_ev and cancel_ev.is_set():
                rec["status"] = "cancelled"
                try:
                    _close_failed(port)
                except Exception:
                    pass
                _upsert_pending(rec)
                return rec
            if not _window_alive(port):
                # 窗口被手动关闭：任务暂停、账号临时冻结，等待用户在收片记录重开窗口
                rec["status"] = "window_closed"
                rec["error"] = "窗口被手动关闭，任务已暂停，账号已临时冻结，可在收片记录重新打开窗口"
                try:
                    _close_failed(port)
                except Exception:
                    pass
                if account_email:
                    pool.set_status(account_email, "frozen", "窗口被手动关闭")
                _upsert_pending(rec)
                return rec
            try:
                obs = _observe(port)
            except Exception as e:
                if not _window_alive(port):
                    rec["status"] = "window_closed"
                    rec["error"] = "窗口被手动关闭，任务已暂停，账号已临时冻结，可在收片记录重新打开窗口"
                    try:
                        _close_failed(port)
                    except Exception:
                        pass
                    if account_email:
                        pool.set_status(account_email, "frozen", "窗口被手动关闭")
                    _upsert_pending(rec)
                    return rec
                obs = {"tail": "", "videoCards": 0, "error": str(e)[:100]}
            tail = obs.get("tail", "") or ""
            if any(t in tail for t in _REJECT_MARKERS):
                rec["status"] = "rejected"
                rec["error"] = "收片被拒绝（肖像/版权/违规等）：" + tail[-200:]
                try:
                    _close_failed(port)
                except Exception:
                    pass
                if account_email:
                    pool.delete_account(account_email)
                _upsert_pending(rec)
                return rec
            if classify(tail) == "no_30s":
                rec["status"] = "no_30s"
                rec["error"] = "收片时账号无30s能力"
                try:
                    _close_failed(port)
                except Exception:
                    pass
                if account_email:
                    pool.delete_account(account_email)
                _upsert_pending(rec)
                return rec
            if obs.get("videoCards", 0) > 0 or "你的视频生成好了" in tail:
                return _try_collect(rec, port, chat_url, cancel_ev)
            time.sleep(_DETECT_POLL)
    except Exception as e:
        try:
            _close_failed(port)
        except Exception:
            pass
        rec["status"] = "error"
        rec["error"] = "收片异常 " + str(e)[:200]
    _upsert_pending(rec)
    return rec


def _try_collect(rec, port, chat_url, cancel_ev):
    """有成片：优先无水印下载→done；无水印失败→下载原片(original)→周期再嗅探无水印。"""
    scene_no = rec.get("scene_no")
    series = rec.get("series") or ""
    out_dir = rec.get("output_dir") or "."
    dest = os.path.join(out_dir, _video_name(out_dir, series, scene_no))
    try:
        dl = _download(port, dest, chat_url)
        rec["path"] = dl.get("file")
        rec["verify"] = {"bytes": dl.get("bytes"), "duration": dl.get("duration_seconds"),
                         "sha256": dl.get("sha256")}
        try:
            _close(port, chat_url, dest)
        except Exception:
            _close_failed(port)
        rec["status"] = "done"
        rec["error"] = None
        if rec.get("account"):
            pool.set_status(rec["account"], "generated", "ok", series=series, scene=str(scene_no))
        _upsert_pending(rec)
    except Exception as dl_e:
        try:
            orig = os.path.join(out_dir, _video_name_original(out_dir, series, scene_no))
            odl = _download_original(port, orig, chat_url)
            rec["path"] = odl.get("file")
            rec["status"] = "original"
            rec["error"] = "无水印收片失败，已下载原片待查看：" + str(dl_e)[:120]
            _upsert_pending(rec)
            _retry_watermark(rec, port, chat_url, cancel_ev)
        except Exception as oe:
            rec["status"] = "keep_window"
            rec["error"] = "有视频但无水印/原片收片均失败，窗口已保留待查看：" + str(dl_e)[:120] + " / " + str(oe)[:100]
            _upsert_pending(rec)
    return rec


def _retry_watermark(rec, port, chat_url, cancel_ev):
    """「无水印失败已下载原片」后：每 20 分钟嗅探一次无水印，嗅探到则下载并置完成。"""
    scene_no = rec.get("scene_no")
    series = rec.get("series") or ""
    out_dir = rec.get("output_dir") or "."
    while True:
        if cancel_ev and cancel_ev.is_set():
            rec["status"] = "cancelled"
            try:
                _close_failed(port)
            except Exception:
                pass
            _upsert_pending(rec)
            return
        time.sleep(_WAIT_POLL)
        try:
            dest = os.path.join(out_dir, _video_name(out_dir, series, scene_no))
            dl = _download(port, dest, chat_url)
            rec["path"] = dl.get("file")
            rec["verify"] = {"bytes": dl.get("bytes"), "duration": dl.get("duration_seconds"),
                             "sha256": dl.get("sha256")}
            try:
                _close(port, chat_url, dest)
            except Exception:
                _close_failed(port)
            rec["status"] = "done"
            rec["error"] = None
            if rec.get("account"):
                pool.set_status(rec["account"], "generated", "ok", series=series, scene=str(scene_no))
            _upsert_pending(rec)
            return
        except Exception:
            continue  # 仍嗅探不到无水印：继续每 20 分钟重试


def resume_pending():
    """后端启动/刷新后恢复未完成收片（在途实例仍在 Dola 后台生成）。"""
    started = 0
    for rec in _load_pending():
        if rec.get("status") in ("pending", "unknown", "original"):
            threading.Thread(target=_collect_pending, args=(rec,), daemon=True).start()
            started += 1
    return started


def list_pending():
    """返回全部长效收片记录（含历史，前端可查看）。"""
    return _load_pending()


def manual_collect(run_id: str, scene_no):
    """手动收片：对某条收片记录重新触发「检查成片→下载→归档」。
    用于视频已在 Dola 后台生成但自动收片未及时触发的场景。"""
    rec = None
    for r in _load_pending():
        if r.get("run_id") == run_id and r.get("scene_no") == scene_no:
            rec = r
            break
    if not rec:
        return {"ok": False, "msg": "未找到该镜头的收片记录"}
    cur = rec.get("status")
    if cur == "done":
        return {"ok": False, "msg": "该镜头已收片完成"}
    if cur == "cancelled":
        return {"ok": False, "msg": "该镜头已取消，无法收片"}
    rec["status"] = "pending"
    rec["error"] = None
    threading.Thread(target=_collect_pending, args=(rec,), daemon=True).start()
    return {"ok": True, "msg": f"已对镜头{scene_no}触发手动收片（原状态 {cur}），请稍后在收片记录查看"}


def reopen_window(run_id: str, scene_no):
    """收片记录里重新打开已关闭窗口（同一账号），并恢复该镜头收片（检测/收片）。
    适用于窗口被手动关闭后（状态 window_closed）的恢复。"""
    rec = None
    for r in _load_pending():
        if r.get("run_id") == run_id and r.get("scene_no") == scene_no:
            rec = r
            break
    if not rec:
        return {"ok": False, "msg": "未找到该镜头的收片记录"}
    email = rec.get("account")
    if not email:
        return {"ok": False, "msg": "该记录缺少账号"}
    account = pool.load_account(email)
    if not account:
        return {"ok": False, "msg": "账号凭据不存在，无法重开"}
    profile_key = rec.get("profile_key") or f"reopen_{run_id}_{scene_no}_{int(time.time())}"
    proxy = account.get("proxy") or "http://127.0.0.1:7897"
    params = {"proxy": proxy, "visible": True}
    try:
        b = _launch_browser(account, params, profile_key, chat_url=rec.get("chat_url") or "")
    except Exception as e:
        return {"ok": False, "msg": "重开窗口失败：" + str(e)[:120]}
    port = int(b.get("port") or 0)
    login = b.get("login_state")
    if login != "ok":
        try:
            obs = _observe(port)
            ptext = obs.get("tail", "") or ""
            if any(k in ptext for k in ("登录以解锁更多功能", "Google 登录", "登录即代表你同意", "注册 登录")):
                login = "needs_review"
        except Exception:
            pass
    if login in ("logged_out", "needs_review") or not b.get("extension_loaded"):
        try:
            _close_failed(port)
        except Exception:
            pass
        return {"ok": False, "msg": f"重开窗口后未正常登录（{login}），已关闭，请换号或手动确认"}
    rec["port"] = port
    rec["chat_url"] = b.get("url") or rec.get("chat_url") or ""
    rec["status"] = "pending"
    rec["error"] = None
    _upsert_pending(rec)
    # 解冻账号（窗口被关时的临时冻结 → 恢复），继续用于该镜头收片
    try:
        pool.set_status(email, "registered", "重开窗口恢复收片")
    except Exception:
        pass
    threading.Thread(target=_collect_pending, args=(rec,), daemon=True).start()
    return {"ok": True, "msg": f"已用同一账号重开窗口并恢复镜头{scene_no}收片，请稍候查看"}


def delete_pending(run_id: str, scene_no):
    """手动删除收片记录：关闭对应窗口并清除该账号（含临时冻结/已归档）。"""
    recs = _load_pending()
    target = None
    for r in recs:
        if r.get("run_id") == run_id and r.get("scene_no") == scene_no:
            target = r
            break
    if not target:
        return {"ok": False, "msg": "未找到该镜头的收片记录"}
    email = target.get("account")
    port = target.get("port")
    try:
        if port:
            _close_failed(port)
    except Exception:
        pass
    if email:
        try:
            pool.delete_account(email)
        except Exception:
            pass
    new = [r for r in recs if not (r.get("run_id") == run_id and r.get("scene_no") == scene_no)]
    _save_pending(new)
    return {"ok": True, "msg": f"已删除收片记录并清除账号 {email}"}


# ---------------------------------------------------------------- 批量调度
_PLACEHOLDER = ROOT / "assets" / "placeholder.png"
_RETRY_MAX = 5


def _preopen(params: dict, proxy: str):
    """提前取号+开窗+登录，返回就绪窗口 {account,port,profile_key,chat_url}；失败返回 None（内部清理）。"""
    account = None
    try:
        account = pool.take_available()
        if not account:
            return None
        profile_key = f"preopen_{int(time.time())}_{os.urandom(3).hex()}"
        b = _launch_browser(account, params, profile_key)
        port = int(b.get("port") or 0)
        login = b.get("login_state")
        if login != "ok":
            try:
                obs = _observe(port)
                ptext = obs.get("tail", "") or ""
                if any(k in ptext for k in ("登录以解锁更多功能", "Google 登录", "登录即代表你同意", "注册 登录")):
                    login = "needs_review"
            except Exception:
                pass
        if login in ("logged_out", "needs_review") or not b.get("extension_loaded"):
            _close_failed(port)
            pool.delete_account(account["email"])
            return None
        return {"account": account, "port": port, "profile_key": profile_key,
                "chat_url": b.get("url") or ""}
    except Exception:
        if account and account.get("email"):
            try:
                pool.delete_account(account["email"])
            except Exception:
                pass
        return None



def _process_shot(run_id: str, shot: dict, assets: list, out_dir: str,
                  params: dict, ledger: dict, ledger_lock, shot_index: int,
                  cancel_ev=None, preopened=None) -> dict:
    result = {
        "idx": shot_index,
        "scene_no": shot.get("scene_no") or shot_index + 1,
        "title": shot.get("title") or f"分镜{shot_index + 1}",
        "status": "pending", "instance": None, "attempt": 0,
        "chat_url": None, "path": None, "error": None,
        "acceptance": None, "verify": None,
    }
    proxy = params.get("proxy") or "http://127.0.0.1:7897"
    # 资产保序：空位（未匹配到文件）填透明占位图，保证图片上传顺序不错乱
    seq = [str(_PLACEHOLDER) if not a else a for a in (assets or [])]
    attempts_used = 0
    last_err = ""
    attempt_log = SCENES / f"{run_id}_{result['scene_no']}_attempts.log"

    def _note(msg):
        try:
            with open(attempt_log, "a", encoding="utf-8") as _f:
                _f.write(f"[a{attempts_used + 1}] {msg}\n")
        except Exception:
            pass

    def _set_step(step, instance=""):
        try:
            with ledger_lock:
                ledger["current"] = {"scene_no": result["scene_no"], "step": step,
                                     "instance": instance or result.get("instance") or ""}
                _p = RUNS / f"{run_id}.json"
                _p.write_text(json.dumps(ledger, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    def _cancelled():
        return bool(cancel_ev and cancel_ev.is_set())

    def _no_30s():
        # 账号无法使用30秒2.5（仅10秒）：关闭重开、换号，不占用内容重试额度
        result["status"] = "no_30s"
        result["error"] = "账号无法使用30秒2.5（仅10秒），已关闭重开换号"

    def _reset_logged_out():
        # 非未登录情况（成功提交/被拒/服务错误/无30s/异常）中断"连续未登录"计数
        with ledger_lock:
            if ledger.get("logged_out_streak"):
                ledger["logged_out_streak"] = 0
                _p = RUNS / f"{run_id}.json"
                _p.write_text(json.dumps(ledger, ensure_ascii=False, indent=2), encoding="utf-8")

    if _cancelled():
        result["status"] = "cancelled"
        return result

    while attempts_used < _RETRY_MAX:
        if _cancelled():
            result["status"] = "cancelled"
            return result
        # 每次尝试清理该镜提交标记：失败/掉线后换号重试需允许重新提交（否则 submit 拒重发，重试死循环）
        _mk = SCENES / f"{run_id}_{result['scene_no']}.submission.json"
        try:
            if _mk.exists():
                _mk.unlink()
        except Exception:
            pass
        # 预开窗口：若已就绪，跳过取号/开窗/登录，直接用
        if preopened and preopened.get("port"):
            account = preopened["account"]
            result["instance"] = account["email"]
            result["attempt"] = attempts_used + 1
            port = preopened["port"]
            chat_url = preopened.get("chat_url") or ""
            profile_key = preopened["profile_key"]
            pool.record_instance(account["email"], "", port, proxy, chat_url, "preopened")
            _set_step("预开窗口就绪，开始填充")
            preopened = None
        else:
            # 取号：号池不足时等待后台补池线程补充（最长10分钟），避免号池0直接判失败
            account = None
            wait_deadline = time.monotonic() + 600
            while True:
                if _cancelled():
                    result["status"] = "cancelled"
                    return result
                account = pool.take_available()
                if account:
                    break
                if time.monotonic() > wait_deadline:
                    break
                time.sleep(5)
            if not account:
                _note("取号等待超时(号池未补上)")
                if attempts_used == 0:
                    result["status"] = "gate_failed"
                    result["error"] = "号池没有可用账号（等待后台补池超时）"
                    return result
                break
            result["instance"] = account["email"]
            result["attempt"] = attempts_used + 1
            port = None
            chat_url = ""
            profile_key = f"{run_id}_{result['scene_no']}_t{attempts_used}_{int(time.time()*1000)}_{os.urandom(2).hex()}"
            _set_step("启动浏览器", account["email"])
            try:
                b = _launch_browser(account, params, profile_key)
                port = int(b.get("port") or 0)
                login = b.get("login_state")
                # 二次观察：仅当 browser.mjs 未确认登录成功(ok)才复核，避免聊天页偶发"登录"字样误判掉线
                if login != "ok":
                    try:
                        obs = _observe(port)
                        ptext = obs.get("tail", "") or ""
                        if any(k in ptext for k in ("登录以解锁更多功能", "Google 登录", "登录即代表你同意", "注册 登录")):
                            login = "needs_review"
                    except Exception:
                        pass
                if login in ("logged_out", "needs_review"):
                    _close_failed(port)
                    port = None
                    pool.delete_account(account["email"])  # 登录态不行，号丢弃
                    last_err = f"账号 {account['email']} 未登录（{login}）"
                    _note(f"未登录({login})，账号已丢弃，不占失败次数")
                    # 未登录不视为失败：不核算 attempts，直接换新号继续执行
                    continue
                if not b.get("extension_loaded"):
                    _close_failed(port)
                    port = None
                    pool.delete_account(account["email"])  # 扩展未就绪，号丢弃换新
                    last_err = "哆啦助手扩展未就绪"
                    _note("扩展未就绪，账号已丢弃")
                    attempts_used += 1
                    continue
                chat_url = b.get("url") or ""
                pool.record_instance(account["email"], str(b.get("profile") or ""),
                                     port, proxy, chat_url, "open")
                _set_step("登录成功，进入视频模式")
            except Exception as e:
                if port:
                    try:
                        _close_failed(port)
                    except Exception:
                        pass
                    port = None
                pool.delete_account(account["email"])  # 启动失败，号丢弃
                last_err = f"账号 {account['email']} 启动失败：{str(e)[:160]}"
                _note("启动失败 " + str(e)[:120])
                attempts_used += 1
                continue
        try:
            if _cancelled():
                _close_failed(port)
                pool.delete_account(account["email"])
                result["status"] = "cancelled"
                return result
            manifest = _write_manifest(run_id, shot, seq)
            _set_step("填充提示词与资产")
            _fill(port, manifest)
            if _cancelled():
                _close_failed(port)
                pool.delete_account(account["email"])
                result["status"] = "cancelled"
                return result
            _set_step("提交分镜")
            sub = _submit(port, manifest)
            obs = (sub.get("observation") or {}).get("text", "") or ""
            outcome, tail = _wait_acceptance(port, obs[-2000:])
            result["acceptance"] = outcome
            if outcome == "no_30s":
                _close_failed(port)
                port = None
                pool.delete_account(account["email"])  # 无30s能力，号丢弃
                _no_30s()
                _reset_logged_out()
                _note("no_30s(受理文案) " + tail[-80:])
                last_err = result["error"]
                continue  # 不占额度
            if outcome == "accepted_generating":
                # 提交确认即通过：立即返回，窗口保留在后台等出片，worker 继续提交下一个分镜，不阻塞
                _reset_logged_out()
                result["status"] = "pending_submit"
                result["port"] = port
                result["chat_url"] = chat_url
                result["account"] = account["email"]
                result["profile_key"] = profile_key
                result["error"] = None
                _set_step("已提交，等待出片")
                _note("已提交(accepted_generating)，后台等出片 " + tail[-120:])
                # 写入长效收片记录：切换剧本/刷新/重启后仍能恢复收片
                _upsert_pending({
                    "run_id": run_id, "scene_no": result["scene_no"],
                    "title": result.get("title") or "",
                    "account": account["email"], "port": port, "chat_url": chat_url,
                    "profile_key": profile_key, "series": params.get("series") or "",
                    "output_dir": out_dir, "status": "pending",
                    "submitted_at": _now(), "path": None, "error": None,
                })
                return result
            else:
                _close_failed(port)
                port = None
                pool.delete_account(account["email"])  # 失败（含肖像/版权等），号丢弃
                _reset_logged_out()
                if outcome == "rejected":
                    result["status"] = "rejected"
                    result["error"] = "被拒绝（肖像/版权等）：" + tail[-160:]
                elif outcome == "service_error":
                    result["status"] = "service_error"
                    result["error"] = "平台服务错误：" + tail[-160:]
                else:
                    if _looks_logged_out(tail):
                        # 未登录/需同意Cookie：不占失败次数，直接换号重试（符合既定规则）
                        # 连续累计：达到上限即停止整个任务生成并告知前端弹窗
                        with ledger_lock:
                            ledger["logged_out_streak"] = ledger.get("logged_out_streak", 0) + 1
                            if ledger["logged_out_streak"] >= _LOGGED_OUT_LIMIT:
                                ledger["logged_out_stop"] = True
                                ledger["stop_reason"] = ("连续 %d 条未登录，已停止本任务生成"
                                                         % _LOGGED_OUT_LIMIT)
                            _p = RUNS / f"{run_id}.json"
                            _p.write_text(json.dumps(ledger, ensure_ascii=False, indent=2),
                                          encoding="utf-8")
                        if ledger.get("logged_out_stop"):
                            if cancel_ev:
                                cancel_ev.set()
                            result["status"] = "loggedout_stop"
                            result["error"] = ledger.get("stop_reason", "连续未登录过多，已停止")
                            return result
                        _note("未登录(需同意Cookie) 换号重试 " + tail[-80:])
                        last_err = None
                        continue
                    result["status"] = "unknown"
                    result["error"] = "受理结果未知：" + tail[-160:]
                _note(outcome + " " + tail[-120:])
                last_err = result["error"]
                attempts_used += 1
                continue
        except Exception as e:
            msg = str(e)
            if "duration30" in msg:  # 账号无30s能力（门禁检测，仅10秒）
                if port:
                    try:
                        _close_failed(port)
                    except Exception:
                        pass
                    port = None
                pool.delete_account(account["email"])
                _no_30s()
                _note("no_30s(门禁duration30) " + msg[:120])
                last_err = result["error"]
                continue  # 不占额度
            if port:
                try:
                    _close_failed(port)
                except Exception:
                    pass
                port = None
            pool.delete_account(account["email"])  # 生成异常，号丢弃
            _reset_logged_out()
            result["status"] = "error"
            result["error"] = str(e)[:300]
            _note("异常 " + str(e)[:150])
            last_err = result["error"]
            attempts_used += 1
            continue
    # 重试耗尽
    result["status"] = result.get("status") or "error"
    result["error"] = result.get("error") or (last_err or f"重试 {_RETRY_MAX} 次均失败")
    return result


def _pool_watcher(cancel_ev):
    """后台补池守护：任务运行期间可用号 <5 即持续注册到上限，保证消耗不断供。"""
    proxy = "http://127.0.0.1:7897"
    while not cancel_ev.is_set():
        try:
            st = pool.stats()
            if st["usable"] < pool.POOL_MIN:
                fails = 0
                while not cancel_ev.is_set():
                    if pool.stats()["usable"] >= pool.POOL_MAX:
                        break
                    try:
                        pool.register(proxy=proxy)
                        fails = 0
                    except Exception:
                        fails += 1
                        if fails >= 4:
                            break  # 补池失败，等下一轮
                        time.sleep(3)
                    time.sleep(2)
        except Exception:
            pass
        time.sleep(8)


def _worker(run_id: str, shots: list, output_dir: str, params: dict, cancel_ev=None):
    ledger = {"run_id": run_id, "started_at": _now(), "status": "running",
              "output_dir": output_dir, "params": params, "shots": []}
    RUNS.mkdir(parents=True, exist_ok=True)
    path = RUNS / f"{run_id}.json"
    path.write_text(json.dumps(ledger, ensure_ascii=False, indent=2), encoding="utf-8")
    ledger_lock = threading.Lock()

    def _set_step(scene_no, step, instance=""):
        with ledger_lock:
            ledger["current"] = {"scene_no": scene_no, "step": step, "instance": instance}
            path.write_text(json.dumps(ledger, ensure_ascii=False, indent=2), encoding="utf-8")

    def _run_one(idx: int, shot: dict, preopened=None):
        assets = shot.get("assets") or []   # 保留空位（未匹配资产槽），_process_shot 内填占位图保序
        res = _process_shot(run_id, shot, assets, output_dir, params, ledger, ledger_lock, idx, cancel_ev, preopened=preopened)
        with ledger_lock:
            ledger["shots"].append(res)
            ledger.pop("current", None)
            path.write_text(json.dumps(ledger, ensure_ascii=False, indent=2), encoding="utf-8")
        return res

    try:
        # 提交阶段（串行）：逐个分镜，提交确认(accepted_generating)即通过，立即继续下一个，不等出片
        pending = []
        preopen_state = {"info": None, "ready": False, "obsolete": False, "lock": threading.Lock()}

        def _start_preopen():
            with preopen_state["lock"]:
                preopen_state["info"] = None
                preopen_state["ready"] = False
                preopen_state["obsolete"] = False

            def _work():
                try:
                    info = _preopen(params, params.get("proxy") or "http://127.0.0.1:7897")
                except Exception:
                    info = None
                with preopen_state["lock"]:
                    if preopen_state.get("obsolete"):
                        # 该预开窗口已作废（当前分镜已正常开窗提交）：关闭并释放账号，避免多余实例
                        if info and info.get("port"):
                            try:
                                _close_failed(info["port"])
                            except Exception:
                                pass
                            acc = info.get("account")
                            if acc and acc.get("email"):
                                try:
                                    pool.release_available(acc["email"])
                                except Exception:
                                    pass
                        preopen_state["info"] = None
                        preopen_state["ready"] = False
                    else:
                        preopen_state["info"] = info
                        preopen_state["ready"] = True

            threading.Thread(target=_work, daemon=True).start()

        for idx, shot in enumerate(shots):
            if cancel_ev and cancel_ev.is_set():
                break
            # 取预开窗口（已就绪则用；未就绪/失败则正常自开窗，不阻塞主流程）
            pre = None
            with preopen_state["lock"]:
                if preopen_state["ready"]:
                    pre = preopen_state["info"]
                    preopen_state["ready"] = False
                    preopen_state["info"] = None
                    preopen_state["obsolete"] = False
                else:
                    # 上轮预开未就绪：当前分镜将正常开窗，标记该预开作废（就绪后关闭释放）
                    preopen_state["obsolete"] = True
            res = _run_one(idx, shot, pre)
            if res.get("status") == "pending_submit":
                pending.append(res)
            # 提交当前后，后台预开下一个窗口登录好，供下个分镜提交时直接使用
            if idx < len(shots) - 1 and not (cancel_ev and cancel_ev.is_set()):
                _start_preopen()
        # 收片阶段：全部提交完后，并发等待各分镜出片并下载归档；失败(拒绝/未成片/异常)自动换号重提交，最多重试
        if pending and not (cancel_ev and cancel_ev.is_set()):
            def _collect_with_retry(r, shot):
                assets = shot.get("assets") or []
                idx = r.get("idx") or 0

                def _make_rec(res):
                    return {
                        "run_id": run_id, "scene_no": res.get("scene_no"),
                        "title": res.get("title") or "",
                        "account": res.get("account"), "port": res.get("port"),
                        "chat_url": res.get("chat_url") or "",
                        "profile_key": res.get("profile_key"),
                        "series": params.get("series") or "",
                        "output_dir": output_dir, "status": "pending",
                        "path": None, "error": None,
                    }

                rec = _make_rec(r)
                for attempt in range(_RETRY_MAX):
                    _collect_pending(rec, cancel_ev)
                    if rec.get("status") in ("done", "cancelled", "original", "keep_window"):
                        break
                    if cancel_ev and cancel_ev.is_set():
                        break
                    if attempt < _RETRY_MAX - 1:
                        # 失败（拒绝/未成片/异常）：换号重新提交该分镜（提交阶段逻辑），再收片
                        res = _process_shot(run_id, shot, assets, output_dir, params,
                                            ledger, ledger_lock, idx, cancel_ev)
                        if res.get("status") != "pending_submit":
                            rec.update({"status": res.get("status"), "error": res.get("error")})
                            break
                        rec = _make_rec(res)
                r.update({"status": rec.get("status"), "path": rec.get("path"),
                          "error": rec.get("error"), "verify": rec.get("verify")})
                with ledger_lock:
                    path.write_text(json.dumps(ledger, ensure_ascii=False, indent=2),
                                    encoding="utf-8")

            threads = []
            for r in pending:
                idx = r.get("idx") or 0
                shot = shots[idx] if idx < len(shots) else {}
                t = threading.Thread(target=_collect_with_retry, args=(r, shot), daemon=True)
                t.start()
                threads.append(t)
            for t in threads:
                t.join()
        if ledger.get("logged_out_stop"):
            ledger["status"] = "stopped_loggedout"
        else:
            ledger["status"] = "cancelled" if (cancel_ev and cancel_ev.is_set()) else "complete"
    except Exception as e:
        ledger["status"] = "error"
        ledger["error"] = str(e)[:300]
    finally:
        ledger["finished_at"] = _now()
        path.write_text(json.dumps(ledger, ensure_ascii=False, indent=2), encoding="utf-8")
        if cancel_ev:
            cancel_ev.set()  # 停止后台补池守护
        _ACTIVE.pop(run_id, None)


_ACTIVE: dict = {}  # run_id -> threading.Event（取消信号）


def start_batch(shots: list, output_dir: str, params: dict | None = None) -> dict:
    params = params or {}
    run_id = f"{int(time.time())}_{os.urandom(3).hex()}"
    if not shots:
        return {"ok": False, "error": "没有分镜"}
    os.makedirs(output_dir, exist_ok=True)
    cancel_ev = threading.Event()
    _ACTIVE[run_id] = cancel_ev
    threading.Thread(target=_pool_watcher, args=(cancel_ev,), daemon=True).start()
    thread = threading.Thread(target=_worker, args=(run_id, shots, output_dir, params, cancel_ev), daemon=True)
    thread.start()
    return {"ok": True, "run_id": run_id, "shots": len(shots)}


def get_status(run_id: str) -> dict:
    path = RUNS / f"{run_id}.json"
    if not path.exists():
        return {"ok": False, "error": "任务不存在"}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, **data}


def cancel(run_id: str) -> dict:
    # 触发取消事件：正在跑的镜会在最近检查点停止并关闭浏览器；未开始的镜不再取号。
    ev = _ACTIVE.get(run_id)
    if ev:
        ev.set()
    path = RUNS / f"{run_id}.json"
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            data["status"] = "cancelled"
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass
    return {"ok": True}
