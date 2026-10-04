# -*- coding: utf-8 -*-
"""
号池模块：SQLite 账号库 + DPAPI 加密 Cookie。
- 取号（注册）：调 Dola 邮箱注册接口（tempmail 收码 + 代理出口非大陆），Cookie 加密入池。
- 手动导入：导入已有账号的 Cookie 进池。
- 取号使用：从池中取一个"可用"账号。
- 状态管理：可用 / 已用 / 号废了 / 号正常 / 额度不足 等。

基于 dola-cdp-workflow 的 register_one.py 提炼，去掉对桌面的依赖。
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import http.cookiejar
import json
import os
from pathlib import Path
import re
import secrets
import string
import sqlite3
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener

# ---------------------------------------------------------------- 路径
ROOT = Path(__file__).resolve().parent
STATE = ROOT / "state"
DB = STATE / "accounts.sqlite3"
POOL = STATE / "pool"          # 每账号一个 .dpapi 加密凭据文件
LOCK = STATE / "pool.lock"     # 注册串行锁

BASE = "https://www.dola.com"
MAIL_API = "https://tempmail.plus/api/mails"
BASE_PARAMS = {
    "aid": "495671",
    "account_sdk_source": "web",
    "sdk_version": "2.2.11-doubao.0",
    "device_platform": "web",
}
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# 号池账号状态（accounts.status）
STATUS_OK = ("registered", "available", "ok", "normal")   # 可被取号使用
STATUS_BAD = ("bad", "bad_used", "号废了", "废")
STATUS_USED = ("used", "已用")
STATUS_GENERATED = ("generated", "已生成")   # 已用并成功生成（一镜一号）
STATUS_REVIEW = ("needs_review", "待复核")    # 登录态待复核（不参与取号，可恢复）

POOL_MIN = 5
POOL_MAX = 20


# ---------------------------------------------------------------- DPAPI
class DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _blob(data: bytes):
    buffer = (ctypes.c_byte * len(data)).from_buffer_copy(data)
    return DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))), buffer


def dpapi_protect(data: bytes) -> bytes:
    source, keepalive = _blob(data)
    target = DataBlob()
    crypt = ctypes.windll.crypt32
    crypt.CryptProtectData.argtypes = [
        ctypes.POINTER(DataBlob), wintypes.LPCWSTR, ctypes.POINTER(DataBlob),
        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DataBlob),
    ]
    crypt.CryptProtectData.restype = wintypes.BOOL
    if not crypt.CryptProtectData(ctypes.byref(source), None, None, None, None, 0, ctypes.byref(target)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(target.pbData, target.cbData)
    finally:
        local_free = ctypes.windll.kernel32.LocalFree
        local_free.argtypes = [ctypes.c_void_p]
        local_free.restype = ctypes.c_void_p
        local_free(ctypes.cast(target.pbData, ctypes.c_void_p))


def dpapi_unprotect(data: bytes) -> bytes:
    source, keepalive = _blob(data)
    target = DataBlob()
    crypt = ctypes.windll.crypt32
    crypt.CryptUnprotectData.argtypes = [
        ctypes.POINTER(DataBlob), ctypes.c_void_p, ctypes.POINTER(DataBlob),
        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DataBlob),
    ]
    crypt.CryptUnprotectData.restype = wintypes.BOOL
    if not crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 0, ctypes.byref(target)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(target.pbData, target.cbData)
    finally:
        local_free = ctypes.windll.kernel32.LocalFree
        local_free.argtypes = [ctypes.c_void_p]
        local_free.restype = ctypes.c_void_p
        local_free(ctypes.cast(target.pbData, ctypes.c_void_p))


def dpapi_selfcheck() -> None:
    if dpapi_unprotect(dpapi_protect(b"check")) != b"check":
        raise RuntimeError("Windows 凭据加密自检失败")


# ---------------------------------------------------------------- 时间 / DB
def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def init_db() -> sqlite3.Connection:
    STATE.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS accounts (
            email TEXT PRIMARY KEY, user_id TEXT, status TEXT NOT NULL,
            credential_path TEXT NOT NULL, proxy TEXT NOT NULL,
            created_at TEXT NOT NULL, invalid_reason TEXT, note TEXT,
            series_label TEXT, scene_no TEXT
        );
        CREATE TABLE IF NOT EXISTS instances (
            id INTEGER PRIMARY KEY, email TEXT NOT NULL, profile_dir TEXT NOT NULL,
            debug_port INTEGER NOT NULL UNIQUE, proxy TEXT NOT NULL,
            status TEXT NOT NULL, chat_url TEXT, last_used_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS attempts (
            id INTEGER PRIMARY KEY, email TEXT, stage TEXT NOT NULL,
            success INTEGER NOT NULL, detail TEXT, occurred_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY, kind TEXT NOT NULL, email TEXT,
            detail TEXT, occurred_at TEXT NOT NULL
        );
    """)
    # 兼容旧表：补列
    for col in ("series_label", "scene_no"):
        try:
            conn.execute(f"ALTER TABLE accounts ADD COLUMN {col} TEXT")
        except Exception:
            pass
    conn.commit()
    return conn


def _event(conn, kind, email, detail):
    conn.execute(
        "INSERT INTO events(kind,email,detail,occurred_at) VALUES(?,?,?,?)",
        (kind, email, detail, now()),
    )
    conn.commit()


def _log_attempt(conn, email, stage, success, detail):
    conn.execute(
        "INSERT INTO attempts(email,stage,success,detail,occurred_at) VALUES(?,?,?,?,?)",
        (email, stage, 1 if success else 0, detail[:500], now()),
    )
    conn.commit()


# ---------------------------------------------------------------- HTTP
class HttpClient:
    def __init__(self, proxy: str):
        self.cookies = http.cookiejar.CookieJar()
        self.opener = build_opener(
            ProxyHandler({"http": proxy, "https": proxy}),
            HTTPCookieProcessor(self.cookies),
        )

    def request(self, url: str, data: dict | None = None, timeout: int = 20):
        encoded = urlencode(data).encode() if data is not None else None
        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": BASE + "/chat/",
        }
        if encoded is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
            headers["Origin"] = BASE
        req = Request(url, data=encoded, headers=headers)
        try:
            with self.opener.open(req, timeout=timeout) as response:
                return response.status, response.read(2_000_000).decode("utf-8", "replace")
        except HTTPError as error:
            return error.code, error.read(2_000_000).decode("utf-8", "replace")
        except URLError as error:
            raise RuntimeError(f"连接失败：{error.reason}") from error


def extract_code(text: str) -> str | None:
    match = re.search(r"(?<!\d)\d{6}(?!\d)", text or "")
    return match.group(0) if match else None


def create_password() -> str:
    alphabet = string.ascii_letters + string.digits
    chars = [secrets.choice(string.ascii_uppercase),
             secrets.choice(string.ascii_lowercase),
             secrets.choice(string.digits)]
    chars.extend(secrets.choice(alphabet) for _ in range(9))
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)


def wait_for_code(http: HttpClient, email: str, seconds: int = 90) -> str:
    seen = set()
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        status, body = http.request(MAIL_API + "?" + urlencode({"email": email, "limit": "5"}))
        if status == 200:
            try:
                messages = json.loads(body).get("mail_list", [])
            except Exception:
                messages = []
            for message in messages:
                mail_id = str(message.get("mail_id") or message.get("id") or "")
                if not mail_id or mail_id in seen:
                    continue
                code = extract_code(str(message.get("subject", "")))
                if code:
                    return code
                detail_url = MAIL_API + "/" + mail_id + "?" + urlencode({"email": email})
                dstatus, dbody = http.request(detail_url)
                if dstatus == 200:
                    seen.add(mail_id)
                    try:
                        detail = json.loads(dbody)
                    except Exception:
                        continue
                    for field in ("text", "subject", "html"):
                        code = extract_code(str(detail.get(field, "")))
                        if code:
                            return code
        time.sleep(3)
    raise TimeoutError("90 秒内未收到邮箱验证码")


def user_id_from(body: str) -> str:
    try:
        obj = json.loads(body)
    except json.JSONDecodeError:
        return ""

    def walk(value):
        if isinstance(value, dict):
            for key in ("user_id", "userId", "uid"):
                if value.get(key):
                    return str(value[key])
            for child in value.values():
                found = walk(child)
                if found:
                    return found
        elif isinstance(value, list):
            for child in value:
                found = walk(child)
                if found:
                    return found
        return ""

    return walk(obj)


def _check_egress(http: HttpClient) -> None:
    """经代理探测出口是否为大陆，任一源给非 CN 即通过。"""
    last = ""
    sources = [
        "https://ipwho.is/",
        "http://ip-api.com/json",
        "https://ipinfo.io/json",
    ]
    for url in sources:
        try:
            status, body = http.request(url, timeout=12)
        except Exception as error:
            last = f"{url} {str(error)[:60]}"
            continue
        if status != 200:
            last = f"{url} HTTP {status}"
            continue
        try:
            data = json.loads(body)
        except Exception:
            last = f"{url} 响应非 JSON"
            continue
        country = (data.get("country_code") or data.get("country") or "").strip().upper()
        if not country:
            last = f"{url} 无国家字段"
            continue
        if country != "CN":
            return
        last = f"{url} 出口中国大陆"
        break
    raise RuntimeError(f"代理出口检查失败：{last or '全部源失败'}")


# ---------------------------------------------------------------- 注册取号
def register(proxy: str = "http://127.0.0.1:7897", domain: str = "mailto.plus",
             email_prefix: str = "") -> dict:
    """注册一个新 Dola 账号并加密入池。返回账号信息。"""
    parsed = urlsplit(proxy)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or not parsed.port:
        raise ValueError("代理地址应为 http://主机:端口")
    dpapi_selfcheck()
    STATE.mkdir(parents=True, exist_ok=True)
    http = HttpClient(proxy)
    _check_egress(http)

    prefix = email_prefix or f"dola{secrets.token_hex(5)}001"
    email = f"{prefix}@{domain}"
    password = create_password()
    conn = init_db()
    try:
        _event(conn, "registration_started", email, "register-one")
        http.request(BASE + "/chat/")
        query = urlencode({**BASE_PARAMS, "email": email, "type": "16"})
        status, body = http.request(BASE + "/passport/web/email/send_code/?" + query)
        if status >= 400 or "success" not in body.lower():
            raise RuntimeError(f"发码未成功：HTTP {status}，响应 {body[:200]}")
        code = wait_for_code(http, email)
        form = {"email": email, "type": "16", "code": code,
                "password": password, **BASE_PARAMS}
        status, body = http.request(BASE + "/passport/web/email/register_verify_login/", form)
        user_id = user_id_from(body)
        if status >= 400 or not user_id:
            raise RuntimeError(f"注册未确认：HTTP {status}，响应 {body[:200]}")
        http.request(BASE + "/chat/")
        cookies = [
            {"name": cookie.name, "value": cookie.value, "domain": cookie.domain,
             "path": cookie.path, "secure": cookie.secure,
             "expires": cookie.expires, "httpOnly": "HttpOnly" in cookie._rest}
            for cookie in http.cookies if "dola.com" in cookie.domain
        ]
        if not cookies:
            raise RuntimeError("注册返回成功，但没有取得 Dola Cookie")
        payload = {"email": email, "password": password, "user_id": user_id,
                   "cookies": cookies, "created_at": now()}
        vault = POOL / f"{user_id}.dpapi"
        if vault.exists():
            raise RuntimeError("凭据文件已存在，拒绝覆盖")
        vault.parent.mkdir(parents=True, exist_ok=True)
        vault.write_bytes(dpapi_protect(json.dumps(payload, ensure_ascii=False).encode()))
        conn.execute(
            "INSERT INTO accounts(email,user_id,status,credential_path,proxy,created_at) "
            "VALUES(?,?,?,?,?,?)",
            (email, user_id, "registered", str(vault), proxy, now()),
        )
        _log_attempt(conn, email, "registered", True, f"cookies={len(cookies)}")
        conn.commit()
        _event(conn, "registered", email, f"cookies={len(cookies)}")
        return {"email": email, "user_id": user_id, "cookies": len(cookies)}
    except Exception as error:
        conn.rollback()
        _event(conn, "registration_failed", email, str(error)[:200])
        raise RuntimeError(f"取号失败：{error}") from error
    finally:
        conn.close()


# ---------------------------------------------------------------- 手动导入
def import_cookies(email: str, cookies: list, proxy: str = "",
                   user_id: str = "") -> dict:
    """导入已有账号的 Cookie 进号池。cookies: [{name,value,domain,path,secure,...}]"""
    if not email or not isinstance(cookies, list) or not cookies:
        raise ValueError("缺少 email 或 cookies")
    dpapi_selfcheck()
    uid = user_id or f"imp_{secrets.token_hex(4)}"
    payload = {"email": email, "password": "", "user_id": uid,
               "cookies": cookies, "created_at": now()}
    vault = POOL / f"{uid}.dpapi"
    if vault.exists():
        raise RuntimeError("凭据文件已存在，拒绝覆盖")
    vault.parent.mkdir(parents=True, exist_ok=True)
    vault.write_bytes(dpapi_protect(json.dumps(payload, ensure_ascii=False).encode()))
    conn = init_db()
    try:
        conn.execute(
            "INSERT INTO accounts(email,user_id,status,credential_path,proxy,created_at,note) "
            "VALUES(?,?,?,?,?,?,?)",
            (email, uid, "registered", str(vault), proxy, now(), "manual"),
        )
        _log_attempt(conn, email, "manual_import", True, f"cookies={len(cookies)}")
        conn.commit()
        _event(conn, "imported", email, f"cookies={len(cookies)}")
    finally:
        conn.close()
    return {"email": email, "user_id": uid, "cookies": len(cookies)}


# ---------------------------------------------------------------- 自动补池
import threading as _threading

_pool_fill_thread = None
_pool_fill_lock = _threading.Lock()


def _count_usable() -> int:
    conn = init_db()
    try:
        return conn.execute(
            "SELECT COUNT(*) FROM accounts WHERE status IN ("
            + ",".join("?" * len(STATUS_OK)) + ")", (*STATUS_OK,),
        ).fetchone()[0]
    finally:
        conn.close()


def _fill_pool(max_count: int, proxy: str, domain: str) -> None:
    """后台取号补充：注册到可用号达到 max 或连续失败 3 次停止。"""
    fails = 0
    last_err = ""
    while fails < 3:
        if _count_usable() >= max_count:
            break
        try:
            register(proxy=proxy, domain=domain)
            fails = 0
        except Exception as error:
            fails += 1
            last_err = str(error)[:200]
        time.sleep(10)
    _event(init_db(), "pool_fill_done", "",
           f"usable={_count_usable()} max={max_count} fails={fails} last_err={last_err}")


def ensure_pool(min_count: int = POOL_MIN, max_count: int = POOL_MAX,
                proxy: str = "http://127.0.0.1:7897", domain: str = "mailto.plus") -> dict:
    """号池自动补给：可用号 < min 时后台取号补到 max。手动导入不计上限。"""
    global _pool_fill_thread
    usable = _count_usable()
    if usable >= min_count:
        return {"ok": True, "usable": usable, "action": "skip"}
    with _pool_fill_lock:
        if _pool_fill_thread and _pool_fill_thread.is_alive():
            return {"ok": True, "usable": usable, "action": "already_filling"}
        thread = _threading.Thread(
            target=_fill_pool, args=(max_count, proxy, domain), daemon=True)
        _pool_fill_thread = thread
        thread.start()
        return {"ok": True, "usable": usable, "action": "filling"}



def load_account(email: str) -> dict | None:
    """解密并返回账号的完整凭据（含 cookies），用于注入浏览器。"""
    conn = init_db()
    try:
        row = conn.execute(
            "SELECT email,user_id,status,credential_path,proxy FROM accounts WHERE email=?",
            (email,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    email_, user_id, status, cred_path, proxy = row
    if not os.path.exists(cred_path):
        raise RuntimeError(f"凭据文件不存在：{cred_path}")
    data = json.loads(dpapi_unprotect(Path(cred_path).read_bytes()).decode("utf-8"))
    return {"email": email_, "user_id": user_id, "status": status,
            "proxy": proxy, "cookies": data.get("cookies", [])}


_take_lock = _threading.Lock()


def take_available(prefer_email: str = "") -> dict | None:
    """原子取号：取一个可用账号并立即标记 in_use（并发下保证每个 worker 拿到的号不同）。"""
    with _take_lock:
        conn = init_db()
        try:
            target = None
            if prefer_email:
                row = conn.execute(
                    "SELECT email FROM accounts WHERE email=? AND status IN ("
                    + ",".join("?" * len(STATUS_OK)) + ")",
                    (prefer_email, *STATUS_OK),
                ).fetchone()
                target = row[0] if row else None
            if not target:
                row = conn.execute(
                    "SELECT email FROM accounts WHERE status IN ("
                    + ",".join("?" * len(STATUS_OK)) + ") ORDER BY created_at ASC LIMIT 1",
                    (*STATUS_OK,),
                ).fetchone()
                target = row[0] if row else None
            if not target:
                return None
            conn.execute(
                "UPDATE accounts SET status='in_use' WHERE email=? AND status IN ("
                + ",".join("?" * len(STATUS_OK)) + ")",
                (target, *STATUS_OK),
            )
            conn.commit()
            return load_account(target)
        finally:
            conn.close()


def release_available(email: str) -> None:
    """把占用(in_use)的账号放回可用池（启动失败/平台服务错误等非账号问题的场景）。"""
    conn = init_db()
    try:
        conn.execute(
            "UPDATE accounts SET status='registered', invalid_reason=NULL "
            "WHERE email=? AND status='in_use'",
            (email,),
        )
        conn.commit()
    finally:
        conn.close()


def delete_account(email: str) -> None:
    """从号池删除该账号（失败丢弃）：删 DB 记录 + 加密凭据文件。"""
    conn = init_db()
    cred = ""
    try:
        row = conn.execute(
            "SELECT credential_path FROM accounts WHERE email=?", (email,)
        ).fetchone()
        if row:
            cred = row[0]
        _event(conn, "account_deleted", email, "discard")
        conn.execute("DELETE FROM accounts WHERE email=?", (email,))
        conn.commit()
    finally:
        conn.close()
    if cred and os.path.exists(cred):
        try:
            os.remove(cred)
        except OSError:
            pass


def set_status(email: str, status: str, reason: str = "", series: str = "", scene: str = "") -> None:
    """设置账号状态。生成成功转入 generated 时传入 series/scene 记录剧集镜号。"""
    conn = init_db()
    try:
        if series or scene:
            conn.execute(
                "UPDATE accounts SET status=?, invalid_reason=?, series_label=?, scene_no=? WHERE email=?",
                (status, reason, series, scene, email),
            )
        else:
            conn.execute(
                "UPDATE accounts SET status=?, invalid_reason=? WHERE email=?",
                (status, reason, email),
            )
        conn.commit()
        _event(conn, f"status_{status}", email, f"{reason} {series or ''} {scene or ''}".strip())
    finally:
        conn.close()


def list_accounts() -> list[dict]:
    conn = init_db()
    try:
        rows = conn.execute(
            "SELECT email,user_id,status,proxy,created_at,note,invalid_reason,series_label,scene_no "
            "FROM accounts ORDER BY created_at"
        ).fetchall()
    finally:
        conn.close()
    return [{"email": r[0], "user_id": r[1], "status": r[2], "proxy": r[3],
             "created_at": r[4], "note": r[5], "reason": r[6],
             "series": r[7], "scene": r[8]} for r in rows]


def stats() -> dict:
    conn = init_db()
    try:
        total = conn.execute("SELECT COUNT(*) FROM accounts").fetchone()[0]
        usable = conn.execute(
            "SELECT COUNT(*) FROM accounts WHERE status IN ("
            + ",".join("?" * len(STATUS_OK)) + ")", (*STATUS_OK,),
        ).fetchone()[0]
        bad = conn.execute(
            "SELECT COUNT(*) FROM accounts WHERE status IN ("
            + ",".join("?" * len(STATUS_BAD)) + ")", (*STATUS_BAD,),
        ).fetchone()[0]
        generated = conn.execute(
            "SELECT COUNT(*) FROM accounts WHERE status IN ("
            + ",".join("?" * len(STATUS_GENERATED)) + ")", (*STATUS_GENERATED,),
        ).fetchone()[0]
        review = conn.execute(
            "SELECT COUNT(*) FROM accounts WHERE status IN ("
            + ",".join("?" * len(STATUS_REVIEW)) + ")", (*STATUS_REVIEW,),
        ).fetchone()[0]
        in_use = conn.execute(
            "SELECT COUNT(*) FROM accounts WHERE status='in_use'"
        ).fetchone()[0]
    finally:
        conn.close()
    return {"total": total, "usable": usable, "bad": bad,
            "generated": generated, "review": review, "in_use": in_use}


# ---------------------------------------------------------------- instances 记录
def record_instance(email: str, profile_dir: str, port: int, proxy: str,
                    chat_url: str = "", status: str = "open") -> None:
    conn = init_db()
    try:
        conn.execute(
            "INSERT INTO instances(email,profile_dir,debug_port,proxy,status,chat_url,last_used_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (email, profile_dir, port, proxy, status, chat_url, now()),
        )
        conn.commit()
    finally:
        conn.close()


def update_instance(port: int, status: str, chat_url: str = "") -> None:
    conn = init_db()
    try:
        if chat_url:
            conn.execute(
                "UPDATE instances SET status=?, chat_url=?, last_used_at=? WHERE debug_port=?",
                (status, chat_url, now(), port),
            )
        else:
            conn.execute(
                "UPDATE instances SET status=?, last_used_at=? WHERE debug_port=?",
                (status, now(), port),
            )
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "stats":
        print(json.dumps(stats(), ensure_ascii=False))
    else:
        for a in list_accounts():
            print(f"{a['email']}  {a['status']}  {a['created_at']}  {a['note'] or ''}")
        print(json.dumps(stats(), ensure_ascii=False))
