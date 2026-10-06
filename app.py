# -*- coding: utf-8 -*-
"""
提示词管理器 - 本地文件服务
双击「启动提示词管理器.bat」运行，浏览器自动打开。
左侧树状浏览本地文件夹，右侧查看/编辑提示词文件，自动识别分镜，可一键复制、保存覆盖原文件。
"""
import os
import re
import sys
import json
import string
import socket
import webbrowser
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import bridge  # 豆啦啦浏览器批量生成桥接（本目录 bridge.py）
import asset  # 资产关联模块（本目录 asset.py）

# 独立号池 + CDP 生成引擎（dola_engine/）
_DOLA_ENGINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dola_engine")
sys.path.insert(0, _DOLA_ENGINE)
import pool as dola_pool   # 号池：SQLite + DPAPI
import engine as dola_engine  # CDP 生成引擎

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
INDEX_HTML = os.path.join(WEB_DIR, "index.html")
ADDED_FILE = os.path.join(BASE_DIR, "added_items.json")  # 左侧“已添加”列表的持久化记录
BAD_FILE = os.path.join(BASE_DIR, "bad_instances.json")   # “号废了”实例黑名单持久化记录

# 常用文本扩展名（树里默认只显示这些；可在界面勾选“显示所有文件”）
TEXT_EXTS = {
    ".txt", ".md", ".markdown", ".text", ".log", ".srt", ".ass", ".ssa",
    ".json", ".xml", ".csv", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".py", ".pyw", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".css", ".html", ".htm",
    ".sh", ".bat", ".cmd", ".ps1", ".sql", ".java", ".c", ".h", ".cpp", ".hpp",
    ".go", ".rs", ".rb", ".php", ".vue", ".svelte",
}

DEFAULT_PORT = 8848


# ---------------------------------------------------------------- 文本解码 / 编码
def decode_text(raw: bytes):
    """返回 (文本, 编码名)。优先 UTF-8，兼容 GBK 等中文编码，自动识别 BOM。"""
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig"), "utf-8-sig"
    for enc in ("utf-8", "gb18030", "gbk", "latin-1"):
        try:
            return raw.decode(enc), enc
        except Exception:
            continue
    return raw.decode("utf-8", "replace"), "utf-8"


def encode_text(text: str, enc: str) -> bytes:
    """按原编码写回，保留 BOM。"""
    if enc == "utf-8-sig":
        return b"\xef\xbb\xbf" + text.encode("utf-8")
    if enc in ("gb18030", "gbk"):
        return text.encode(enc, errors="replace")
    return text.encode("utf-8")


def read_text(path: str):
    """读取文件，返回 (规范化文本(\\n 换行), 编码, 原换行符)。"""
    with open(path, "rb") as f:
        raw = f.read()
    if b"\x00" in raw:
        raise ValueError("二进制文件，无法作为文本打开")
    text, enc = decode_text(raw)
    nl = "\r\n" if "\r\n" in text else ("\r" if "\r" in text else "\n")
    norm = text.replace("\r\n", "\n").replace("\r", "\n")
    return norm, enc, nl


def write_text(path: str, content: str, enc: str = "utf-8", nl: str = "\n"):
    text = content.replace("\r\n", "\n").replace("\r", "\n")
    if nl == "\r\n":
        text = text.replace("\n", "\r\n")
    data = encode_text(text, enc)
    with open(path, "wb") as f:
        f.write(data)


# ---------------------------------------------------------------- 分镜识别
_MARKER_RE = re.compile(
    r"^\s*(?:分镜|镜头号|镜号|镜头|SHOT|SC)\s*"
    r"(?:[\d一二三四五六七八九十百]+\s*[：:、.．]?|[：:、.．])",
    re.I,
)
_ORD_RE = re.compile(r"^\s*第\s*[\d一二三四五六七八九十百]+\s*(?:镜|分镜|镜头|场景)\s*[：:、.．]?\s*")
_NUMBERED_RE = re.compile(r"^\s*\d{1,3}\s*[、.．）)\]]\s*")
_BRACKET_RE = re.compile(r"^\s*[【\[]\s*(?:分镜|镜头|镜号|景别|场景|第)[^】\]]{0,20}[】\]]")


def _is_marker(line: str) -> bool:
    if len(line) > 90:
        return False
    s = line.strip()
    if not s:
        return False
    return bool(_MARKER_RE.match(s) or _ORD_RE.match(s)
                or _BRACKET_RE.match(s) or _NUMBERED_RE.match(s))


# ---- 标准规则2：###镜头n 分镜结构 ----
# 以 ### 镜头n 为分镜开始，到下一个 ### 镜头n 结束；正文从表头后的首行（通常为【直接生成控制】）到下一个表头前，
# 跳过段尾的 --- 与空行。仅取含正文实体的分镜（跳过目录里的纯表头行）。
_SHOT_RE = re.compile(r"^\s*#{1,4}\s*镜头\s*([\d一二三四五六七八九十百]+)")
_SHOT_BODY_MARKERS = ("【直接生成控制】", "时间轴细分", "镜头设计", "三层构图",
                       "声音设计", "角色映射", "场景映射", "初始站位", "画风")


def _parse_shot_structure(lines):
    """命中 ###镜头n 结构时返回 (segments, 'shot')，否则返回 None。"""
    header_idx = [i for i, l in enumerate(lines) if _SHOT_RE.match(l)]
    if not header_idx:
        return None
    segs = []
    for k, h in enumerate(header_idx):
        nxt = header_idx[k + 1] if k + 1 < len(header_idx) else len(lines)
        start = h + 1
        while start < nxt and not lines[start].strip():
            start += 1
        end = nxt
        while end > start and (not lines[end - 1].strip() or lines[end - 1].strip() == "---"):
            end -= 1
        if start >= end:
            continue  # 纯表头（如目录行），不算分镜
        content = "\n".join(lines[start:end]).rstrip("\n")
        n_lines = end - start
        has_body = any(m in content for m in _SHOT_BODY_MARKERS)
        if content.strip() and (has_body or n_lines >= 3):
            num = _SHOT_RE.match(lines[h]).group(1)
            segs.append({"text": content, "start": start, "end": end, "num": num})
    if segs:
        return segs, "shot"
    return None


def parse_segments(text: str):
    """
    返回 (segments, mode)
      segments: [{'text': 段落文本, 'start': 起始行号, 'end': 内容结束行号(不含尾随空行/---), 'num'?: 镜头号}]
      mode:     'shot'（###镜头n 分镜）| 'marker'（分镜/镜头/编号/【】标识）
                | 'block'（空行分隔）| 'single'（整篇一段）
    混合格式自动兼容。保存时按行区间重建，可精确保留段落间的空白/分隔线。
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        return [], "single"
    lines = text.split("\n")

    # 标准规则2：###镜头n 结构（优先）
    shot = _parse_shot_structure(lines)
    if shot:
        return shot

    marked_idx = [i for i, l in enumerate(lines) if _is_marker(l)]
    if marked_idx:
        starts = sorted(set(marked_idx) | {0})
        segs = []
        for i, s in enumerate(starts):
            e = starts[i + 1] if i + 1 < len(starts) else len(lines)
            end = s
            for k in range(s, e):
                if lines[k].strip():
                    end = k + 1
            content = "\n".join(lines[s:end]).rstrip("\n")
            if content.strip():
                segs.append({"text": content, "start": s, "end": end})
        if segs:
            return segs, "marker"

    # 空行分隔块：每段为一段连续非空行
    segs = []
    i = 0
    while i < len(lines):
        if not lines[i].strip():
            i += 1
            continue
        s = i
        while i < len(lines) and lines[i].strip():
            i += 1
        content = "\n".join(lines[s:i]).rstrip("\n")
        segs.append({"text": content, "start": s, "end": i})
    if len(segs) > 1:
        return segs, "block"

    # 整篇一段
    return [{"text": text.strip("\n"), "start": 0, "end": len(lines)}], "single"


# ---------------------------------------------------------------- 目录
def list_drives():
    drives = []
    for c in string.ascii_uppercase:
        p = f"{c}:\\"
        if os.path.exists(p):
            drives.append(p)
    return drives


def list_dir(path: str):
    """返回 (dirs, files)。files 为 (名称, 是否文本) 列表。"""
    dirs, files = [], []
    try:
        names = os.listdir(path)
    except Exception:
        names = []
    for n in names:
        full = os.path.join(path, n)
        try:
            if os.path.isdir(full):
                dirs.append(n)
            else:
                ext = os.path.splitext(n)[1].lower()
                files.append((n, ext in TEXT_EXTS))
        except Exception:
            continue
    dirs.sort(key=lambda x: x.lower())
    files.sort(key=lambda x: x[0].lower())
    return dirs, files


def norm_path(p: str) -> str:
    p = p.strip().strip('"').strip("'")
    if not p:
        return p
    p = p.replace("/", "\\")
    if not re.match(r"^[a-zA-Z]:\\", p) and not p.endswith("\\"):
        pass
    # 相对路径补上盘符
    if not re.match(r"^[a-zA-Z]:", p):
        p = os.path.abspath(p)
    return p


# ---------------------------------------------------------------- HTTP
def load_added_items():
    """读取左侧“已添加”列表记录。"""
    try:
        if os.path.exists(ADDED_FILE):
            with open(ADDED_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                return data
    except Exception:
        pass
    return []


def save_added_items(items):
    with open(ADDED_FILE, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)


def load_bad_instances():
    """读取“号废了”实例黑名单（只记录实例 id/名称字符串，不删除浏览器里的实例）。"""
    try:
        if os.path.exists(BAD_FILE):
            with open(BAD_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                return [str(x) for x in data]
    except Exception:
        pass
    return []


def save_bad_instances(items):
    with open(BAD_FILE, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)


def send_json(handler, obj, code=200):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def send_html(handler, html):
    data = html.encode("utf-8")
    handler.send_response(200)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


class Handler(BaseHTTPRequestHandler):
    server_version = "PromptManager/1.0"

    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\n" % (self.address_string(), fmt % args))

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path in ("/", "/index.html"):
                if os.path.exists(INDEX_HTML):
                    with open(INDEX_HTML, "r", encoding="utf-8") as f:
                        send_html(self, f.read())
                else:
                    send_html(self, "<h3>web/index.html 不存在</h3>")
                return
            if path == "/api/drives":
                send_json(self, {"ok": True, "drives": list_drives()})
                return
            if path == "/api/tree":
                qs = urllib.parse.parse_qs(parsed.query)
                p = norm_path(qs.get("path", [""])[0])
                if not p or not os.path.isdir(p):
                    send_json(self, {"ok": False, "error": "目录不存在"}, 400)
                    return
                dirs, files = list_dir(p)
                send_json(self, {
                    "ok": True, "path": p,
                    "dirs": dirs,
                    "files": [{"name": n, "isText": t} for n, t in files],
                })
                return
            if path == "/api/read":
                qs = urllib.parse.parse_qs(parsed.query)
                p = norm_path(qs.get("path", [""])[0])
                if not p or not os.path.isfile(p):
                    send_json(self, {"ok": False, "error": "文件不存在"}, 400)
                    return
                text, enc, nl = read_text(p)
                segs, mode = parse_segments(text)
                send_json(self, {
                    "ok": True, "path": p,
                    "name": os.path.basename(p),
                    "content": text,
                    "segments": segs,
                    "mode": mode,
                    "encoding": enc,
                    "newline": nl,
                })
                return
            if path == "/api/added":
                send_json(self, {"ok": True, "items": load_added_items()})
                return
            if path == "/api/bridge/health":
                qs = urllib.parse.parse_qs(parsed.query)
                port = qs.get("port", ["17823"])[0]
                send_json(self, bridge.list_instances(port))
                return
            if path == "/api/bridge/status":
                qs = urllib.parse.parse_qs(parsed.query)
                run_id = qs.get("run", [""])[0]
                send_json(self, bridge.get_status(run_id))
                return
            if path == "/api/bridge/badlist":
                send_json(self, {"ok": True, "bad": load_bad_instances()})
                return
            if path == "/api/pool/status":
                send_json(self, {"ok": True, "stats": dola_pool.stats(),
                                 "accounts": dola_pool.list_accounts()})
                return
            if path == "/api/dola/status":
                qs = urllib.parse.parse_qs(parsed.query)
                run_id = qs.get("run", [""])[0]
                send_json(self, dola_engine.get_status(run_id))
                return
            if path == "/api/dola/pending":
                send_json(self, {"ok": True, "pending": dola_engine.list_pending()})
                return
            if path == "/api/assetlib":
                qs = urllib.parse.parse_qs(parsed.query)
                only = qs.get("withfiles", ["0"])[0]
                out = {"ok": True, "dirs": asset.get_lib_dirs()}
                if only in ("1", "true"):
                    out["lib_count"] = len(asset.list_lib_files())
                send_json(self, out)
                return
            if path == "/api/assetthumb":
                qs = urllib.parse.parse_qs(parsed.query)
                p = qs.get("path", [""])[0]
                if not asset.lib_file_exists(p) or not os.path.isfile(p):
                    send_json(self, {"ok": False, "error": "无权访问该文件"}, 403)
                    return
                try:
                    with open(p, "rb") as f:
                        data = f.read()
                    ext = os.path.splitext(p)[1].lower()
                    mime = {".png": "image/png", ".webp": "image/webp",
                            ".gif": "image/gif", ".bmp": "image/bmp",
                            ".avif": "image/avif", ".jpg": "image/jpeg",
                            ".jpeg": "image/jpeg"}.get(ext, "image/jpeg")
                    self.send_response(200)
                    self.send_header("Content-Type", mime)
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "no-cache")
                    self.end_headers()
                    self.wfile.write(data)
                except Exception as ex:
                    send_json(self, {"ok": False, "error": str(ex)}, 500)
                return
            send_json(self, {"ok": False, "error": "未知接口"}, 404)
        except Exception as e:
            send_json(self, {"ok": False, "error": str(e)}, 500)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path == "/api/write":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                p = norm_path(body.get("path", ""))
                if not p or not os.path.isfile(p):
                    send_json(self, {"ok": False, "error": "文件不存在"}, 400)
                    return
                write_text(
                    p,
                    body.get("content", ""),
                    body.get("encoding", "utf-8"),
                    body.get("newline", "\n"),
                )
                send_json(self, {"ok": True, "saved": True})
                return
            if parsed.path == "/api/added":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                items = body.get("items", [])
                if not isinstance(items, list):
                    items = []
                save_added_items(items)
                send_json(self, {"ok": True, "saved": True})
                return
            if parsed.path == "/api/bridge/generate":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                params = body.get("params") or {}
                # 自动并入“号废了”实例黑名单，批量生成也跳过这些实例
                if isinstance(params, dict):
                    bad = load_bad_instances()
                    params = dict(params)
                    params["bad_instance_ids"] = (params.get("bad_instance_ids") or []) + \
                        [b for b in bad if b not in (params.get("bad_instance_ids") or [])]
                result = bridge.start_batch(
                    body.get("shots") or [],
                    body.get("output_dir") or "",
                    params,
                )
                send_json(self, result)
                return
            if parsed.path == "/api/bridge/mark_bad":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                iid = (body.get("instance_id") or "").strip()
                mark = bool(body.get("mark", True))
                if not iid:
                    send_json(self, {"ok": False, "error": "缺少 instance_id"}, 400)
                    return
                cur = load_bad_instances()
                if mark:
                    if iid not in cur:
                        cur.append(iid)
                else:
                    cur = [x for x in cur if x != iid]
                save_bad_instances(cur)
                send_json(self, {"ok": True, "bad": cur})
                return
            if parsed.path == "/api/pool/register":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                try:
                    info = dola_pool.register(
                        body.get("proxy") or "http://127.0.0.1:7897",
                        body.get("domain") or "mailto.plus",
                        body.get("prefix") or "",
                    )
                    send_json(self, {"ok": True, **info})
                except Exception as ex:
                    send_json(self, {"ok": False, "error": str(ex)}, 400)
                return
            if parsed.path == "/api/pool/import":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                try:
                    info = dola_pool.import_cookies(
                        body.get("email") or "",
                        body.get("cookies") or [],
                        body.get("proxy") or "",
                        body.get("user_id") or "",
                    )
                    send_json(self, {"ok": True, **info})
                except Exception as ex:
                    send_json(self, {"ok": False, "error": str(ex)}, 400)
                return
            if parsed.path == "/api/pool/setstatus":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                dola_pool.set_status(body.get("email") or "", body.get("status") or "",
                                     body.get("reason") or "")
                send_json(self, {"ok": True})
                return
            if parsed.path == "/api/pool/ensure":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                info = dola_pool.ensure_pool(
                    body.get("min_count") or dola_pool.POOL_MIN,
                    body.get("max_count") or dola_pool.POOL_MAX,
                    body.get("proxy") or "",
                )
                send_json(self, info)
                return
            if parsed.path == "/api/dola/generate":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                # 生成前自动补池（可用号 <5 后台取号补到 20）
                dola_pool.ensure_pool()
                result = dola_engine.start_batch(
                    body.get("shots") or [],
                    body.get("output_dir") or "",
                    body.get("params") or {},
                )
                send_json(self, result)
                return
            if parsed.path == "/api/dola/cancel":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                send_json(self, dola_engine.cancel(body.get("run") or ""))
                return
            if parsed.path == "/api/dola/manual-collect":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                send_json(self, dola_engine.manual_collect(
                    body.get("run") or "", body.get("scene_no")))
                return
            if parsed.path == "/api/dola/reopen":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                send_json(self, dola_engine.reopen_window(
                    body.get("run") or "", body.get("scene_no")))
                return
            if parsed.path == "/api/dola/delete-pending":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                send_json(self, dola_engine.delete_pending(
                    body.get("run") or "", body.get("scene_no")))
                return
            if parsed.path == "/api/bridge/cancel":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                send_json(self, bridge.cancel(body.get("run") or ""))
                return
            if parsed.path == "/api/bridge/openfolder":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                p = body.get("path") or ""
                if not p or not os.path.isdir(p):
                    send_json(self, {"ok": False, "error": "目录不存在"}, 400)
                    return
                try:
                    os.startfile(p)  # Windows 资源管理器打开目录
                    send_json(self, {"ok": True})
                except Exception as ex:
                    send_json(self, {"ok": False, "error": str(ex)}, 500)
                return
            if parsed.path == "/api/assetlib":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                action = body.get("action") or "list"
                p = body.get("path") or ""
                if action == "add":
                    send_json(self, asset.add_lib_dir(p))
                elif action == "remove":
                    send_json(self, asset.remove_lib_dir(p))
                else:
                    send_json(self, {"ok": True, "dirs": asset.get_lib_dirs()})
                return
            if parsed.path == "/api/assets/extract":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                p = body.get("path") or ""
                if not p or not os.path.isfile(p):
                    send_json(self, {"ok": False, "error": "文件不存在"}, 400)
                    return
                parsed_data = asset.parse_file_assets(p)
                reset = bool(body.get("reset"))
                matched = asset.match_assets(parsed_data, reset=reset)
                matched["lib_files"] = asset.list_lib_files()
                send_json(self, {"ok": True, **matched})
                return
            if parsed.path == "/api/assets/link":
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                send_json(self, asset.set_link(body.get("name") or "", body.get("path") or ""))
                return
            send_json(self, {"ok": False, "error": "未知接口"}, 404)
        except Exception as e:
            send_json(self, {"ok": False, "error": str(e)}, 500)


def find_free_port(start: int):
    for port in range(start, start + 200):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return start


def main():
    port = find_free_port(DEFAULT_PORT)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    # 记录实际端口，供启动器定位页面地址
    try:
        with open(os.path.join(BASE_DIR, "port.txt"), "w", encoding="ascii") as f:
            f.write(str(port))
    except Exception:
        pass
    url = f"http://127.0.0.1:{port}/"
    print("=" * 52)
    print("  提示词管理器后端已启动")
    print(f"  地址: {url}")
    print("  关闭本窗口即可退出程序。")
    print("=" * 52)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    # 启动即恢复在途收片（提交成功但未出片/未下载的分镜），避免切换剧本或重启后丢失
    threading.Thread(target=dola_engine.resume_pending, daemon=True).start()
    main()
