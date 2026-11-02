"""从 ComfyUI 提交给 /prompt 的工作流（API 格式）里提取正向提示词。

**只取正向**：反向提示词不在本插件保存范围内，所以遇到名字/标题明显是负向的
文本控件会跳过。

取词优先级（对应 ``origin``）：

1. ``merge`` —— 沿着采样器的 ``positive`` 链路走，遇到「合并 / 拼接提示词」的节点
   （JoinStringMulti、JoinStrings、StringConcatenate、PromptCombiner…）就按它自己的
   分隔符把各个输入拼成完整提示词，直接把这条链路的结果当作提示词；
2. ``graph`` —— 没有合并节点时，收集链路上所有正向文本控件（同一节点里的
   ``text_a`` / ``string_1``… 按顺序用逗号拼起来）。

执行期还会再有一次「展开后」的校正（随机池 / 通配符），那一步在服务端做。
"""

from __future__ import annotations

import re

from . import prompt_merge

# 文本控件常用的输入名（``populated_text`` 之类已经解析好的文本优先）
TEXT_KEYS = (
    "populated_text",
    "resolved_text",
    "text",
    "text_g",
    "text_l",
    "t5xxl",
    "clip_l",
    "prompt",
    "prompt_text",
    "prompt_preview",
    "manual_prompt",
    "positive_prompt",
    "positive",
    "text_positive",
    "wildcard_text",
    "string",
    "negative_prompt",
    "negative",
    "text_negative",
)

# 已经解析成最终文本的输入：命中就直接用它，不再收集同节点的其它文本
RESOLVED_KEYS = ("populated_text", "resolved_text")

# ``text_a`` / ``text_1`` / ``prompt_main`` 这类合并 / 拼接节点的输入名也算文本
_TEXT_KEY_PATTERN = re.compile(
    r"^(text|prompt|string|positive|negative|t5xxl|clip_l)([-_]?[a-z0-9]+)*$"
)

# 往上游走时优先跟这些输入
FOLLOW_KEYS = (
    "conditioning",
    "positive",
    "conditioning_1",
    "conditioning_2",
    "conditioning_to",
    "conditioning_from",
    "cond",
    "text",
)

# 明显不是提示词链路的输入，不去跟，避免跑到模型 / 图片分支上乱抓文字
SKIP_KEYS = {
    "clip",
    "vae",
    "model",
    "latent",
    "latent_image",
    "pixels",
    "noise",
    "noise_seed",
    "samples",
    "image",
    "images",
    "mask",
    "masks",
    "control_net",
    "clip_vision",
    "style_model",
    "gligen",
    "ipadapter",
    "insightface",
    "bbox_detector",
    "sam_model",
    "detector_model",
    "guider",
    "sampler",
    "sigmas",
    "sigmas_adv",
    "model_sampling",
    "clip_name",
    "vae_name",
    "unet_name",
    "lora_name",
    "filename_prefix",
}

MAX_DEPTH = 40

# 「合并 / 拼接提示词」的节点：类名里带这些词，或者同时有分隔符 + 至少两个文本输入
MERGE_HINTS = ("join", "merge", "concat", "combine", "append", "compose", "拼接", "合并")
# 合并节点用来连接各段文本的分隔符输入名
DELIMITER_KEYS = ("delimiter", "separator", "sep", "joiner", "glue", "split_with")
# 默认分隔符：全是单行时用逗号，否则用换行
DEFAULT_DELIMITER = ", "


def extract(prompt) -> str:
    """返回正向提示词，取不到时是空字符串。"""
    return extract_with_origin(prompt)[0]


def extract_with_origin(prompt) -> tuple[str, str]:
    """返回 ``(正向提示词, 来源)``；来源是 ``merge`` / ``graph`` / ``""``。"""
    if not isinstance(prompt, dict):
        return "", ""

    texts: list[str] = []
    merge_hits: list[str] = []

    # 1) 常规：采样器的 positive 链路
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        inputs = _inputs(node)
        if _is_link(inputs.get("positive")):
            texts.extend(_walk(prompt, inputs["positive"], merge_out=merge_hits))

    # 2) 只有 conditioning 输入的图（视频 / 放大 / 自定义采样器）
    if not texts:
        for node in prompt.values():
            if not isinstance(node, dict):
                continue
            inputs = _inputs(node)
            for key in ("conditioning", "cond", "conditioning_1"):
                value = inputs.get(key)
                if _is_link(value):
                    texts.extend(_walk(prompt, value, merge_out=merge_hits))

    # 3) 兜底：合并节点的结果优先，其次图里所有正向文本控件
    if not texts:
        for node in prompt.values():
            if not isinstance(node, dict):
                continue
            merged = _merge_node_text(prompt, node, 0, set())
            if merged:
                texts.append(merged)
                merge_hits.append(merged)
                continue
            texts.extend(_node_texts(node))

    text = _join(texts)
    if not text:
        return "", ""
    if merge_hits and any(hit and (hit == text or hit in text) for hit in merge_hits):
        return text, "merge"
    return text, "graph"


# ---------------------------------------------------------------- 内部实现


def _inputs(node: dict) -> dict:
    inputs = node.get("inputs")
    return inputs if isinstance(inputs, dict) else {}


def _is_link(value) -> bool:
    """ComfyUI 的连线是 ``[node_id, output_index]``。"""
    return (
        isinstance(value, (list, tuple))
        and len(value) == 2
        and isinstance(value[0], (str, int))
        and isinstance(value[1], int)
    )


def _is_text_key(key: str) -> bool:
    """判断某个输入名是不是「提示词文本」控件。"""
    if key in TEXT_KEYS:
        return True
    return bool(_TEXT_KEY_PATTERN.match(key))


def _is_negative_key(key: str) -> bool:
    """输入名里带 negative / neg 的，是反向提示词，跳过。"""
    lowered = key.lower()
    if "negative" in lowered:
        return True
    return lowered.startswith("neg") or lowered.endswith("neg") or "_neg" in lowered


def _node_looks_negative(node: dict) -> bool:
    """节点本身像是「负向提示词」节点（类名或标题里带提示）。"""
    title = ""
    meta = node.get("_meta")
    if isinstance(meta, dict):
        title = str(meta.get("title") or "")
    haystack = (str(node.get("class_type") or "") + " " + title).lower()
    return any(hint in haystack for hint in ("negative", "负向", "反向", "负面"))


def _node_texts(node: dict) -> list[str]:
    """读出节点里的正向文本（反向的跳过）。

    普通文本编码节点只有一个 ``text``；合并 / 拼接节点可能有 ``text_a``、``text_b``
    好几个，这里全部收下来，交给 :func:`_join` 拼回去。
    """
    inputs = _inputs(node)
    if not inputs:
        return []
    if _node_looks_negative(node):
        return []

    # 已经解析好的最终文本优先独占
    for key in RESOLVED_KEYS:
        value = inputs.get(key)
        if isinstance(value, str) and value.strip():
            return [value.strip()]

    texts: list[str] = []
    for key, value in inputs.items():
        if not isinstance(value, str) or not value.strip():
            continue
        if not _is_text_key(key) or _is_negative_key(key):
            continue
        texts.append(value.strip())
    if texts:
        return texts

    class_type = str(node.get("class_type") or "").lower()
    if "string" in class_type or "text" in class_type or "primitive" in class_type:
        for key in ("value", "string", "text"):
            value = inputs.get(key)
            if isinstance(value, str) and value.strip():
                return [value.strip()]
    return []


def _is_merge_node(node: dict) -> bool:
    """是不是「合并 / 拼接提示词」的节点。"""
    class_type = str(node.get("class_type") or "").lower()
    if any(hint in class_type for hint in MERGE_HINTS):
        return True
    inputs = _inputs(node)
    has_delimiter = any(key in inputs for key in DELIMITER_KEYS)
    text_inputs = [
        key
        for key, value in inputs.items()
        if _is_text_key(key) and not _is_negative_key(key) and (isinstance(value, str) or _is_link(value))
    ]
    return has_delimiter and len(text_inputs) >= 2


def _ordered_text_inputs(node: dict) -> list[str]:
    """合并节点的文本输入顺序：``prompt`` 在最前，``string_1 / string_2 …`` 按序号。"""
    keys = [
        key
        for key in _inputs(node)
        if _is_text_key(key) and not _is_negative_key(key)
    ]
    order = {key: index for index, key in enumerate(keys)}

    def sort_key(key: str):
        if key.lower() in ("prompt", "text"):
            return (0, 0, order[key])
        match = re.search(r"(\d+)\s*$", key)
        if match:
            return (0, int(match.group(1)), order[key])
        return (1, 0, order[key])

    return sorted(keys, key=sort_key)


def _merge_delimiter(prompt: dict, node: dict, depth: int, seen) -> str | None:
    inputs = _inputs(node)
    for key in DELIMITER_KEYS:
        if key not in inputs:
            continue
        value = inputs[key]
        if isinstance(value, str):
            return value
        if _is_link(value):
            return _link_text(prompt, value, depth + 1, seen)
    return None


def _merge_node_text(prompt: dict, node: dict, depth: int, seen) -> str:
    """把「合并提示词」节点的各段输入按它自己的分隔符拼成完整提示词。"""
    if depth > MAX_DEPTH or not _is_merge_node(node) or _node_looks_negative(node):
        return ""
    inputs = _inputs(node)
    parts: list[str] = []
    for key in _ordered_text_inputs(node):
        value = inputs.get(key)
        if isinstance(value, str):
            text = value.strip()
        elif _is_link(value):
            text = _link_text(prompt, value, depth + 1, seen)
        else:
            text = ""
        if text:
            parts.append(text)
    if not parts:
        return ""
    # 只有「提示词整合」节点默认去重；其它合并节点保持原样，避免改掉别人的重复段。
    dedupe_default = str(node.get("class_type") or "") == "PromptHistoryMerge"
    dedupe = prompt_merge.is_enabled(inputs.get("dedupe"), dedupe_default)
    # 只有一段、又不去重时才直接返回；去重时也要走 join_parts，才能和节点输出一致
    if len(parts) == 1 and not dedupe:
        return parts[0]
    delimiter = _merge_delimiter(prompt, node, depth, seen)
    if delimiter is None:
        delimiter = DEFAULT_DELIMITER if all("\n" not in part for part in parts) else "\n"
    return prompt_merge.join_parts(parts, delimiter, dedupe=dedupe)


def _link_text(prompt: dict, link, depth: int = 0, seen=None) -> str:
    """顺着一条连线往上找「一段文本」（合并节点会返回它拼好的完整文本）。"""
    if depth > MAX_DEPTH or not _is_link(link):
        return ""
    node_id = str(link[0])
    seen = set() if seen is None else seen
    if node_id in seen:
        return ""
    seen = seen | {node_id}

    node = prompt.get(node_id)
    if not isinstance(node, dict):
        return ""

    merged = _merge_node_text(prompt, node, depth, seen)
    if merged:
        return merged

    texts = _node_texts(node)
    if texts:
        return texts[0]

    inputs = _inputs(node)
    for key in FOLLOW_KEYS:
        value = inputs.get(key)
        if _is_link(value):
            text = _link_text(prompt, value, depth + 1, seen)
            if text:
                return text
    for key, value in inputs.items():
        if key in SKIP_KEYS:
            continue
        if _is_link(value):
            text = _link_text(prompt, value, depth + 1, seen)
            if text:
                return text
    return ""


def _walk(prompt: dict, link, depth: int = 0, seen=None, merge_out=None) -> list[str]:
    """沿连线往上游走，收集链路上所有正向文本。"""
    if depth > MAX_DEPTH or not _is_link(link):
        return []
    node_id = str(link[0])
    seen = set() if seen is None else seen
    if node_id in seen:
        return []
    seen = seen | {node_id}

    node = prompt.get(node_id)
    if not isinstance(node, dict):
        return []
    inputs = _inputs(node)

    # 合并节点：它自己就算出了完整提示词，不用再往里钻
    merged = _merge_node_text(prompt, node, depth, seen)
    if merged:
        if merge_out is not None:
            merge_out.append(merged)
        return [merged]

    texts: list[str] = list(_node_texts(node))

    followed = set()
    for key in FOLLOW_KEYS:
        value = inputs.get(key)
        if _is_link(value):
            followed.add(key)
            texts.extend(_walk(prompt, value, depth + 1, seen, merge_out))

    for key, value in inputs.items():
        if key in followed or key in SKIP_KEYS:
            continue
        if _is_link(value):
            texts.extend(_walk(prompt, value, depth + 1, seen, merge_out))

    return texts


def _join(texts) -> str:
    """去重后拼接；全是一行时用逗号连接，否则用空行分开。"""
    unique: list[str] = []
    seen = set()
    for text in texts:
        text = (text or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        unique.append(text)
    if not unique:
        return ""
    if len(unique) == 1:
        return unique[0]
    if all("\n" not in text for text in unique):
        return ", ".join(unique)
    return "\n\n".join(unique)
