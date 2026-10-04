# -*- coding: utf-8 -*-
"""
代理端口池：独立 mihomo 多进程多端口，每个账号绑定一个独立出口 IP。
当前可用节点（非 ECH、已验 Dola 可用）：香港 HY1、台湾家宽3。
每端口最大并发号数（slots）默认 5（2 端口 * 5 = 10 并发）。
"""
from __future__ import annotations

import socket
import subprocess
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# 端口 -> 节点名 -> 并发上限（slots）
PORTS = [
    {"port": 7813, "name": "🇭🇰香港HY1", "slots": 5},
    {"port": 7814, "name": "🇹🇼台湾家宽3", "slots": 5},
]

_lock = threading.Lock()
_active = {p["port"]: 0 for p in PORTS}   # 每端口当前占用号数
_cursor = 0                                 # round-robin 游标


def node_label(port: int) -> str:
    for p in PORTS:
        if p["port"] == port:
            return p["name"]
    return f"port{port}"


def acquire() -> dict | None:
    """取一个未满的代理端口（选当前占用最少的），返回 {port, proxy, name}。满了返回 None。"""
    global _cursor
    with _lock:
        # 选当前占用数最少的端口（负载均衡），相同则按端口号稳定
        candidates = sorted(PORTS, key=lambda p: (_active[p["port"]], p["port"]))
        for p in candidates:
            if _active[p["port"]] < p["slots"]:
                _active[p["port"]] += 1
                _cursor = (p["port"] + 1) % 10000
                return {
                    "port": p["port"],
                    "proxy": f"http://127.0.0.1:{p['port']}",
                    "name": p["name"],
                }
        return None


def release(port: int) -> None:
    with _lock:
        if port in _active and _active[port] > 0:
            _active[port] -= 1


def stats() -> dict:
    with _lock:
        return [
            {"port": p["port"], "name": p["name"], "slots": p["slots"],
             "active": _active[p["port"]]}
            for p in PORTS
        ]


# ---------------------------------------------------------------- mihomo 端口拉起
def _is_listening(port: int, timeout: float = 0.4) -> bool:
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect(("127.0.0.1", port))
        s.close()
        return True
    except OSError:
        return False


def _start_core(port: int) -> None:
    mh = ROOT / "mihomo"
    run = mh / "run" / f"p{port}"
    run.mkdir(parents=True, exist_ok=True)
    subprocess.Popen(
        [str(mh / "core.exe"), "-d", str(run), "-f", str(mh / "configs" / f"p{port}.yaml")],
        cwd=str(mh),
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        stdout=open(run / "out.log", "a", encoding="utf-8"),
        stderr=open(run / "err.log", "a", encoding="utf-8"),
    )


def ensure_running(max_wait: float = 20.0) -> list:
    """确保所有代理端口对应 mihomo 进程在监听；缺失则拉起。返回本次拉起的端口。"""
    started = []
    for p in PORTS:
        port = p["port"]
        if _is_listening(port):
            continue
        _start_core(port)
        started.append(port)
        deadline = time.monotonic() + max_wait
        while time.monotonic() < deadline and not _is_listening(port):
            time.sleep(0.8)
        if not _is_listening(port):
            raise RuntimeError(f"代理端口 {port} 启动失败（mihomo 未就绪）")
    return started
