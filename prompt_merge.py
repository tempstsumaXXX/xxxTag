"""多路提示词整合的纯函数。

节点执行、提交期提示词抽取都走这里，保证「面板里保存的文本」和
「节点实际输出的文本」使用同一套拼接规则：

* 按 ``prompt``、``prompt_1``、``prompt_2`` … 的序号顺序收集；
* 每段去掉首尾空白，空段直接跳过；
* ``dedupe=True`` 时把每段按逗号 / 换行拆成 tag，完全相同的 tag（忽略大小写）
  只保留第一次出现的位置，其余 tag 仍沿用原来的分隔符排版；
* ``separator`` 支持用 ``\\n`` / ``\\t`` 输入换行、制表符。
"""

from __future__ import annotations

import re

DEFAULT_SEPARATOR = ", "
_NAME_PATTERN = re.compile(r"^prompt(?:_(\d+))?$", re.IGNORECASE)
# 把 tag 之间的分隔符单独切出来（连它两侧的空格一起算作分隔符），重建时才能保留原来的排版
_TAG_SPLIT_PATTERN = re.compile(r"([ \t]*[,\n\r，、;；]+[ \t]*)")
MAX_SEGMENTS = 512


def prompt_slot_index(name) -> int | None:
    """把 ``prompt`` / ``prompt_3`` 转成排序序号；不是提示词输入时返回 ``None``。"""
    if not isinstance(name, str):
        return None
    match = _NAME_PATTERN.match(name)
    if not match:
        return None
    if match.group(1) is None:
        return 0
    return int(match.group(1))


def decode_separator(value) -> str:
    """把单行输入框里常见的转义写法换成真正的控制字符。"""
    if value is None:
        return DEFAULT_SEPARATOR
    if not isinstance(value, str):
        value = str(value)
    return value.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\t", "\t").replace("\\r", "\r")


def is_enabled(value, default: bool = True) -> bool:
    """兼容 API 提交时可能出现的字符串 / 数字布尔值。"""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() not in ("", "0", "false", "no", "off", "none")
    return bool(value)


def _as_texts(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple)):
        texts: list[str] = []
        for item in value:
            texts.extend(_as_texts(item))
        return texts
    return []


def collect_prompts(inputs) -> list[str]:
    """按输入槽位顺序收集非空提示词段（不去重）。"""
    if not isinstance(inputs, dict):
        return []
    ordered: list[tuple[int, int, str]] = []
    for name, value in inputs.items():
        index = prompt_slot_index(name)
        if index is None:
            continue
        for text in _as_texts(value):
            text = text.strip()
            if not text:
                continue
            # 同一个槽位出现多段（极端情况下上游给了列表）时保持原顺序
            ordered.append((index, len(ordered), text))
            if len(ordered) >= MAX_SEGMENTS:
                break
        if len(ordered) >= MAX_SEGMENTS:
            break
    ordered.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in ordered]


def _dedupe_text_tags(text: str, seen: set[str]) -> str:
    """把一段文本按逗号 / 换行拆成 tag，丢掉已经出现过的（忽略大小写）。

    没被丢掉的部分仍沿用原文里的分隔符，所以换行、`，` 之类不会被改成连接符。
    整段都是重复时返回空字符串。
    """
    pieces = _TAG_SPLIT_PATTERN.split(text)
    out: list[str] = []
    pending = ""
    first = True
    for index, piece in enumerate(pieces):
        if index % 2 == 1:
            pending = piece
            continue
        token = piece.strip()
        if not token:
            continue
        key = token.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(("" if first else pending) + token)
        first = False
    return "".join(out).strip()


def join_parts(parts, separator=DEFAULT_SEPARATOR, dedupe: bool = True) -> str:
    """去掉空段 / 可选去重后，用分隔符拼成一条提示词。"""
    separator = decode_separator(separator)
    cleaned: list[str] = []
    seen: set[str] = set()
    for part in parts or []:
        for text in _as_texts(part):
            text = text.strip()
            if not text:
                continue
            if dedupe:
                text = _dedupe_text_tags(text, seen)
                if not text:
                    continue
            cleaned.append(text)
    return separator.join(cleaned)


def merge_prompt_inputs(inputs, separator=DEFAULT_SEPARATOR, dedupe: bool = True) -> str:
    """从节点输入字典里收集 ``prompt*`` 并整合成一条文本。"""
    return join_parts(collect_prompts(inputs), separator, is_enabled(dedupe, True))


__all__ = [
    "DEFAULT_SEPARATOR",
    "MAX_SEGMENTS",
    "collect_prompts",
    "decode_separator",
    "is_enabled",
    "join_parts",
    "merge_prompt_inputs",
    "prompt_slot_index",
]
