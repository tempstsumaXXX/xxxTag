"""ComfyUI 节点定义：随机 TAG 提示词。

节点本身只做一件事：把隐藏控件 ``tag_config`` 里的配置（由前端 TAG 面板写入）
编译成最终提示词字符串。随机抽取在后端按 ``seed`` 完成，因此可复现。
"""

from __future__ import annotations

from . import tag_store
from .prompt_builder import (
    DEFAULT_MANUAL_MODE,
    DEFAULT_WEIGHT_STYLE,
    MANUAL_MODES,
    WEIGHT_STYLES,
    build_prompt,
    combine_prompt,
    load_config,
    uses_manual,
    uses_tags,
)
from .history_nodes import (
    NODE_CLASS_MAPPINGS as HISTORY_NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS as HISTORY_NODE_DISPLAY_NAME_MAPPINGS,
)

CATEGORY_NAME = "提示词管理"


def _as_text(value, default=""):
    """把控件值安全地变成字符串（旧工作流参数错位时也不会崩）。"""
    return value if isinstance(value, str) else default


def _as_flag(value, default=True):
    """把控件值安全地变成布尔（错位传进来的字符串/数字也认）。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() not in ("", "0", "false", "no", "off", "none")
    return default


def _as_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# 老工作流控件串位时，这些「选项值」可能被塞进 separator / natural_prompt 里
_CONTROL_VALUES = {
    "fixed",
    "randomize",
    "increment",
    "decrement",
    "固定",
    "每次随机",
    "递增",
    "递减",
    "随机",
}


def _looks_like_option(value):
    """判断字符串是不是控件选项值（而不是用户真正写的内容）。"""
    text = value.strip()
    return text in _CONTROL_VALUES or text in MANUAL_MODES or text in WEIGHT_STYLES


def pool_resolver(library, group, sub):
    """解析随机池引用：按 词库 / 一级分类 / 二级分类 取出候选 tag。

    随机池在节点里只存引用（几十字节），候选在真正执行时才从磁盘读，
    这样工作流不会因为内嵌上千条提示词而变得巨大（那会拖垮浏览器的自动存档）。
    """
    return tag_store.library_sub_tags(library, group, sub)


class PromptTagSelector:
    """随机 TAG 提示词节点（三级分类词库 + 批量导入导出）。"""

    DESCRIPTION = (
        "从三级分类词库（一级分类 / 二级分类 / 子项）中勾选或随机抽取 tag，输出提示词。\n"
        "「提示词框」可以手动写提示词，并选择「仅用提示词框 / 仅用 TAG 词库 / 两者结合」。\n"
        "点节点上的「打开Tag词库面板」按钮可以管理词库、批量导入导出、设置随机池。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "tag_config": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "dynamicPrompts": False,
                        "tooltip": "由 TAG 面板自动写入的配置（JSON），一般不需要手动修改。",
                    },
                ),
            },
            "optional": {
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "tooltip": "随机池的抽样种子：相同种子结果可复现；"
                        "生成后是否随机 / 递增由 ComfyUI 自带的「生成后控制」管理。",
                    },
                ),
                "separator": (
                    "STRING",
                    {
                        "default": ", ",
                        "multiline": False,
                        "tooltip": "tag 之间的连接符，支持 \\n（换行）。",
                    },
                ),
                "dedupe": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "去重",
                        "label_off": "保留重复",
                        "tooltip": "同一个 tag 出现多次时只保留最先出现的那个（忽略大小写）。关掉则原样保留重复。",
                    },
                ),
                "underscore_to_space": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "下划线转空格",
                        "label_off": "保持原样",
                        "tooltip": "把 tag 里的下划线换成空格（red_hair → red hair），"
                        "更接近大多数模型的习惯写法。只作用于 TAG 词库部分，提示词框原样保留。",
                    },
                ),
                "weight_style": (
                    WEIGHT_STYLES,
                    {
                        "default": DEFAULT_WEIGHT_STYLE,
                        "tooltip": "权重不等于 1 时的输出语法；默认不输出权重。",
                    },
                ),
                # ---- 以下为手动 / 自然语言参数 ----
                "manual_mode": (
                    MANUAL_MODES,
                    {
                        "default": DEFAULT_MANUAL_MODE,
                        "tooltip": "手动提示词框与 TAG 词库结果怎么组合。",
                    },
                ),
                "manual_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": False,
                        "tooltip": "手动提示词框：随便写，支持 (tag:1.2) 权重语法和换行。",
                    },
                ),
                "manual_space_as_sep": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "空格转连接符",
                        "label_off": "保持原样",
                        "tooltip": "把提示词框里 tag 之间的空格/换行换成连接符。"
                        "注意开了之后 `best quality` 这类多词 tag 会被拆成两个。",
                    },
                ),
                "natural_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": False,
                        "tooltip": "自然语言描述框：写一整句人话（如 a girl standing in the rain, "
                        "cinematic lighting, film grain），不会被空格拆分或去重。",
                    },
                ),
                "natural_append": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "label_on": "组合在末尾",
                        "label_off": "不组合",
                        "tooltip": "是否把自然语言描述接到 tag 末尾（用连接符相连）。"
                        "关掉时这段文字完全不参与输出，方便临时禁用。",
                    },
                ),
                "prompt_preview": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": False,
                        "tooltip": "自动生成的预览（只读，仅供查看，不会参与输出）。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("提示词", "标签列表")
    OUTPUT_TOOLTIPS = ("最终拼接好的提示词", "按顺序排列的 tag（不含权重）")
    FUNCTION = "build"
    CATEGORY = CATEGORY_NAME

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # tag_config 变化不一定被 ComfyUI 静态分析出来，这里直接声明每次都重跑，
        # 避免「改了 tag 但输出没变」的缓存问题。
        return float("NaN")

    def build(
        self,
        tag_config="",
        manual_mode=DEFAULT_MANUAL_MODE,
        manual_prompt="",
        seed=0,
        separator=", ",
        dedupe=True,
        underscore_to_space=True,
        weight_style=DEFAULT_WEIGHT_STYLE,
        manual_space_as_sep=False,
        natural_prompt="",
        natural_append=False,
        prompt_preview="",
    ):
        if isinstance(tag_config, dict):
            config = tag_config
        else:
            config = _as_text(tag_config, "")

        # 老工作流的控件值可能是错位的（比如 separator 收到 True），这里全部兜底，
        # 绝不让节点因为参数类型不对而执行失败。
        mode = manual_mode if isinstance(manual_mode, str) and manual_mode in MANUAL_MODES else DEFAULT_MANUAL_MODE
        style = weight_style if isinstance(weight_style, str) and weight_style in WEIGHT_STYLES else DEFAULT_WEIGHT_STYLE
        manual = _as_text(manual_prompt, "").replace("\\n", "\n")
        sep = _as_text(separator, ", ")
        if _looks_like_option(sep):
            sep = ", "
        do_dedupe = _as_flag(dedupe, True)
        to_space = _as_flag(underscore_to_space, True)
        space_as_sep = _as_flag(manual_space_as_sep, False)
        natural = _as_text(natural_prompt, "").replace("\\n", "\n")
        if _looks_like_option(natural):
            natural = ""
        natural_on = _as_flag(natural_append, False)
        seed_value = _as_int(seed, 0)

        cfg = load_config(config)

        # 只用提示词框时，不必去解析词库（更快，也不受词库缺失影响）
        if uses_tags(mode):
            if not cfg["items"]:
                print("[PromptTag] 提示：节点里还没有选择任何 tag，只用提示词框的内容。")
            tag_prompt, tags = build_prompt(
                config=cfg,
                seed=seed_value,
                separator=sep,
                dedupe=do_dedupe,
                underscore_to_space=to_space,
                weight_style=style,
                resolver=pool_resolver,
            )
        else:
            tag_prompt, tags = "", []

        if not uses_manual(mode):
            manual = ""

        body = combine_prompt(
            manual=manual,
            tag_prompt=tag_prompt,
            mode=mode,
            separator=sep,
            space_as_separator=space_as_sep,
            natural=natural,
            natural_append=natural_on,
        )

        prompt = body

        tags_joined = sep.replace("\\n", "\n").replace("\\t", "\t")
        tags_text = tags_joined.join(tags)

        return {
            "ui": {"text": [prompt], "tags": [tags]},
            "result": (prompt, tags_text),
        }


NODE_CLASS_MAPPINGS = {
    "PromptTagSelector": PromptTagSelector,
}
NODE_CLASS_MAPPINGS.update(HISTORY_NODE_CLASS_MAPPINGS)

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptTagSelector": "汐皮笑脸的随机tag",
}
NODE_DISPLAY_NAME_MAPPINGS.update(HISTORY_NODE_DISPLAY_NAME_MAPPINGS)

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "PromptTagSelector",
]
