"""ComfyUI Prompt TAG Manager · 汐皮笑脸的提示词管理

整合了原来的「提示词历史」插件，节点统一放在 ``提示词管理`` 分类下：

* ``PromptTagSelector``     汐皮笑脸的随机tag
* ``PromptHistoryMerge``    汐皮笑脸的tag合并
* ``PromptHistorySelector`` 汐皮笑脸的tag历史板

三级分类（一级分类 / 二级分类 / 子项）的随机提示词节点，支持批量导入导出 tag；
历史板保存每次提交的提示词，支持文字 / 图文两种展示和选中注入。
安装：把整个文件夹放到 ``ComfyUI/custom_nodes/ComfyUI-PromptTagManager``，重启。
"""

from . import routes
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__version__ = "2.0.0"

# 注册词库 HTTP 接口（导入 / 导出 / 词库读写 / 预览）
try:
    routes.register_routes()
except Exception as _exc:  # pragma: no cover - 保证节点本身不影响启动
    print("[PromptTag] 接口注册失败：%s" % _exc)

# 注册提示词历史接口 + 提交/出图钩子
try:
    from . import history_routes

    history_routes.register_routes()
except Exception as _exc:  # pragma: no cover - 历史接口失败不影响 TAG 节点
    print("[PromptHistory] 接口注册失败：%s" % _exc)

WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "__version__",
]
