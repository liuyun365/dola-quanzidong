# -*- coding: utf-8 -*-
"""
提示词管理器 —— 资产关联模块。

职责：
  1. 资产库管理：登记资产库文件夹（持久化 asset_lib.json），扫描其中的图片文件；
  2. 从分镜提示词里解析所需资产：**角色映射：** 图一为夕瑶… / **场景映射：** 图六为陈家别墅餐厅；
  3. 汇总去重后的资产清单 + 每分镜的有序资产（按 图一、图二… 顺序）；
  4. 按资产库文件名做模糊匹配（支持手动修改 / 留白），关联持久化 asset_links.json；
  5. 供桥接层按分镜顺序把参考图注入生成任务。

仅依赖 Python 标准库。
"""
import os
import re
import json
import threading
import difflib

MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
LIB_JSON = os.path.join(MODULE_DIR, "asset_lib.json")     # 资产库目录列表
LINKS_JSON = os.path.join(MODULE_DIR, "asset_links.json")  # 资产名 -> 图片路径（含手动修改/留白）

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"}
_lock = threading.Lock()

CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
# 图一为夕瑶 / 图1: 林希 / 图一＝女主 … 名字取到空白/括号/标点前（支持 = ＝ 分隔）
MAP_RE = re.compile(r"图\s*([一二三四五六七八九十0-9]+)\s*(?:为|[:：=＝])\s*([^\s（(，,。、；;\n]+)")


def _load_json(path, default):
    try:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return default


def _save_json(path, data):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


# ---------------------------------------------------------------
#  资产库目录管理
# ---------------------------------------------------------------

def get_lib_dirs():
    with _lock:
        return list(_load_json(LIB_JSON, []))


def set_lib_dirs(dirs):
    clean = []
    for d in dirs or []:
        d = str(d).strip()
        if d and d not in clean:
            clean.append(d)
    with _lock:
        _save_json(LIB_JSON, clean)


def add_lib_dir(path):
    dirs = get_lib_dirs()
    path = str(path).strip().rstrip("\\/")
    if not path or path in dirs:
        return {"ok": True, "dirs": dirs}
    dirs.append(path)
    set_lib_dirs(dirs)
    return {"ok": True, "dirs": dirs}


def remove_lib_dir(path):
    dirs = [d for d in get_lib_dirs() if d != str(path).strip().rstrip("\\/")]
    set_lib_dirs(dirs)
    return {"ok": True, "dirs": dirs}


def list_lib_files():
    """扫描所有资产库目录里的图片文件（递归）。"""
    files = []
    seen = set()
    for d in get_lib_dirs():
        if not os.path.isdir(d):
            continue
        for root, _, names in os.walk(d):
            for n in names:
                if os.path.splitext(n)[1].lower() not in IMAGE_EXTS:
                    continue
                p = os.path.join(root, n)
                key = os.path.normcase(os.path.abspath(p))
                if key in seen:
                    continue
                seen.add(key)
                files.append({"name": os.path.splitext(n)[0], "path": p, "dir": d})
    return files


def lib_file_exists(path):
    """path 是否属于某个已登记资产库目录（用于缩略图等安全校验）。"""
    if not path:
        return False
    try:
        ap = os.path.normcase(os.path.abspath(path))
    except Exception:
        return False
    for d in get_lib_dirs():
        try:
            if os.path.normcase(os.path.abspath(d)) == ap:
                return True
            if ap.startswith(os.path.normcase(os.path.abspath(d)) + os.sep):
                return True
        except Exception:
            continue
    return False


# ---------------------------------------------------------------
#  分镜资产解析
# ---------------------------------------------------------------

def _slot_number(slot):
    s = re.sub(r"图\s*", "", slot or "").strip()
    if s.isdigit():
        return int(s)
    n = 0
    for ch in s:
        n += CN_NUM.get(ch, 0)
    return n or 0


def _line_of(text, pos):
    ls = text.rfind("\n", 0, pos) + 1
    le = text.find("\n", pos)
    return text[ls: le if le != -1 else len(text)]


def parse_shot_assets(text):
    """解析一个分镜文本里的资产引用，返回按 图一、图二… 顺序排列的列表。"""
    items = []
    for m in MAP_RE.finditer(text):
        slot = "图" + m.group(1)
        name = m.group(2).strip()
        if not name:
            continue
        line = _line_of(text, m.start())
        if "角色映射" in line:
            typ = "角色"
        elif "场景映射" in line:
            typ = "场景"
        else:
            typ = "资产"
        items.append({"slot": slot, "slotn": _slot_number(slot), "name": name, "type": typ})
    items.sort(key=lambda x: x["slotn"])
    return items


def _parse_ref_items(line):
    """从「**参考对应：**」行解析出精确的 slot→文件 资产列表（图一、图二… 顺序）。

    参考对应是完整准确的（每图一个确切文件），作为本标准的首选解析来源。
    形如：图一对应F02 人物设定/女主_小三形象_v1.png；图二对应F12 人物设定/丈夫_约会形象_v1.png；
    「无独立参考图 / 无参考图」的槽位跳过（不留资产，保持留白）。
    """
    items = []
    for seg in re.split(r"[；;。]", line):
        seg = seg.strip()
        if not seg:
            continue
        m = re.search(r"图\s*([一二三四五六七八九十0-9]+)\s*对应\s*(.*)", seg)
        if not m:
            continue
        slotn = _slot_number("图" + m.group(1))
        rest = m.group(2).strip()
        if any(k in rest for k in ("无独立参考图", "无参考图", "无对应", "无独立")):
            continue  # 该槽无参考图文件，留白
        fn = rest.replace("\\", "/").rsplit("/", 1)[-1]
        fn = re.split(r"[（(]", fn)[0].strip()
        if not fn:
            continue
        name = os.path.splitext(fn)[0].strip()
        if not name:
            continue
        if "人物设定" in rest:
            typ = "角色"
        elif "场景设定" in rest:
            typ = "场景"
        else:
            typ = "资产"
        items.append({"slot": "图" + str(slotn), "slotn": slotn, "name": name, "type": typ})
    items.sort(key=lambda x: x["slotn"])
    return items


def parse_file_assets(path):
    """读文件 → 解析每分镜资产（按最近一个 ### 行归属）→ 汇总去重清单。

    分镜归属：遇到「角色映射/场景映射」行，归到它之前最近一个 ### 开头的分镜。
    只保留含资产声明的分镜（与前端按 ### 识别的真实分镜顺序一致）。
    """
    with open(path, encoding="utf-8") as f:
        text = f.read()
    shots_ordered = []   # [{'label','items'}]
    idx_by_label = {}
    cur_key = None
    used_ref_by_key = {}
    for ln in text.split("\n"):
        s = ln.strip()
        if s.startswith("###"):
            cur_key = s
            if cur_key not in idx_by_label:
                idx_by_label[cur_key] = len(shots_ordered)
                shots_ordered.append({"label": s, "items": []})
            continue
        if not cur_key:
            continue
        if "参考对应" in s:
            ri = _parse_ref_items(s)
            if ri:
                shots_ordered[idx_by_label[cur_key]]["items"] = ri
                used_ref_by_key[cur_key] = True
            continue
        if used_ref_by_key.get(cur_key):
            continue  # 本分镜已用「参考对应」精确解析（完整准确），跳过名字映射
        if "角色映射" in s or "场景映射" in s:
            items = parse_shot_assets(s)
            if items:
                shots_ordered[idx_by_label[cur_key]]["items"].extend(items)
    for sh in shots_ordered:
        sh["items"].sort(key=lambda x: x["slotn"])
    real = [sh for sh in shots_ordered if sh["items"]]
    per_shot = [sh["items"] for sh in real]
    shot_labels = [sh["label"] for sh in real]
    summary_map = {}   # name -> {name,type,shots:[...]}
    for ri, sh in enumerate(real):
        n = ri + 1
        for it in sh["items"]:
            k = it["name"]
            if k not in summary_map:
                summary_map[k] = {"name": k, "type": it["type"], "shots": []}
            if n not in summary_map[k]["shots"]:
                summary_map[k]["shots"].append(n)
    order = {"角色": 0, "场景": 1, "资产": 2}
    summary = sorted(summary_map.values(), key=lambda a: (order.get(a["type"], 3), a["name"]))
    return {
        "shots": shot_labels,
        "per_shot": per_shot,
        "summary": summary,
    }


# ---------------------------------------------------------------
#  模糊匹配
# ---------------------------------------------------------------

def _norm(s):
    s = re.sub(r"[（(][^）)]*[）)]", "", str(s))          # 去括号及内容
    s = re.sub(r"[ _\-·\s]", "", s)
    return s.lower()


def _score(needle, hay):
    if not needle or not hay:
        return 0
    if needle == hay:
        return 100
    # 前缀命中（"陈宇" vs "陈宇_年轻"）优先级最高：88 + 命中长度
    if hay.startswith(needle) or needle.startswith(hay):
        return 88 + min(len(needle), len(hay))
    # 中段/尾部子串命中（"婆婆" vs "见婆婆咖啡馆"）降权，避免错配
    if needle in hay or hay in needle:
        return 70
    prefix = 0
    for a, b in zip(needle, hay):
        if a != b:
            break
        prefix += 1
    ratio = difflib.SequenceMatcher(None, needle, hay).ratio()
    base = int(ratio * 100)
    if prefix >= 2:
        base = max(base, 70 + prefix * 3)
    return base


def _best_match(name, lib_files):
    na = _norm(name)
    best = None
    best_score = 0
    for f in lib_files:
        s = _score(na, _norm(f["name"]))
        if s > best_score:
            best_score = s
            best = f
    return best, best_score


def load_links():
    with _lock:
        return dict(_load_json(LINKS_JSON, {}))


def save_links(links):
    with _lock:
        _save_json(LINKS_JSON, links)


def match_assets(parsed, reset=False):
    """对汇总清单做匹配。先查持久关联（非空=已指定；空串=留白），再模糊。

    reset=True 时清空全部关联后重新纯自动匹配。
    """
    if reset:
        save_links({})
    lib_files = list_lib_files()
    links = load_links()
    for a in parsed.get("summary", []):
        name = a["name"]
        matched = False
        path = ""
        file = ""
        score = 0
        if name in links:
            value = links[name]
            if value and os.path.isfile(value):
                matched = True
                path = value
                file = os.path.basename(value)
                score = 100
            # value 为空串 => 用户已「留白」，保持未匹配，不参与模糊
        else:
            best, bs = _best_match(name, lib_files)
            if best and bs >= 60:
                matched = True
                path = best["path"]
                file = os.path.basename(path)
                score = bs
        a["matched"] = matched
        a["path"] = path if matched else None
        a["file"] = file
        a["score"] = score
    parsed["lib_count"] = len(lib_files)
    return parsed


def set_link(name, path):
    """手动指定 / 修改某资产对应的图片路径。path 为空表示「留白」（跳过该图，保持未匹配）。"""
    links = load_links()
    links[name] = path or ""
    save_links(links)
    return {"ok": True}


def clear_link(name):
    return set_link(name, "")
