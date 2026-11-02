"""节点：提示词整合 + 提示词历史板（已整合进 ComfyUI-PromptTagManager）。

``PromptHistoryMerge``
    把所有接到 ``prompt_1`` / ``prompt_2`` … 的提示词按顺序整合成一条，
    输出给「汐皮笑脸的tag历史板」或其它节点。前端会自动增加输入口，
    也可以点「＋ 增加输入端」手动加。

``PromptHistorySelector``
    一个节点同时干两件事：

    1. **收**：把工作流里「合并 / 拼接好」的提示词接进来（``prompt`` 可以直接连线），
       执行时**原样**写进历史，面板里存的就是这次真正用的原文。
    2. **出**：面板里单击选中某条记录后，输出换成选中的提示词，让这次排队用的是它。

    面板顶部的「选中即注入工作流」开关关掉、或节点上的 ``follow_panel`` 关掉时，
    节点就是「收什么出什么」的纯透传 + 记录。反向提示词不在保存范围内。
"""

from __future__ import annotations

from . import history_store
from .prompt_merge import DEFAULT_SEPARATOR, merge_prompt_inputs

CATEGORY_NAME = "提示词管理"
MERGE_NODE_NAME = "PromptHistoryMerge"
NODE_NAME = "PromptHistorySelector"


def _note_used_text(positive: str) -> None:
    """执行期把这次真正用到的提示词写进历史（延迟导入，避免和接口模块循环依赖）。"""
    try:
        from . import history_routes

        history_routes.note_node_prompt(positive)
    except Exception:
        pass


class PromptHistoryMerge:
    """把多路提示词按输入口顺序整合成一条，输出给下游节点。"""

    CATEGORY = CATEGORY_NAME
    FUNCTION = "merge"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("提示词",)
    DESCRIPTION = (
        "把所有接到 prompt_1、prompt_2 … 的提示词按顺序整合成一条，输出到下游。\n"
        "把它接到「汐皮笑脸的tag历史板」的 prompt 输入，就会把整合后的文本写进历史。\n"
        "输入口会自动增加；也可以点节点上的「＋ 增加输入端」手动增加。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "separator": (
                    "STRING",
                    {
                        "default": DEFAULT_SEPARATOR,
                        "multiline": False,
                        "dynamicPrompts": False,
                        "tooltip": "各段之间的分隔符。可用 \\n 表示换行、\\t 表示制表符。",
                    },
                ),
                "dedupe": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "去掉重复 tag",
                        "label_off": "保留重复",
                        "tooltip": "打开时：按逗号 / 换行把各路拆成 tag，完全相同的 tag（忽略大小写）"
                        "只保留第一次出现的位置。",
                    },
                ),
            },
            "optional": {
                "prompt_1": (
                    "STRING",
                    {
                        "default": "",
                        "forceInput": True,
                        "tooltip": "第 1 路提示词，可接任意 STRING 输出。",
                    },
                ),
                "prompt_2": (
                    "STRING",
                    {
                        "default": "",
                        "forceInput": True,
                        "tooltip": "第 2 路提示词；接满后前端会自动增加第 3 路。",
                    },
                ),
            },
        }

    def merge(self, separator=DEFAULT_SEPARATOR, dedupe=True, **kwargs):
        return (merge_prompt_inputs(kwargs, separator=separator, dedupe=dedupe),)


class PromptHistorySelector:
    """接收工作流合并后的提示词并保存，同时输出面板里选中的提示词。"""

    CATEGORY = CATEGORY_NAME
    FUNCTION = "build"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("提示词",)
    DESCRIPTION = (
        "输入端：接工作流合并好的提示词（可直接连线），执行时原样存进提示词历史；\n"
        "输出端：面板里单击选中某条记录后，输出那条提示词，让这次排队改用它。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "dynamicPrompts": False,
                        "tooltip": "把工作流合并好的提示词接到这里（可直接连线）；"
                        "没连线时用它自己的文本。执行时会原样保存到历史。",
                    },
                ),
            },
            "optional": {
                "follow_panel": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "label_on": "跟随面板选中",
                        "label_off": "只透传工作流文本",
                        "tooltip": "打开时：面板里有选中项就输出选中项；关闭时：收什么出什么。",
                    },
                ),
            },
        }

    def build(self, prompt="", follow_panel=True):
        text = prompt if isinstance(prompt, str) else ""

        if follow_panel:
            entry = history_store.get_store().get_injected_entry()
            if entry:
                text = (entry.get("positive") or "").strip() or text

        # 把本次实际使用的提示词写回历史（面板里显示的就是工作流合并后的原文）
        _note_used_text(text)
        return (text,)

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        """选中项 / 注入开关变了就让缓存失效，保证下次排队用的是新提示词。"""
        store = history_store.get_store()
        return "%s|%s" % (store.selected_id or "", bool(store.settings.get("inject_enabled")))


NODE_CLASS_MAPPINGS = {
    MERGE_NODE_NAME: PromptHistoryMerge,
    NODE_NAME: PromptHistorySelector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    MERGE_NODE_NAME: "汐皮笑脸的tag合并",
    NODE_NAME: "汐皮笑脸的tag历史板",
}

__all__ = [
    "CATEGORY_NAME",
    "MERGE_NODE_NAME",
    "NODE_NAME",
    "PromptHistoryMerge",
    "PromptHistorySelector",
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
