"""把节点的控件定义导出成 JSON，供前端集成测试使用（防止前后端控件列表漂移）。

    python tests/dump_node_schema.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.dirname(HERE)

spec = importlib.util.spec_from_file_location(
    "ptm", os.path.join(PKG_DIR, "__init__.py"), submodule_search_locations=[PKG_DIR]
)
ptm = importlib.util.module_from_spec(spec)
sys.modules["ptm"] = ptm
spec.loader.exec_module(ptm)

cls = ptm.nodes.PromptTagSelector
types = cls.INPUT_TYPES()

widgets = []
for section in ("required", "optional"):
    for name, spec_ in types.get(section, {}).items():
        if isinstance(spec_[0], list):
            widgets.append({"name": name, "type": "COMBO", "default": spec_[1].get("default", spec_[0][0]), "section": section})
        else:
            widgets.append(
                {
                    "name": name,
                    "type": spec_[0],
                    "default": spec_[1].get("default", ""),
                    "multiline": bool(spec_[1].get("multiline", False)),
                    "section": section,
                }
            )

schema = {
    "node": "PromptTagSelector",
    "widgets": widgets,
    "return_types": list(cls.RETURN_TYPES),
    "return_names": list(cls.RETURN_NAMES),
    "category": cls.CATEGORY,
}

out = os.path.join(HERE, "node_schema.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(schema, f, ensure_ascii=False, indent=2)
print("written:", out)
print(json.dumps(schema, ensure_ascii=False, indent=2))
