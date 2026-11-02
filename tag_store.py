"""词库文件的读写与批量导入 / 导出。

词库（library）是一份纯 JSON 文件，三级结构::

    {
      "name": "Danbooru 基础",
      "version": 1,
      "updated_at": "2025-01-01T00:00:00",
      "groups": [                          # 一级分类
        {
          "name": "人物",
          "subs": [                        # 二级分类
            {"name": "发色", "tags": ["red_hair", "blue_hair"]}   # 子项 tag
          ]
        }
      ]
    }

本模块不依赖任何第三方库，也不依赖 ComfyUI（只有找用户目录时会尝试导入
folder_paths），方便单独做单元测试。
"""

from __future__ import annotations

import json
import os
import re
import time

PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
# 内置词库目录（可用环境变量指到别处，测试时会指到临时目录）
BUILTIN_DIR = os.environ.get("PROMPT_TAG_BUILTIN_DIR") or os.path.join(PACKAGE_DIR, "builtin_tags")

DEFAULT_GROUP = "未分类"
DEFAULT_SUB = "默认"

MAX_NAME_LEN = 64
_FORBIDDEN_CHARS = set('<>:"/\\|?*\0')

_USER_DIR_CACHE = None

# ---------------------------------------------------------------------------
# 路径 / 名称
# ---------------------------------------------------------------------------


def get_user_dir() -> str:
    """用户词库目录（可写）。

    优先级：
      1. 环境变量 ``PROMPT_TAG_USER_DIR``（自定义/测试用）
      2. ``ComfyUI/user/prompt_tag_manager``
      3. 插件目录下的 ``user_tags``（兜底）
    """
    global _USER_DIR_CACHE
    if _USER_DIR_CACHE and os.path.isdir(_USER_DIR_CACHE):
        return _USER_DIR_CACHE

    base = None
    env_dir = os.environ.get("PROMPT_TAG_USER_DIR")
    if env_dir:
        base = env_dir
    else:
        try:  # pragma: no cover - 依赖 ComfyUI 运行环境
            import folder_paths  # type: ignore

            fn = getattr(folder_paths, "get_user_directory", None)
            if callable(fn):
                base = fn()
        except Exception:
            base = None

    if base:
        base = os.path.join(base, "prompt_tag_manager") if not env_dir else base
    else:
        base = os.path.join(PACKAGE_DIR, "user_tags")

    try:
        os.makedirs(base, exist_ok=True)
    except Exception:
        base = os.path.join(PACKAGE_DIR, "user_tags")
        os.makedirs(base, exist_ok=True)

    _USER_DIR_CACHE = base
    return base


def sanitize_name(name, fallback: str = "新词库") -> str:
    """清洗词库名：去掉路径分隔符等非法字符，防止目录穿越。"""
    name = (name or "").strip()
    cleaned = []
    for ch in name:
        if ch in _FORBIDDEN_CHARS or ord(ch) < 32:
            continue
        cleaned.append(ch)
    name = "".join(cleaned).strip().strip(".").strip()
    if not name:
        name = fallback
    return name[:MAX_NAME_LEN]


def _lib_path(name: str, kind: str = "user") -> str:
    base = get_user_dir() if kind == "user" else BUILTIN_DIR
    return os.path.join(base, sanitize_name(name) + ".json")


# ---------------------------------------------------------------------------
# 规范化
# ---------------------------------------------------------------------------


_INVISIBLE_CHARS = re.compile(r"[\u200b-\u200f\u202a-\u202e\ufeff\u00ad]")


def _clean_tag(tag) -> str:
    """把一个子项规整成字符串（兼容 {"text": ...} / {"tag": ...} 之类的写法）。"""
    if isinstance(tag, dict):
        for key in ("text", "tag", "name", "value", "label"):
            if key in tag and isinstance(tag[key], str):
                tag = tag[key]
                break
        else:
            tag = ""
    if not isinstance(tag, str):
        tag = "" if tag is None else str(tag)
    tag = tag.replace("\r", " ").replace("\n", " ")
    # 零宽空格 / BOM / 软连字符等不可见字符会让 tag 静默失效，直接清掉
    tag = _INVISIBLE_CHARS.sub("", tag)
    tag = re.sub(r"\s+", " ", tag)
    return tag.strip()


def _dedupe_tags(tags) -> list:
    out, seen = [], set()
    for t in tags:
        tag = _clean_tag(t)
        if not tag:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(tag)
    return out


def _collect_tags(raw, descs=None):
    """把 tag 列表规整成 (文本列表, 描述字典)。

    tag 可以写成字符串，也可以写成 {"text": "tapir_girl", "desc": "貘娘"}。
    """
    found = {}
    texts = []
    for item in _as_tag_list(raw):
        text = _clean_tag(item)
        if isinstance(item, dict):
            desc = item.get("desc") or item.get("description") or item.get("中文") or item.get("note")
            if isinstance(desc, str) and text and desc.strip():
                found[text] = desc.strip()
        if text:
            texts.append(text)

    if isinstance(descs, dict):
        for key, value in descs.items():
            text = _clean_tag(key)
            if text and isinstance(value, str) and value.strip():
                found.setdefault(text, value.strip())

    return _dedupe_tags(texts), found


def empty_library(name: str = "默认词库") -> dict:
    return {
        "name": sanitize_name(name, "默认词库"),
        "version": 1,
        "updated_at": _now(),
        "groups": [],
    }


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def normalize_library(raw, name=None) -> dict:
    """把各种可能的原始结构统一成标准词库结构。

    支持：
      * 标准结构                 {"groups": [{"name", "subs": [{"name", "tags"}]}]}
      * 简写嵌套字典             {"人物": {"发色": ["red_hair"]}}
      * 两个层级的嵌套字典        {"发色": ["red_hair"]}
      * 扁平三元组列表           [{"group": "人物", "sub": "发色", "tag": "red_hair"}]
      * 三元组数组列表           [["人物", "发色", "red_hair"]]
      * 纯字符串列表             ["red_hair", "blue_hair"]
      * WeiLin 风格              {"groups": [{"name": "人物", "tags": [{"text": "..."}]}]}
    """
    lib_name = sanitize_name(name or "", "")

    if isinstance(raw, dict):
        if "groups" in raw and isinstance(raw["groups"], list):
            lib_name = lib_name or _clean_tag(raw.get("name")) or ""
            groups = _normalize_groups(raw["groups"])
        elif "tags" in raw and isinstance(raw.get("tags"), list):
            # {"name": "xx", "tags": [...]} 单分类词库
            grp = _clean_tag(raw.get("name")) or DEFAULT_GROUP
            groups = _normalize_groups(
                [{"name": grp, "tags": raw["tags"]}]
            )
        else:
            groups = _normalize_mapping(raw)
    elif isinstance(raw, list):
        groups = _normalize_list(raw)
    elif isinstance(raw, str):
        return parse_text(raw, name=lib_name)
    else:
        groups = []

    # 清掉指向已不存在 tag 的描述
    for group in groups:
        for sub in group.get("subs") or []:
            _prune_descs(sub)

    lib = {
        "name": lib_name or "导入词库",
        "version": 1,
        "updated_at": _now(),
        "groups": groups,
    }
    return lib


def _normalize_mapping(mapping: dict) -> list:
    """{一级: {二级: [tags]}} 或 {二级: [tags]} 形态。"""
    out = []
    index: dict = {}
    for gname, gval in mapping.items():
        gname_s = _clean_tag(gname) or DEFAULT_GROUP
        target = index.get(gname_s)
        if target is None:
            target = {"name": gname_s, "subs": []}
            index[gname_s] = target
            out.append(target)
        if isinstance(gval, dict):
            for sname, sval in gval.items():
                _add_sub(target, _clean_tag(sname) or DEFAULT_SUB, _as_tag_list(sval))
        else:
            _add_sub(target, DEFAULT_SUB, _as_tag_list(gval))
    return out


def _as_tag_list(value) -> list:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [value]
    if isinstance(value, (list, tuple, set)):
        return list(value)
    return [value]


def _normalize_list(items: list) -> list:
    """[{group, sub, tag}] / [[g, s, t]] / ["tag"] 形态。"""
    out = []
    index: dict = {}

    def target_for(gname):
        target = index.get(gname)
        if target is None:
            target = {"name": gname, "subs": []}
            index[gname] = target
            out.append(target)
        return target

    for item in items:
        if isinstance(item, dict):
            gname = _clean_tag(
                item.get("group") or item.get("category") or item.get("一级")
                or item.get("primary") or ""
            ) or DEFAULT_GROUP
            sname = _clean_tag(
                item.get("sub") or item.get("subgroup") or item.get("二级")
                or item.get("secondary") or ""
            ) or DEFAULT_SUB
            tags = item.get("tags") or item.get("tag") or item.get("text") or []
            _add_sub(target_for(gname), sname, _as_tag_list(tags), item.get("descs"))
        elif isinstance(item, (list, tuple)):
            parts = [_clean_tag(p) for p in item]
            parts = [p for p in parts if p]
            if not parts:
                continue
            if len(parts) >= 3:
                gname, sname, tags = parts[0], parts[1], parts[2:]
            elif len(parts) == 2:
                gname, sname, tags = parts[0], DEFAULT_SUB, [parts[1]]
            else:
                gname, sname, tags = DEFAULT_GROUP, DEFAULT_SUB, [parts[0]]
            _add_sub(target_for(gname), sname, tags)
        else:
            tag = _clean_tag(item)
            if tag:
                _add_sub(target_for(DEFAULT_GROUP), DEFAULT_SUB, [tag])

    return [g for g in out if g["subs"]]


def _normalize_groups(groups) -> list:
    out = []
    group_seen: dict = {}

    for g in groups:
        if isinstance(g, str):
            g = {"name": g}
        if not isinstance(g, dict):
            continue
        gname = _clean_tag(g.get("name") or g.get("group") or g.get("title")) or DEFAULT_GROUP

        # 同名一级分类合并
        if gname in group_seen:
            target = group_seen[gname]
        else:
            target = {"name": gname, "subs": []}
            group_seen[gname] = target
            out.append(target)

        raw_subs = g.get("subs") or g.get("groups") or g.get("children") or g.get("subgroups")
        direct_tags = g.get("tags") or g.get("items") or g.get("children_tags")

        if isinstance(raw_subs, dict):
            for sname, sval in raw_subs.items():
                _add_sub(target, _clean_tag(sname) or DEFAULT_SUB, _as_tag_list(sval))
        elif isinstance(raw_subs, list) and raw_subs:
            for sg in raw_subs:
                if isinstance(sg, str):
                    _add_sub(target, sg, [])
                elif isinstance(sg, dict):
                    sname = _clean_tag(sg.get("name") or sg.get("sub") or sg.get("title"))
                    tags = sg.get("tags") or sg.get("items") or []
                    _add_sub(target, sname or DEFAULT_SUB, _as_tag_list(tags), sg.get("descs"))
        elif raw_subs is None and direct_tags is not None:
            _add_sub(target, DEFAULT_SUB, _as_tag_list(direct_tags), g.get("descs"))

        if direct_tags is not None and raw_subs is not None:
            # 一级分类上直接挂着 tag 的情况，塞进「默认」二级分类
            _add_sub(target, DEFAULT_SUB, _as_tag_list(direct_tags), g.get("descs"))

    return [g for g in out if g["subs"]]


def _add_sub(group: dict, sname: str, tags, descs=None) -> None:
    sname = sname or DEFAULT_SUB
    texts, found = _collect_tags(tags, descs)

    merged = dict(found)
    if isinstance(descs, dict):
        for key, value in descs.items():
            text = _clean_tag(key)
            if text and isinstance(value, str) and value.strip():
                merged.setdefault(text, value.strip())

    for sub in group["subs"]:
        if sub["name"] == sname:
            sub["tags"] = _dedupe_tags(list(sub["tags"]) + texts)
            if merged:
                existing = sub.get("descs")
                if not isinstance(existing, dict):
                    existing = {}
                    sub["descs"] = existing
                for key, value in merged.items():
                    existing.setdefault(key, value)
            return

    entry = {"name": sname, "tags": texts}
    if merged:
        entry["descs"] = merged
    group["subs"].append(entry)


def _prune_descs(sub: dict) -> dict:
    """只保留确实存在的 tag 的描述，避免文件里出现无用数据。"""
    descs = sub.get("descs")
    if not isinstance(descs, dict) or not descs:
        sub.pop("descs", None)
        return sub
    index = {t.lower(): t for t in sub.get("tags") or []}
    keep = {}
    for key, value in descs.items():
        real = index.get(str(key).lower())
        if real and isinstance(value, str) and value.strip():
            keep[real] = value.strip()
    if keep:
        sub["descs"] = keep
    else:
        sub.pop("descs", None)
    return sub


def library_counts(lib: dict) -> dict:
    groups = lib.get("groups") or []
    subs = 0
    tags = 0
    for g in groups:
        for s in g.get("subs") or []:
            subs += 1
            tags += len(s.get("tags") or [])
    return {"groups": len(groups), "subs": subs, "tags": tags}


# ---------------------------------------------------------------------------
# 文本 / CSV / TXT 解析
# ---------------------------------------------------------------------------

_DELIMITERS = ["\t", ",", "，", "|", "｜", "::", "：", " > ", "＞", ">", " / ", "/"]

_HEADER_WORDS = {
    "一级", "一级分类", "分类", "大类", "group", "category", "primary", "主分类",
    "二级", "二级分类", "子分类", "sub", "subgroup", "secondary", "小类",
    "子项", "标签", "tag", "tags", "item", "items", "关键词", "keyword", "keywords",
    "内容", "描述", "desc", "description", "weight", "权重",
}


def _detect_delimiter(line: str):
    for d in _DELIMITERS:
        if d in line:
            return d
    return None


def _split_line(line: str, delimiter) -> list:
    if not delimiter:
        return [line]
    return [p.strip() for p in line.split(delimiter)]


def _looks_like_header(parts: list) -> bool:
    parts = [p.strip().strip('"').strip().lower() for p in parts if p and p.strip()]
    if not parts or len(parts) < 2:
        return False
    return all(p in _HEADER_WORDS for p in parts)


def parse_text(content: str, filename: str = "", name: str = None) -> dict:
    """解析 CSV / TXT / JSON / SQL(WeiLin 导出) 文本内容为词库结构。"""
    if content is None:
        content = ""
    text = content.replace("\ufeff", "")
    stem = ""
    if filename:
        stem = os.path.splitext(os.path.basename(filename))[0]
    lib_name = sanitize_name(name or stem or "导入词库", "导入词库")

    stripped = text.strip()
    if stripped[:1] in "{[":
        try:
            data = json.loads(stripped)
            return normalize_library(data, name=lib_name)
        except Exception:
            if (filename or "").lower().endswith(".json"):
                raise ValueError("JSON 解析失败，请检查文件是否为合法 JSON")
    elif (filename or "").lower().endswith(".json"):
        raise ValueError("文件内容看起来不是 JSON")

    if looks_like_sql(text):
        return parse_sql(text, name=lib_name)
    if (filename or "").lower().endswith(".sql"):
        raise ValueError("没有在 SQL 文件里找到 tag_groups / tag_subgroups / tag_tags 的 INSERT 语句")

    return _parse_lines(text, lib_name)


# ---------------------------------------------------------------------------
# WeiLin-Comfyui-Tools 的 SQLite 导出（.sql）解析
# ---------------------------------------------------------------------------

_SQL_INSERT_RE = re.compile(
    r"^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(.+?)\s*\((.*?)\)\s*VALUES",
    re.IGNORECASE | re.DOTALL,
)

_SQL_TABLES = {"tag_groups", "tag_subgroups", "tag_tags"}


def looks_like_sql(text: str) -> bool:
    """粗略判断一段文本是不是 SQL INSERT 脚本。"""
    head = (text or "")[:4000].upper()
    if "INSERT" not in head:
        return False
    return ("TAG_GROUPS" in head) or ("TAG_SUBGROUPS" in head) or ("TAG_TAGS" in head)


def _split_sql_statements(text: str) -> list:
    """按分号切语句，忽略字符串里的分号。"""
    out, buf = [], []
    i, n = 0, len(text)
    in_str = False
    while i < n:
        ch = text[i]
        if in_str:
            buf.append(ch)
            if ch == "'":
                if i + 1 < n and text[i + 1] == "'":
                    buf.append("'")
                    i += 2
                    continue
                in_str = False
            i += 1
            continue
        if ch == "'":
            in_str = True
            buf.append(ch)
        elif ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
        else:
            buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out


def _parse_sql_value_rows(text: str) -> list:
    """解析 VALUES 后面的一串 (..),(..) 元组。"""
    rows = []
    i, n = 0, len(text)
    while i < n:
        while i < n and text[i] in " \t\r\n,":
            i += 1
        if i >= n or text[i] != "(":
            break
        i += 1
        row, cur = [], []
        in_str = False
        while i < n:
            ch = text[i]
            if in_str:
                if ch == "'":
                    if i + 1 < n and text[i + 1] == "'":
                        cur.append("'")
                        i += 2
                        continue
                    in_str = False
                    i += 1
                    continue
                cur.append(ch)
                i += 1
                continue
            if ch == "'":
                in_str = True
                i += 1
                continue
            if ch == ",":
                row.append("".join(cur))
                cur = []
                i += 1
                continue
            if ch == ")":
                row.append("".join(cur))
                i += 1
                break
            cur.append(ch)
            i += 1
        rows.append([v.strip() for v in row])
    return rows


def _sql_rows(text: str):
    """依次产出 (表名, 列名列表, 行数据)。"""
    for stmt in _split_sql_statements(text):
        m = _SQL_INSERT_RE.match(stmt)
        if not m:
            continue
        table = m.group(1).strip().strip('"\'`[]').strip()
        table = table.split(".")[-1].strip('"\'`[]').strip().lower()
        cols = [c.strip().strip('"\'`[]').strip().lower() for c in m.group(2).split(",")]
        values_part = stmt[m.end():]
        for row in _parse_sql_value_rows(values_part):
            if len(row) < len(cols):
                row = row + [""] * (len(cols) - len(row))
            yield table, cols, dict(zip(cols, row))


def _as_time(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def parse_sql(text: str, name: str = "导入词库") -> dict:
    """把 WeiLin 导出的 .sql 解析成三级词库。

    * tag_groups     一级分类（p_uuid 唯一标识）
    * tag_subgroups  二级分类（p_uuid → 一级分类，g_uuid 唯一标识）
    * tag_tags       子项（g_uuid → 二级分类），desc 作为中文描述保留
    """
    return _assemble_sql(_sql_rows(text), name, require_table=True)


def _sql_rows_from_file(path: str):
    """流式读取 .sql 文件：一行一条 INSERT（WeiLin 导出如此），内存占用恒定。

    也兼容跨行的 INSERT：缓冲到行尾出现 ``);`` 才提交。
    """
    buf = []
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            buf.append(line)
            if line.rstrip().endswith(");"):
                for item in _sql_rows("".join(buf)):
                    yield item
                buf = []
    tail = "".join(buf).strip()
    if tail:
        for item in _sql_rows(tail):
            yield item


def parse_sql_file(path: str, name: str = None) -> dict:
    """从磁盘上的 .sql 直接解析（适合几十上百 MB 的导出文件）。"""
    if not os.path.isfile(path):
        raise FileNotFoundError("文件不存在: %s" % path)
    stem = os.path.splitext(os.path.basename(path))[0]
    lib_name = sanitize_name(name or stem or "导入词库", "导入词库")
    return _assemble_sql(_sql_rows_from_file(path), lib_name, require_table=True)


def parse_file(path: str, name: str = None) -> dict:
    """按扩展名从磁盘读取并解析词库（.sql / .json / .csv / .txt / .tsv）。"""
    if not os.path.isfile(path):
        raise FileNotFoundError("文件不存在: %s" % path)
    lower = path.lower()
    stem = os.path.splitext(os.path.basename(path))[0]
    lib_name = sanitize_name(name or stem or "导入词库", "导入词库")

    if lower.endswith(".sql"):
        return parse_sql_file(path, lib_name)
    if lower.endswith(".json"):
        return normalize_library(_read_json(path), name=lib_name)
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        content = f.read()
    return parse_text(content, filename=os.path.basename(path), name=lib_name)


def _assemble_sql(row_iter, name: str, require_table: bool = True) -> dict:
    """把 (表名, 列名, 行) 序列装配成三级词库。"""
    groups = {}   # p_uuid -> {name, time}
    subs = {}     # g_uuid -> {name, group_uuid, time}
    tags = []     # {text, desc, sub_uuid, time}
    seen_tables = set()

    for table, _cols, rec in row_iter:
        if table not in _SQL_TABLES:
            continue
        seen_tables.add(table)
        if table == "tag_groups":
            uid = _clean_tag(rec.get("p_uuid"))
            if not uid:
                continue
            groups[uid] = {"name": _clean_tag(rec.get("name")), "time": _as_time(rec.get("create_time"))}
        elif table == "tag_subgroups":
            uid = _clean_tag(rec.get("g_uuid"))
            if not uid:
                continue
            subs[uid] = {
                "name": _clean_tag(rec.get("name")),
                "group_uuid": _clean_tag(rec.get("p_uuid")),
                "time": _as_time(rec.get("create_time")),
            }
        else:
            text_value = _clean_tag(rec.get("text"))
            if not text_value:
                continue
            tags.append(
                {
                    "text": text_value,
                    "desc": _clean_tag(rec.get("desc")),
                    "sub_uuid": _clean_tag(rec.get("g_uuid")),
                    "time": _as_time(rec.get("create_time")),
                }
            )

    if require_table and not seen_tables:
        raise ValueError("SQL 里没有找到 tag_groups / tag_subgroups / tag_tags 表")

    # 组顺序：创建时间升序（与 WeiLin 面板一致）
    order_groups = sorted(groups.items(), key=lambda kv: (kv[1]["time"], kv[1]["name"]))
    order_subs = {}
    for sub_uuid, info in subs.items():
        order_subs.setdefault(info["group_uuid"], []).append((sub_uuid, info))
    for key in order_subs:
        order_subs[key].sort(key=lambda kv: (kv[1]["time"], kv[1]["name"]))

    tags_by_sub = {}
    for item in tags:
        tags_by_sub.setdefault(item["sub_uuid"], []).append(item)
    for key in tags_by_sub:
        # tag 顺序：创建时间倒序（WeiLin 里最新的在前）
        tags_by_sub[key].sort(key=lambda t: (-t["time"], t["text"]))

    out_groups = []
    for group_uuid, info in order_groups:
        group = {"name": info["name"] or DEFAULT_GROUP, "subs": []}
        for sub_uuid, sub_info in order_subs.get(group_uuid, []):
            texts = [t["text"] for t in tags_by_sub.get(sub_uuid, [])]
            descs = {t["text"]: t["desc"] for t in tags_by_sub.get(sub_uuid, []) if t["desc"]}
            _add_sub(group, sub_info["name"] or DEFAULT_SUB, texts, descs)
        if group["subs"]:
            out_groups.append(group)

    # 找不到父节点的孤立数据也别丢
    orphans = [(u, info) for u, info in subs.items() if info["group_uuid"] not in groups]
    if orphans:
        orphan_group = {"name": DEFAULT_GROUP, "subs": []}
        for sub_uuid, sub_info in orphans:
            texts = [t["text"] for t in tags_by_sub.get(sub_uuid, [])]
            descs = {t["text"]: t["desc"] for t in tags_by_sub.get(sub_uuid, []) if t["desc"]}
            _add_sub(orphan_group, sub_info["name"] or DEFAULT_SUB, texts, descs)
        if orphan_group["subs"]:
            out_groups.append(orphan_group)

    if not out_groups:
        raise ValueError("SQL 解析完成，但没有任何 tag 数据")

    return {
        "name": sanitize_name(name, "导入词库"),
        "version": 1,
        "updated_at": _now(),
        "groups": [_prune_descs_subtree(g) for g in out_groups],
    }


def _prune_descs_subtree(group: dict) -> dict:
    for sub in group.get("subs") or []:
        _prune_descs(sub)
    return group



def _parse_lines(text: str, lib_name: str) -> dict:
    groups: dict = {}
    descs_map: dict = {}
    order: list = []
    state = {"group": DEFAULT_GROUP, "sub": DEFAULT_SUB}
    delimiter = None
    first_data_line = True

    def bucket(gname, sname):
        if gname not in groups:
            groups[gname] = {}
            order.append(gname)
        return groups[gname].setdefault(sname, [])

    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        if not line.strip():
            continue
        stripped = line.strip()

        # Markdown 风格的标题：# 一级分类 / ## 二级分类
        if stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            title = stripped.lstrip("#").strip()
            if not title:
                continue
            if level <= 1:
                state["group"] = title
                state["sub"] = DEFAULT_SUB
            else:
                state["sub"] = title
            continue

        if delimiter is None:
            delimiter = _detect_delimiter(stripped)

        parts = [p for p in _split_line(stripped, delimiter) if p != ""]
        if not parts:
            continue

        if first_data_line and _looks_like_header(parts):
            first_data_line = False
            continue
        first_data_line = False

        desc = ""
        if len(parts) >= 4:
            gname, sname, tag, desc = parts[0], parts[1], parts[2], parts[3]
        elif len(parts) == 3:
            gname, sname, tag = parts[0], parts[1], parts[2]
        elif len(parts) == 2:
            gname, sname, tag = parts[0], DEFAULT_SUB, parts[1]
        else:
            gname, sname, tag = state["group"], state["sub"], parts[0]

        gname = gname or DEFAULT_GROUP
        sname = sname or DEFAULT_SUB
        tag = _clean_tag(tag)
        if not tag:
            continue
        lst = bucket(gname, sname)
        if tag.lower() not in {t.lower() for t in lst}:
            lst.append(tag)
        desc = _clean_tag(desc)
        if desc:
            descs_map[(gname, sname, tag.lower())] = desc

    out_groups = []
    for g in order:
        subs = []
        for s in groups[g]:
            entry = {"name": s, "tags": groups[g][s]}
            descs = {
                tag: descs_map[(g, s, tag.lower())]
                for tag in groups[g][s]
                if (g, s, tag.lower()) in descs_map
            }
            if descs:
                entry["descs"] = descs
            subs.append(entry)
        out_groups.append({"name": g, "subs": subs})

    return {
        "name": lib_name,
        "version": 1,
        "updated_at": _now(),
        "groups": out_groups,
    }


# ---------------------------------------------------------------------------
# 词库文件 CRUD
# ---------------------------------------------------------------------------

_INDEX_FILENAME = ".ptm_index.json"
_index_memo = {}


def _quick_counts(raw):
    """不跑完整规范化，直接从原始 JSON 数数量（几 MB 的词库也能毫秒级）。"""
    if isinstance(raw, dict) and isinstance(raw.get("groups"), list):
        groups = raw["groups"]
        subs = 0
        tags = 0
        ok = True
        for g in groups:
            if not isinstance(g, dict):
                ok = False
                break
            sg = g.get("subs")
            if not isinstance(sg, list):
                ok = False
                break
            subs += len(sg)
            for s in sg:
                if isinstance(s, dict) and isinstance(s.get("tags"), list):
                    tags += len(s["tags"])
                else:
                    ok = False
                    break
            if not ok:
                break
        if ok:
            name = raw.get("name")
            return {
                "counts": {"groups": len(groups), "subs": subs, "tags": tags},
                "display_name": name if isinstance(name, str) and name else None,
            }
    lib = normalize_library(raw)
    return {"counts": library_counts(lib), "display_name": lib.get("name") or None}


def _read_index(dir_path):
    """目录级索引：{文件名: {size, mtime, groups, subs, tags, display_name}}"""
    memo = _index_memo.get(dir_path)
    if memo is not None:
        return memo
    path = os.path.join(dir_path, _INDEX_FILENAME)
    data = {}
    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                data = loaded
    except Exception:
        data = {}
    _index_memo[dir_path] = data
    return data


def _write_index(dir_path, index):
    _index_memo[dir_path] = index
    try:
        os.makedirs(dir_path, exist_ok=True)
        with open(os.path.join(dir_path, _INDEX_FILENAME), "w", encoding="utf-8", newline="\n") as f:
            json.dump(index, f, ensure_ascii=False)
    except Exception:
        pass


def _invalidate_index_entry(dir_path, filename):
    index = _read_index(dir_path)
    if filename in index:
        del index[filename]
        _write_index(dir_path, index)


def _entry_for(dir_path, filename, kind):
    """读取（并缓存）单个词库文件的统计信息。"""
    path = os.path.join(dir_path, filename)
    try:
        stat = os.stat(path)
    except OSError as exc:
        return {"error": str(exc), "counts": {"groups": 0, "subs": 0, "tags": 0}}
    size = int(stat.st_size)
    mtime = int(stat.st_mtime)

    index = _read_index(dir_path)
    cached = index.get(filename)
    if (
        isinstance(cached, dict)
        and cached.get("size") == size
        and cached.get("mtime") == mtime
        and "counts" not in cached
        and "groups" in cached
    ):
        return {
            "counts": {
                "groups": cached.get("groups", 0),
                "subs": cached.get("subs", 0),
                "tags": cached.get("tags", 0),
            },
            "display_name": cached.get("display_name") or None,
        }

    try:
        raw = _read_json(path)
        info = _quick_counts(raw)
    except Exception as exc:
        info = {"error": str(exc), "counts": {"groups": 0, "subs": 0, "tags": 0}, "display_name": None}

    index[filename] = {
        "size": size,
        "mtime": mtime,
        "groups": info["counts"]["groups"],
        "subs": info["counts"]["subs"],
        "tags": info["counts"]["tags"],
        "display_name": info.get("display_name"),
        "error": info.get("error"),
    }
    return info


def _read_json(path: str):
    with open(path, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def _write_json(path: str, data) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    dir_path = os.path.dirname(path)
    _invalidate_index_entry(dir_path, os.path.basename(path))


def list_libraries() -> list:
    """列出内置 + 用户词库。用户词库优先（同名覆盖内置，记为「影子覆盖」）。

    统计数量走目录索引缓存，几 MB 的大词库也只需要第一次解析。
    """
    result = {}
    dirty_dirs = []

    for base, kind in ((BUILTIN_DIR, "builtin"), (get_user_dir(), "user")):
        if not os.path.isdir(base):
            continue
        before = dict(_read_index(base))
        for fname in sorted(os.listdir(base)):
            if not fname.lower().endswith(".json"):
                continue
            if fname.startswith("."):  # 跳过索引等隐藏文件
                continue
            name = os.path.splitext(fname)[0]
            info = _entry_for(base, fname, kind)
            entry = {
                "name": name,
                "kind": kind,
                "file": fname,
                "counts": info.get("counts") or {"groups": 0, "subs": 0, "tags": 0},
                "display_name": info.get("display_name") or name,
            }
            if info.get("error"):
                entry["error"] = info["error"]
            result[name] = entry
        if _read_index(base) != before:
            dirty_dirs.append(base)

    for base in dirty_dirs:
        _write_index(base, _read_index(base))

    # 用户词库优先
    ordered = [v for v in result.values() if v["kind"] == "user"] + [
        v for v in result.values() if v["kind"] != "user"
    ]
    ordered.sort(key=lambda x: (x["kind"] != "user", x["name"]))
    return ordered


def library_exists(name: str) -> bool:
    return os.path.isfile(_lib_path(name, "user")) or os.path.isfile(_lib_path(name, "builtin"))


_LIB_READ_CACHE = {}  # name -> (stamp, lib)


def load_library_cached(name: str):
    """读词库并缓存（按文件 mtime+size 失效）。

    节点执行时用来解析「随机池引用」，避免每次执行都重读几十 MB 的文件。
    """
    key = sanitize_name(name, "")
    for kind in ("user", "builtin"):
        path = _lib_path(key, kind)
        if not os.path.isfile(path):
            continue
        try:
            stat = os.stat(path)
            stamp = (kind, int(stat.st_mtime), int(stat.st_size))
        except OSError:
            stamp = None
        cached = _LIB_READ_CACHE.get(key)
        if cached and stamp and cached[0] == stamp:
            return cached[1]
        lib = load_library(key)[0]
        if stamp:
            _LIB_READ_CACHE[key] = (stamp, lib)
        return lib
    raise FileNotFoundError("词库不存在: %s" % name)


def library_sub_tags(library: str, group: str = None, sub: str = None) -> list:
    """取某个二级分类（或整个一级分类）下的全部 tag。

    ``sub`` 传 ``"*"`` 表示该一级分类下的全部 tag。
    """
    lib = load_library_cached(library)
    out = []
    for g in lib.get("groups") or []:
        if group and g.get("name") != group:
            continue
        for s in g.get("subs") or []:
            if sub and sub != "*" and s.get("name") != sub:
                continue
            out.extend(s.get("tags") or [])
    return out


def load_library(name: str):
    """返回 (词库 dict, kind)。找不到时抛 FileNotFoundError。"""
    for kind in ("user", "builtin"):
        path = _lib_path(name, kind)
        if os.path.isfile(path):
            raw = _read_json(path)
            lib = normalize_library(raw, name=name)
            if not lib.get("name"):
                lib["name"] = sanitize_name(name)
            return lib, kind
    raise FileNotFoundError("词库不存在: %s" % name)


DEFAULT_LIBRARY_NAME = "renwu"  # 内置默认词库（人物 1612 tag）
ENV_DEFAULT_LIBRARY = "PROMPT_TAG_DEFAULT_LIBRARY"

# ---------------------------------------------------------------------------
# 运行设置（HTTP 接口开关）
# ---------------------------------------------------------------------------

SETTINGS_FILENAME = ".settings.json"
ENV_HTTP = "PROMPT_TAG_HTTP"
CUSTOM_DESC_FILENAME = ".custom_descs.json"


def _settings_path() -> str:
    return os.path.join(get_user_dir(), SETTINGS_FILENAME)


def read_settings() -> dict:
    path = _settings_path()
    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def write_settings(patch: dict) -> dict:
    data = read_settings()
    if isinstance(patch, dict):
        data.update(patch)
    try:
        os.makedirs(os.path.dirname(_settings_path()), exist_ok=True)
        with open(_settings_path(), "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
    except Exception as exc:
        print("[PromptTag] 设置写入失败：%s" % exc)
    return data


def env_http_override():
    """环境变量强制开关：返回 True / False / None（未设置）。"""
    raw = os.environ.get(ENV_HTTP)
    if raw is None:
        return None
    return raw.strip().lower() not in ("0", "false", "no", "off", "disabled", "")


def is_http_enabled() -> bool:
    """HTTP 接口是否开启（**默认开启**，可在面板里关掉，也支持环境变量强制）。"""
    forced = env_http_override()
    if forced is not None:
        return forced
    return bool(read_settings().get("http_enabled", True))


def set_http_enabled(value) -> bool:
    """手动开关 HTTP 接口，写入设置文件（返回最终状态）。"""
    enabled = bool(value)
    write_settings({"http_enabled": enabled})
    return is_http_enabled()


# ---------------------------------------------------------------------------
# 自定义翻译（不挂在词库里的文本也能存译文）
# ---------------------------------------------------------------------------

_custom_desc_cache = {"stamp": None, "data": {}}
CUSTOM_DESC_LIMIT = 50000


def _custom_desc_path() -> str:
    return os.path.join(get_user_dir(), CUSTOM_DESC_FILENAME)


def load_custom_descs() -> dict:
    """读取本地自定义翻译：{原文: 译文}"""
    path = _custom_desc_path()
    try:
        stat = os.stat(path)
        stamp = (int(stat.st_mtime), int(stat.st_size))
    except OSError:
        _custom_desc_cache["stamp"] = None
        _custom_desc_cache["data"] = {}
        return {}

    if _custom_desc_cache["stamp"] == stamp:
        return _custom_desc_cache["data"]

    data = {}
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            for key, value in loaded.items():
                text = _clean_tag(key)
                desc = value.strip() if isinstance(value, str) else ""
                if text and desc:
                    data[text] = desc
    except Exception as exc:
        print("[PromptTag] 读取自定义翻译失败：%s" % exc)
        data = {}

    _custom_desc_cache["stamp"] = stamp
    _custom_desc_cache["data"] = data
    return data


def save_custom_descs(mapping: dict, remove=()) -> dict:
    """合并写入自定义翻译；``remove`` 里的原文会被删掉。返回最新全量。"""
    data = dict(load_custom_descs())

    for text in remove or []:
        key = _clean_tag(text)
        if key:
            data.pop(key, None)

    for key, value in (mapping or {}).items():
        text = _clean_tag(key)
        if not text:
            continue
        desc = value.strip() if isinstance(value, str) else ""
        if desc:
            data[text] = desc
        else:
            data.pop(text, None)

    if len(data) > CUSTOM_DESC_LIMIT:
        data = dict(list(data.items())[-CUSTOM_DESC_LIMIT:])

    path = _custom_desc_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except Exception as exc:
        print("[PromptTag] 写入自定义翻译失败：%s" % exc)

    _custom_desc_cache["stamp"] = None  # 下次读取时重新取 mtime
    _custom_desc_cache["data"] = data
    return data


def get_default_library_name() -> str:
    """挑默认词库。

    优先级：
      1. 环境变量 ``PROMPT_TAG_DEFAULT_LIBRARY``
      2. ``DEFAULT_LIBRARY_NAME``（内置的「人物」词库）
      3. 内置词库里 tag 最多的那份
      4. 随便一份；都没有就新建空词库
    """
    libs = list_libraries()
    by_name = {}
    for entry in libs:
        by_name[entry["name"]] = entry

    for candidate in (os.environ.get(ENV_DEFAULT_LIBRARY), DEFAULT_LIBRARY_NAME):
        if not candidate:
            continue
        entry = by_name.get(candidate)
        if entry and not entry.get("error"):
            return entry["name"]

    builtin = [x for x in libs if x["kind"] == "builtin" and not x.get("error")]
    if builtin:
        builtin.sort(key=lambda x: (x.get("counts") or {}).get("tags", 0), reverse=True)
        return builtin[0]["name"]
    if libs:
        return libs[0]["name"]
    return save_library("默认词库", empty_library("默认词库"))


def ensure_library(name: str = None) -> dict:
    """确保至少有一份可用词库，返回该词库内容。"""
    if name:
        try:
            return load_library(name)[0]
        except FileNotFoundError:
            pass
    return load_library(get_default_library_name())[0]


def _dir_of(name: str) -> str:
    """词库实际所在的目录：用户目录优先，其次内置目录，都没有则用用户目录（新建）。"""
    if os.path.isfile(os.path.join(get_user_dir(), sanitize_name(name) + ".json")):
        return get_user_dir()
    if os.path.isfile(os.path.join(BUILTIN_DIR, sanitize_name(name) + ".json")):
        return BUILTIN_DIR
    return get_user_dir()


def save_library(name: str, data, overwrite_builtin: bool = True) -> str:
    """保存词库，返回词库名。

    词库在哪就在哪写：内置词库（``builtin_tags/*.json``）会**直接就地修改**，
    不做只读保护，也不会另存副本；你自己新建的词库写在用户目录。
    """
    fixed = sanitize_name(name, "默认词库")
    target_dir = _dir_of(fixed)
    lib = normalize_library(data, name=fixed)
    lib["name"] = fixed
    lib["updated_at"] = _now()
    _write_json(os.path.join(target_dir, fixed + ".json"), lib)
    return fixed


def delete_library(name: str) -> bool:
    """删除词库文件（内置词库同样可以删；删掉后从列表里消失）。"""
    for kind in ("user", "builtin"):
        path = _lib_path(name, kind)
        if os.path.isfile(path):
            os.remove(path)
            _invalidate_index_entry(os.path.dirname(path), os.path.basename(path))
            return True
    return False


def rename_library(name: str, new_name: str) -> str:
    """重命名词库（在它原本所在的目录里改名）。"""
    old = None
    kind_found = None
    for kind in ("user", "builtin"):
        path = _lib_path(name, kind)
        if os.path.isfile(path):
            old = path
            kind_found = kind
            break
    if not old:
        raise FileNotFoundError("词库不存在: %s" % name)

    target = sanitize_name(new_name)
    if target == sanitize_name(name):
        return target
    if library_exists(target):
        raise ValueError("已存在同名词库: %s" % target)

    lib = normalize_library(_read_json(old), name=target)
    lib["name"] = target
    lib["updated_at"] = _now()
    _write_json(os.path.join(os.path.dirname(old), target + ".json"), lib)
    os.remove(old)
    _invalidate_index_entry(os.path.dirname(old), os.path.basename(old))
    return target


# ---------------------------------------------------------------------------
# 合并 / 导入 / 导出
# ---------------------------------------------------------------------------


def merge_library(base: dict, incoming: dict) -> dict:
    """把 incoming 合并进 base（有序并集，tag 去重）。"""
    result = normalize_library(base or {}, name=(base or {}).get("name"))
    inc = normalize_library(incoming or {})

    index = {}
    for g in result["groups"]:
        index[g["name"]] = g

    for g in inc["groups"]:
        target = index.get(g["name"])
        if target is None:
            target = {"name": g["name"], "subs": []}
            index[g["name"]] = target
            result["groups"].append(target)
        for s in g["subs"]:
            _add_sub(target, s["name"], s.get("tags"), s.get("descs"))

    result["updated_at"] = _now()
    return result


def split_library(lib: dict, max_tags: int, name: str = None) -> list:
    """按二级分类整体切分成多份词库（不会把同一个二级分类拆开）。

    适合几十万 tag 的巨型词库：面板一次只加载一份，就不会卡死。
    """
    lib = normalize_library(lib, name=(name or lib.get("name")))
    base = sanitize_name(name or lib.get("name") or "词库", "词库")
    try:
        limit = max(1, int(max_tags))
    except (TypeError, ValueError):
        return [lib]

    parts = []
    cur_groups = []      # [[group_name, subs(list)]]
    cur_count = 0

    def flush():
        nonlocal cur_groups, cur_count
        if not cur_groups:
            return
        parts.append(
            {
                "name": base,
                "version": 1,
                "updated_at": lib.get("updated_at") or _now(),
                "groups": [{"name": gname, "subs": subs} for gname, subs in cur_groups],
            }
        )
        cur_groups = []
        cur_count = 0

    for group in lib["groups"]:
        for sub in group["subs"]:
            size = len(sub.get("tags") or [])
            if cur_count and cur_count + size > limit:
                flush()
            # 同一一级分类要么已存在，要么新起一段
            target = None
            for gname, subs in cur_groups:
                if gname == group["name"]:
                    target = subs
                    break
            if target is None:
                target = []
                cur_groups.append([group["name"], target])
            target.append(sub)
            cur_count += size
    flush()

    if len(parts) <= 1:
        return [lib]

    out = []
    for idx, part in enumerate(parts, 1):
        part["name"] = sanitize_name("%s-%02d" % (base, idx))
        for sub in (s for g in part["groups"] for s in g["subs"]):
            _prune_descs(sub)
        out.append(part)
    return out


def _apply_import(name, incoming: dict, mode: str = "replace", new_name: str = None) -> dict:
    """把已解析好的词库按 replace / merge / new 落盘。"""
    counts = library_counts(incoming)
    if counts["tags"] == 0:
        raise ValueError("没有解析到任何 tag，请检查文件格式")

    mode = (mode or "replace").lower()

    if mode == "new":
        target = new_name or incoming.get("name") or "导入词库"
        saved = save_library(target, incoming)
        return {"mode": mode, "library": saved, "counts": counts, "imported": counts}

    if not name:
        name = get_default_library_name()

    if mode == "merge":
        try:
            base = load_library(name)[0]
        except FileNotFoundError:
            base = empty_library(name)
        merged = merge_library(base, incoming)
    else:
        merged = incoming
        merged["name"] = name

    saved = save_library(name, merged)
    lib = load_library(saved)[0]
    return {"mode": mode, "library": saved, "counts": library_counts(lib), "imported": counts}


def import_path(
    path: str,
    name: str = None,
    mode: str = "new",
    new_name: str = None,
    split: int = 0,
) -> dict:
    """从服务器本地路径导入（大文件推荐走这里，不经过浏览器）。

    split > 0 时按二级分类自动拆成多份词库，返回所有创建出来的词库名。
    """
    lib = parse_file(path, name=new_name or name)
    total = library_counts(lib)
    if total["tags"] == 0:
        raise ValueError("没有解析到任何 tag，请检查文件格式")

    if split and total["tags"] > split:
        parts = split_library(lib, split, name=new_name or name)
        saved = []
        for part in parts:
            saved_name = save_library(part["name"], part)
            saved.append({"name": saved_name, "counts": library_counts(load_library(saved_name)[0])})
        return {
            "mode": "split",
            "split": True,
            "source": os.path.basename(path),
            "libraries": saved,
            "imported": total,
            "counts": {
                "groups": sum(x["counts"]["groups"] for x in saved),
                "subs": sum(x["counts"]["subs"] for x in saved),
                "tags": sum(x["counts"]["tags"] for x in saved),
            },
        }

    result = _apply_import(name, lib, mode=mode, new_name=new_name)
    result["split"] = False
    result["source"] = os.path.basename(path)
    return result


def import_library(
    name: str = None,
    text: str = "",
    filename: str = "",
    mode: str = "replace",
    new_name: str = None,
) -> dict:
    """批量导入（浏览器上传的文本内容）。

    mode:
      * replace —— 覆盖当前词库
      * merge   —— 合并进当前词库
      * new     —— 保存为新词库（new_name 或文件名）
    """
    incoming = parse_text(text, filename=filename, name=new_name or (name if mode == "new" else None))
    return _apply_import(name, incoming, mode=mode, new_name=new_name)


def _csv_escape(value: str) -> str:
    if any(ch in value for ch in [",", '"', "\n", "\r"]):
        return '"' + value.replace('"', '""') + '"'
    return value


def export_library(data, fmt: str = "json") -> dict:
    """导出词库为字符串，返回 {filename, content, mime}。"""
    lib = normalize_library(data, name=(data or {}).get("name") if isinstance(data, dict) else None)
    fmt = (fmt or "json").lower()
    stem = sanitize_name(lib.get("name") or "词库", "词库")

    if fmt == "json":
        return {
            "filename": stem + ".json",
            "content": json.dumps(lib, ensure_ascii=False, indent=2),
            "mime": "application/json",
        }

    if fmt == "csv":
        has_desc = any(
            isinstance(s.get("descs"), dict) and s["descs"] for g in lib["groups"] for s in g["subs"]
        )
        lines = []
        for g in lib["groups"]:
            for s in g["subs"]:
                descs = s.get("descs") if isinstance(s.get("descs"), dict) else {}
                for t in s["tags"]:
                    cells = [_csv_escape(g["name"]), _csv_escape(s["name"]), _csv_escape(t)]
                    if has_desc:
                        cells.append(_csv_escape(descs.get(t, "")))
                    lines.append(",".join(cells))
        return {
            "filename": stem + ".csv",
            "content": "\ufeff" + "\n".join(lines) + "\n",
            "mime": "text/csv",
        }

    if fmt == "txt":
        lines = []
        for g in lib["groups"]:
            lines.append("# " + g["name"])
            for s in g["subs"]:
                lines.append("## " + s["name"])
                lines.extend(s["tags"])
        return {
            "filename": stem + ".txt",
            "content": "\n".join(lines) + "\n",
            "mime": "text/plain",
        }

    raise ValueError("不支持的导出格式: %s" % fmt)


def export_subset(data: dict, group: str = None, sub: str = None) -> dict:
    """导出词库的子集（用于只导出某个一级/二级分类）。"""
    lib = normalize_library(data)
    if not group:
        return lib
    groups = []
    for g in lib["groups"]:
        if g["name"] != group:
            continue
        if not sub:
            groups.append(g)
            continue
        subs = [s for s in g["subs"] if s["name"] == sub]
        if subs:
            groups.append({"name": g["name"], "subs": subs})
    lib["groups"] = groups
    return lib
