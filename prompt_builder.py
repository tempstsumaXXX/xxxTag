"""把节点里保存的 tag 配置编译成最终提示词（含按分类随机抽取）。

配置结构（由前端写入节点隐藏控件 ``tag_config``）::

    {
      "v": 1,
      "library": "Danbooru 基础",
      "items": [
        {"kind": "tag",  "text": "1girl",  "weight": 1.0, "enabled": true},
        {"kind": "pool", "label": "人物/发色", "count": 2, "weight": 1.0, "enabled": true,
         "tags": ["red_hair", "blue_hair", "silver_hair"]}
      ]
    }

``items`` 的顺序就是最终提示词里 tag 的顺序；``pool`` 表示「在这个位置从候选
tag 里随机抽 count 个」，抽样过程由 seed 决定，可复现。
"""

from __future__ import annotations

import json
import random
import re

WEIGHT_STYLES = ["不输出权重", "(tag:1.2)", "tag:1.2"]
DEFAULT_WEIGHT_STYLE = "不输出权重"

# 手动提示词框的使用方式
MANUAL_MODES = [
    "两者结合（提示词框在前）",
    "两者结合（提示词框在后）",
    "仅使用提示词框",
    "仅使用 TAG 词库",
]
DEFAULT_MANUAL_MODE = MANUAL_MODES[0]

_MAX_WEIGHT = 10.0

_ESCAPE_PAREN = re.compile(r"(?<!\\)([()])")


# ---------------------------------------------------------------------------
# 配置规范化
# ---------------------------------------------------------------------------


def _as_bool(value, default=True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() not in ("", "0", "false", "no", "off", "none")
    return default


def _as_weight(value, default=1.0) -> float:
    try:
        w = float(value)
    except (TypeError, ValueError):
        return default
    if w != w or w in (float("inf"), float("-inf")):  # NaN / inf
        return default
    return max(0.0, min(_MAX_WEIGHT, w))


def _as_count(value, default=1) -> int:
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        return default
    return max(0, n)


def _clean_text(text) -> str:
    if not isinstance(text, str):
        text = "" if text is None else str(text)
    text = text.replace("\r", " ").replace("\n", " ").strip()
    return re.sub(r"\s+", " ", text)


def load_config(raw) -> dict:
    """把 tag_config 的字符串/字典解析成配置字典（容错，永不抛异常）。"""
    if isinstance(raw, str):
        raw = raw.strip()
        if not raw:
            return {"v": 1, "library": "", "items": []}
        try:
            raw = json.loads(raw)
        except Exception:
            if raw[:1] in ("{", "["):
                # 看起来是坏掉的 JSON，不要把它当 tag 塞进提示词
                return {"v": 1, "library": "", "items": []}
            # 兼容「直接就是一段提示词」的老写法：整段当作固定 tag
            return {
                "v": 1,
                "library": "",
                "items": [
                    {"kind": "tag", "text": part.strip(), "weight": 1.0, "enabled": True}
                    for part in re.split(r"[,\n]", raw)
                    if part.strip()
                ],
            }
    if not isinstance(raw, dict):
        return {"v": 1, "library": "", "items": []}
    return normalize_config(raw)


def normalize_config(config: dict) -> dict:
    items = []
    for item in config.get("items") or []:
        if not isinstance(item, dict):
            continue
        kind = item.get("kind") or ("pool" if item.get("tags") else "tag")
        if kind == "pool":
            tags = []
            seen = set()
            for tag in item.get("tags") or []:
                cleaned = _clean_text(tag)
                if not cleaned or cleaned.lower() in seen:
                    continue
                seen.add(cleaned.lower())
                tags.append(cleaned)
            library = _clean_text(item.get("library")) or _clean_text(config.get("library"))
            group = _clean_text(item.get("group"))
            sub = _clean_text(item.get("sub"))
            # 新版随机池只存引用（库/一级/二级），候选在执行时再读，节点体积很小
            is_ref = bool(library and group and not tags)
            if not tags and not is_ref:
                continue
            count = _as_count(item.get("count", 1), 1)
            if count <= 0:
                continue
            items.append(
                {
                    "kind": "pool",
                    "label": _clean_text(item.get("label")) or "随机池",
                    "count": count,
                    "tags": tags,
                    "library": library,
                    "group": group,
                    "sub": sub,
                    "ref": is_ref,
                    "weight": _as_weight(item.get("weight", 1.0)),
                    "enabled": _as_bool(item.get("enabled"), True),
                }
            )
        else:
            text = _clean_text(item.get("text"))
            if not text:
                continue
            items.append(
                {
                    "kind": "tag",
                    "text": text,
                    "weight": _as_weight(item.get("weight", 1.0)),
                    "enabled": _as_bool(item.get("enabled"), True),
                }
            )
    return {
        "v": 1,
        "library": _clean_text(config.get("library")),
        "items": items,
    }


def resolve_pools(config: dict, resolver) -> dict:
    """把「只存引用」的随机池补上候选 tag（resolver 按 库/一级/二级 读词库）。

    老工作流里的随机池自带 tags，这里原样保留，不需要重新解析。
    """
    if not isinstance(config, dict) or resolver is None:
        return config
    for item in config.get("items") or []:
        if item.get("kind") != "pool" or item.get("tags") or not item.get("ref"):
            continue
        try:
            raw = resolver(item.get("library"), item.get("group"), item.get("sub"))
        except Exception as exc:  # 词库被删/改名时不要炸整条工作流
            print("[PromptTag] 随机池引用的词库读取失败：%s" % exc)
            raw = []
        cleaned = []
        seen = set()
        for tag in raw or []:
            text = _clean_text(tag)
            if not text or text.lower() in seen:
                continue
            seen.add(text.lower())
            cleaned.append(text)
        item["tags"] = cleaned
    return config



def config_from_json(raw) -> dict:
    return load_config(raw)


# ---------------------------------------------------------------------------
# 生成提示词
# ---------------------------------------------------------------------------


def _format_tag(text: str, weight: float, style: str) -> str:
    if abs(weight - 1.0) < 1e-6 or style == "不输出权重":
        return text
    escaped = _ESCAPE_PAREN.sub(r"\\\1", text)
    w = ("%.3f" % weight).rstrip("0").rstrip(".")
    if style == "tag:1.2":
        return "%s:%s" % (escaped, w)
    return "(%s:%s)" % (escaped, w)


def build_prompt(
    config,
    seed: int = 0,
    separator: str = ", ",
    dedupe: bool = True,
    underscore_to_space: bool = True,
    weight_style: str = DEFAULT_WEIGHT_STYLE,
    resolver=None,
) -> tuple:
    """返回 (提示词, 标签列表)。标签列表不含权重、不含连接符之外的东西。

    ``resolver(library, group, sub) -> list[str]`` 用来解析「只存引用」的随机池。
    """
    cfg = load_config(config)
    resolve_pools(cfg, resolver)
    style = weight_style if isinstance(weight_style, str) and weight_style in WEIGHT_STYLES else DEFAULT_WEIGHT_STYLE

    # 兜底：外部（老工作流 / 接口调用）可能传进来不是字符串的参数
    if not isinstance(separator, str):
        separator = ", "
    separator = separator.replace("\\n", "\n").replace("\\t", "\t")
    dedupe = _as_bool(dedupe, True)
    underscore_to_space = _as_bool(underscore_to_space, True)
    try:
        seed = int(seed)
    except (TypeError, ValueError):
        seed = 0

    rng = random.Random(seed & 0xFFFFFFFFFFFFFFFF)

    picked = []  # [(raw_text, weight)]
    for item in cfg["items"]:
        if not item.get("enabled", True):
            continue
        if item["kind"] == "pool":
            tags = list(item["tags"])
            if not tags:
                # 引用的词库/分类可能被删了，跳过而不是报错
                continue
            count = item["count"]
            if count >= len(tags):
                chosen = tags[:]
                rng.shuffle(chosen)
                if count > len(tags):
                    # 数量超过候选项：允许重复抽取，补齐
                    while len(chosen) < count:
                        chosen.append(tags[rng.randrange(len(tags))])
            else:
                chosen = rng.sample(tags, count)
            for tag in chosen:
                picked.append((tag, item["weight"]))
        else:
            picked.append((item["text"], item["weight"]))

    out_texts = []
    out_plain = []
    seen = set()
    for text, weight in picked:
        text = _clean_text(text)
        if not text:
            continue
        if underscore_to_space:
            text = text.replace("_", " ")
            text = re.sub(r"\s+", " ", text).strip()
        key = text.lower()
        if dedupe and key in seen:
            continue
        seen.add(key)
        out_plain.append(text)
        out_texts.append(_format_tag(text, weight, style))

    return separator.join(out_texts), out_plain


def preview(
    config,
    seed: int = 0,
    separator: str = ", ",
    dedupe: bool = True,
    underscore_to_space: bool = True,
    weight_style: str = DEFAULT_WEIGHT_STYLE,
    resolver=None,
) -> dict:
    prompt, tags = build_prompt(
        config=config,
        seed=seed,
        separator=separator,
        dedupe=dedupe,
        underscore_to_space=underscore_to_space,
        weight_style=weight_style,
        resolver=resolver,
    )
    return {"prompt": prompt, "tags": tags, "count": len(tags)}


# ---------------------------------------------------------------------------
# 手动提示词框
# ---------------------------------------------------------------------------


_TRAILING_SEP_RE = re.compile(r"[,，]\s*$")
_MULTI_SEP_RE = re.compile(r"[,，](?:[ \t]*[,，])+")


def clean_manual_prompt(text) -> str:
    """整理手动提示词：保留换行，收掉多余空行与首尾空白，并去掉结尾逗号。

    结尾逗号一定要去掉：`a, b, ` 直接和 tag 拼起来会变成 `a, b, , tag`。
    """
    if not isinstance(text, str):
        text = "" if text is None else str(text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in text.split("\n")]
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = _TRAILING_SEP_RE.sub("", text)
    return text.strip()


def collapse_separators(text: str) -> str:
    """把连在一起的多个逗号收敛成一个（`a,, b` / `a, , b` → `a, b`）。"""
    if not isinstance(text, str) or not text:
        return text or ""
    return _MULTI_SEP_RE.sub(",", text)


def _join_two(first: str, second: str, separator: str) -> str:
    if not first:
        return second
    if not second:
        return first
    return first + separator + second


def split_manual_by_space(text: str, separator: str) -> str:
    """把提示词框里 tag 之间的空白（空格/制表符/换行）换成连接符。

    注意：开了这个开关后，`best quality` 这种多词 tag 会被当成两个 tag，
    所以它是可选项，默认关闭。
    """
    text = clean_manual_prompt(text)
    if not text:
        return ""
    parts = [p for p in re.split(r"\s+", text) if p]
    return separator.join(parts)


def combine_prompt(
    manual: str = "",
    tag_prompt: str = "",
    mode: str = DEFAULT_MANUAL_MODE,
    separator: str = ", ",
    space_as_separator: bool = False,
    natural: str = "",
    natural_append: bool = False,
) -> str:
    """组合最终正文：

    1. 按「使用方式」拼 手动提示词框 + TAG 词库结果；
    2. 如果开了 `natural_append`，把自然语言描述接到末尾；
    3. 前后缀由调用方（节点）再包一层。
    """
    sep = ", " if not isinstance(separator, str) else separator
    sep = sep.replace("\\n", "\n").replace("\\t", "\t")

    manual = clean_manual_prompt(manual)
    if manual and space_as_separator:
        manual = split_manual_by_space(manual, sep)
    tag_prompt = tag_prompt or ""

    if mode not in MANUAL_MODES:
        mode = DEFAULT_MANUAL_MODE

    if mode == "仅使用提示词框":
        body = manual
    elif mode == "仅使用 TAG 词库":
        body = tag_prompt
    elif mode == "两者结合（提示词框在后）":
        body = _join_two(tag_prompt, manual, sep)
    else:  # 两者结合（提示词框在前）
        body = _join_two(manual, tag_prompt, sep)

    if natural_append:
        natural_text = clean_manual_prompt(natural)
        if natural_text:
            body = _join_two(body, natural_text, sep)
    # 粘贴进来的文字常常自带逗号，拼接后可能出现 ", ,"，这里统一收敛
    return collapse_separators(body)


def uses_tags(mode: str) -> bool:
    """该模式下是否要用 TAG 词库。"""
    return mode != "仅使用提示词框"


def uses_manual(mode: str) -> bool:
    """该模式下是否要用手动提示词框。"""
    return mode != "仅使用 TAG 词库"
