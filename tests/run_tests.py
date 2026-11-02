"""后端自测脚本（不依赖 ComfyUI 运行环境）。

用法：
    python tests/run_tests.py
"""

from __future__ import annotations

import glob
import importlib.util
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.dirname(HERE)

# 插件没有「内置词库只读保护」，保存会直接改词库文件。
# 所以测试时把内置词库复制到临时目录，避免把仓库里的 builtin_tags/ 写坏。
REAL_BUILTIN_DIR = os.path.join(PKG_DIR, "builtin_tags")
_BUILTIN_TMP = tempfile.mkdtemp(prefix="ptm_builtin_")
for _f in ("chinese_style.json", "danbooru_basic.json", "renwu.json"):
    _src = os.path.join(REAL_BUILTIN_DIR, _f)
    if os.path.isfile(_src):
        shutil.copy2(_src, _BUILTIN_TMP)
os.environ["PROMPT_TAG_BUILTIN_DIR"] = _BUILTIN_TMP

# 包目录名带连字符，用 importlib 手动加载成包
spec = importlib.util.spec_from_file_location(
    "ptm", os.path.join(PKG_DIR, "__init__.py"), submodule_search_locations=[PKG_DIR]
)
ptm = importlib.util.module_from_spec(spec)
sys.modules["ptm"] = ptm
spec.loader.exec_module(ptm)

tag_store = ptm.tag_store
pb = ptm.prompt_builder
nodes = ptm.nodes

FAILS = []
PASSES = 0


def check(name, cond, extra=""):
    global PASSES
    if cond:
        PASSES += 1
        print("  ok   %s" % name)
    else:
        FAILS.append("%s %s" % (name, extra))
        print("  FAIL %s %s" % (name, extra))


def eq(name, got, want):
    check(name, got == want, "got=%r want=%r" % (got, want))


# ---------------------------------------------------------------- 规范化
print("\n[1] normalize_library")
lib = tag_store.normalize_library(
    {"人物": {"发色": ["red_hair", "blue_hair"], "眼": ["blue_eyes"]}},
    name="测试",
)
eq("嵌套字典一级分类数", len(lib["groups"]), 1)
eq("嵌套字典二级分类数", len(lib["groups"][0]["subs"]), 2)
eq("嵌套字典词库名", lib["name"], "测试")

lib2 = tag_store.normalize_library(
    [{"group": "服装", "sub": "上装", "tag": "shirt"}, ["服装", "上装", "jacket"], "orphan"]
)
eq("三元组一级分类数", len(lib2["groups"]), 2)
eq("三元组 tag 数", tag_store.library_counts(lib2)["tags"], 3)

lib3 = tag_store.normalize_library(
    {"groups": [{"name": "人物", "tags": [{"text": "1girl"}, {"text": "1boy", "desc": "x"}]}]}
)
eq("WeiLin 风格一级挂在二级默认", lib3["groups"][0]["subs"][0]["name"], "默认")
eq("WeiLin 风格 tag 数", tag_store.library_counts(lib3)["tags"], 2)

lib4 = tag_store.normalize_library({"tags": ["a", "b", "a"]})
eq("单层 tags 去重", tag_store.library_counts(lib4)["tags"], 2)

# ---------------------------------------------------------------- 文本解析
print("\n[2] parse_text")
csv_text = "一级分类,二级分类,子项\n人物,发色,red hair\n人物,发色,blue hair\n服装,上装,shirt\n"
pc = tag_store.parse_text(csv_text, filename="a.csv")
eq("CSV 表头跳过", tag_store.library_counts(pc)["tags"], 3)
eq("CSV 一级分类数", len(pc["groups"]), 2)
eq("CSV 二级分类数", tag_store.library_counts(pc)["subs"], 2)

no_head = "人物,发色,red hair\n人物,发色,blue hair\n"
pn = tag_store.parse_text(no_head, filename="b.csv")
eq("CSV 无表头", tag_store.library_counts(pn)["tags"], 2)

two_col = "发色,red hair\n发色,blue hair\n"
p2 = tag_store.parse_text(two_col)
eq("两列 → 一级 + 默认二级", list(p2["groups"][0]["subs"][0]["tags"]), ["red hair", "blue hair"])
eq("两列一级名", p2["groups"][0]["name"], "发色")

one_col = "masterpiece\nbest quality\nhighres\n"
p1 = tag_store.parse_text(one_col)
eq("单列 tag 数", tag_store.library_counts(p1)["tags"], 3)
eq("单列进未分类", p1["groups"][0]["name"], "未分类")

txt = "# 人物\n## 发色\nred_hair\nblue_hair\n## 眼睛\ngreen_eyes\n# 场景\nforest\n"
pt = tag_store.parse_text(txt, filename="c.txt")
eq("TXT 标题解析一级数", len(pt["groups"]), 2)
eq("TXT 标题解析二级数", tag_store.library_counts(pt)["subs"], 3)
eq("TXT 标题解析 tag 数", tag_store.library_counts(pt)["tags"], 4)
eq("TXT 分组正确", pt["groups"][0]["subs"][0]["tags"], ["red_hair", "blue_hair"])

cj = '{"groups":[{"name":"人物","subs":[{"name":"发色","tags":["a","b"]}]}]}'
pcj = tag_store.parse_text(cj, filename="d.json")
eq("JSON 解析", tag_store.library_counts(pcj)["tags"], 2)

try:
    tag_store.parse_text("{bad json", filename="e.json")
    check("非法 JSON 抛错", False)
except ValueError:
    check("非法 JSON 抛错", True)

tabbed = "人物\t发色\tred_hair\n人物\t发色\tblue_hair\n"
eq("TSV 解析", tag_store.library_counts(tag_store.parse_text(tabbed))["tags"], 2)

arrow = "人物 > 发色 > red_hair\n人物 > 发色 > blue_hair\n"
ptb = tag_store.parse_text(arrow)
eq("箭头分隔符", tag_store.library_counts(ptb)["tags"], 2)
eq("箭头分隔符分类", ptb["groups"][0]["subs"][0]["name"], "发色")

# ---------------------------------------------------------------- 导出 / 回读
print("\n[3] export round-trip")
base = tag_store.normalize_library(
    {
        "groups": [
            {"name": "人物", "subs": [{"name": "发色", "tags": ["red_hair", "blue_hair"]}]},
            {"name": "场景", "subs": [{"name": "自然环境", "tags": ["forest", "ocean"]}]},
        ]
    },
    name="往返",
)
for fmt in ("json", "csv", "txt"):
    out = tag_store.export_library(base, fmt)
    back = tag_store.parse_text(out["content"], filename=out["filename"])
    ok = tag_store.library_counts(back) == tag_store.library_counts(base)
    check("导出 %s 回读一致" % fmt, ok, "%r vs %r" % (tag_store.library_counts(back), tag_store.library_counts(base)))
    check("导出 %s 有一级分类" % fmt, len(back["groups"]) == 2)

sub = tag_store.export_subset(base, "场景")
eq("导出子集一级数", len(sub["groups"]), 1)

# ---------------------------------------------------------------- 合并
print("\n[4] merge_library")
a = tag_store.normalize_library({"人物": {"发色": ["red_hair"]}})
b = tag_store.normalize_library({"人物": {"发色": ["red_hair", "black_hair"], "眼": ["blue_eyes"]}})
m = tag_store.merge_library(a, b)
eq("合并 tag 数", tag_store.library_counts(m)["tags"], 3)
eq("合并二级数", tag_store.library_counts(m)["subs"], 2)

# ---------------------------------------------------------------- 提示词构建
print("\n[5] build_prompt")
cfg = {
    "items": [
        {"kind": "tag", "text": "masterpiece", "weight": 1.0},
        {"kind": "tag", "text": "1girl", "weight": 1.2},
        {"kind": "tag", "text": "red_hair", "weight": 1.0},
    ]
}
p, tags = pb.build_prompt(cfg, separator=", ")
eq("固定 tag 拼接（默认不输出权重）", p, "masterpiece, 1girl, red hair")
eq("标签列表无权重", tags, ["masterpiece", "1girl", "red hair"])

p2, _ = pb.build_prompt(cfg, underscore_to_space=False)
eq("不转空格", p2, "masterpiece, 1girl, red_hair")

p3, _ = pb.build_prompt(cfg, weight_style="tag:1.2")
eq("裸权重语法", p3, "masterpiece, 1girl:1.2, red hair")

p3b, _ = pb.build_prompt(cfg, weight_style="(tag:1.2)")
eq("括号权重语法", p3b, "masterpiece, (1girl:1.2), red hair")

p4, _ = pb.build_prompt(cfg, weight_style="不输出权重")
eq("不输出权重", p4, "masterpiece, 1girl, red hair")

pc2 = {"items": [{"kind": "tag", "text": "a"}, {"kind": "tag", "text": "A"}]}
_, t_dedupe = pb.build_prompt(pc2, dedupe=True)
eq("去重", t_dedupe, ["a"])
_, t_keep = pb.build_prompt(pc2, dedupe=False)
eq("保留重复", t_keep, ["a", "A"])

pool_cfg = {
    "items": [
        {"kind": "tag", "text": "定值", "weight": 1.0},
        {
            "kind": "pool",
            "label": "人物/发色",
            "count": 2,
            "tags": ["red_hair", "blue_hair", "black_hair", "silver_hair"],
        },
        {"kind": "tag", "text": "尾巴", "weight": 1.0},
    ]
}
r1 = pb.build_prompt(pool_cfg, seed=42, underscore_to_space=False)
r2 = pb.build_prompt(pool_cfg, seed=42, underscore_to_space=False)
r3 = pb.build_prompt(pool_cfg, seed=43, underscore_to_space=False)
eq("同种子可复现", r1[0], r2[0])
check("不同种子结果不同", r1[0] != r3[0], "%r vs %r" % (r1[0], r3[0]))
check("随机池插入位置正确", r1[0].startswith("定值, ") and r1[0].endswith(", 尾巴"), r1[0])
eq("随机池抽取数量", len(r1[1]), 4)
check("随机池抽到不同 tag", len(set(r1[1])) == 4, r1[1])

over = {"items": [{"kind": "pool", "count": 5, "tags": ["a", "b"]}]}
o = pb.build_prompt(over, seed=1, underscore_to_space=False, dedupe=False)
eq("超量抽取补齐", len(o[1]), 5)

none_cfg = {"items": []}
eq("空配置", pb.build_prompt(none_cfg)[0], "")
eq("字符串配置(老写法)", pb.build_prompt("1girl, solo")[0], "1girl, solo")
eq("坏 JSON 字符串不产生 tag", pb.build_prompt("{oops")[0], "")
eq("None 配置", pb.build_prompt(None)[0], "")

paren = {"items": [{"kind": "tag", "text": "color (red)", "weight": 1.5}]}
eq("默认不输出权重", pb.build_prompt(paren, underscore_to_space=False)[0], "color (red)")
eq(
    "括号转义（显式权重语法）",
    pb.build_prompt(paren, weight_style="(tag:1.2)", underscore_to_space=False)[0],
    r"(color \(red\):1.5)",
)

nl = {"items": [{"kind": "tag", "text": "a"}, {"kind": "tag", "text": "b"}]}
eq("换行连接符", pb.build_prompt(nl, separator="\\n")[0], "a\nb")

# ---------------------------------------------------------------- 节点
print("\n[6] node build")
node = nodes.PromptTagSelector()
res = node.build(tag_config=json.dumps(cfg, ensure_ascii=False), seed=3)
check("节点返回 dict", isinstance(res, dict) and "result" in res and "ui" in res)
eq("节点输出提示词", res["result"][0], "masterpiece, 1girl, red hair")
eq("节点输出标签列表", res["result"][1], "masterpiece, 1girl, red hair")
res2 = node.build(tag_config="", manual_prompt="best, end", manual_mode="仅使用提示词框")
eq("手动提示词框独立输出", res2["result"][0], "best, end")

eq("输入类型含 tag_config", "tag_config" in nodes.PromptTagSelector.INPUT_TYPES()["required"], True)
_changed = nodes.PromptTagSelector.IS_CHANGED()[0] if isinstance(nodes.PromptTagSelector.IS_CHANGED(), tuple) else nodes.PromptTagSelector.IS_CHANGED()
check("IS_CHANGED 恒变(不缓存)", _changed != _changed, repr(_changed))

# 声明的输入必须全部能传进 build()，否则 ComfyUI 调用时必然 TypeError
import inspect

_types = nodes.PromptTagSelector.INPUT_TYPES()
_declared = set(_types.get("required", {})) | set(_types.get("optional", {}))
_params = set(inspect.signature(nodes.PromptTagSelector.build).parameters) - {"self"}
check("build 签名覆盖所有声明的输入", _declared <= _params, "缺少: %r" % sorted(_declared - _params))
check(
    "没有多余的必填参数",
    (_params - {"tag_config"}) <= _declared,
    "%r" % sorted(_params - _declared),
)
check("已删除 seed_mode 输入", "seed_mode" not in _declared)
check("已删除 prompt_prefix 输入", "prompt_prefix" not in _declared)
check("已删除 prompt_suffix 输入", "prompt_suffix" not in _declared)
check(
    "seed 使用 ComfyUI 生成后控制",
    _types["optional"]["seed"][1].get("control_after_generate") is True,
)

_full = node.build(
    tag_config=json.dumps(cfg, ensure_ascii=False),
    seed=1,
    separator=", ",
    dedupe=True,
    underscore_to_space=True,
    weight_style="(tag:1.2)",
    prompt_preview="随便写点什么",
)
eq("全参数调用不报错且预览不影响输出", _full["result"][0], "masterpiece, (1girl:1.2), red hair")

# ---------------------------------------------------------------- 整合后的节点
print("\n[6b] 提示词管理：三个节点 / 分类 / 删除简易版")
check(
    "注册了三个节点",
    set(nodes.NODE_CLASS_MAPPINGS) == {"PromptTagSelector", "PromptHistoryMerge", "PromptHistorySelector"},
    str(sorted(nodes.NODE_CLASS_MAPPINGS)),
)
check("简易版节点已删除", not hasattr(nodes, "PromptTagQuickList"))
check("简易版映射已删除", "PromptTagQuickList" not in nodes.NODE_DISPLAY_NAME_MAPPINGS)
check(
    "三个节点都在提示词管理分类",
    all(cls.CATEGORY == "提示词管理" for cls in nodes.NODE_CLASS_MAPPINGS.values()),
    str({name: cls.CATEGORY for name, cls in nodes.NODE_CLASS_MAPPINGS.items()}),
)
eq("随机tag显示名", nodes.NODE_DISPLAY_NAME_MAPPINGS["PromptTagSelector"], "汐皮笑脸的随机tag")
eq("tag合并显示名", nodes.NODE_DISPLAY_NAME_MAPPINGS["PromptHistoryMerge"], "汐皮笑脸的tag合并")
eq("tag历史板显示名", nodes.NODE_DISPLAY_NAME_MAPPINGS["PromptHistorySelector"], "汐皮笑脸的tag历史板")
_merge = nodes.NODE_CLASS_MAPPINGS["PromptHistoryMerge"]()
eq(
    "整合节点按输入口排序",
    _merge.merge(separator=", ", dedupe=True, prompt_1="a", prompt_2="b", prompt_3="c")[0],
    "a, b, c",
)
eq(
    "整合节点按 tag 去重（忽略大小写）",
    _merge.merge(
        separator=", ",
        dedupe=True,
        prompt_1="masterpiece, best quality, 1girl",
        prompt_2="masterpiece, BEST QUALITY, solo",
    )[0],
    "masterpiece, best quality, 1girl, solo",
)
eq(
    "整合节点去重时保留原换行",
    _merge.merge(separator=", ", dedupe=True, prompt_1="a\nb, a")[0],
    "a\nb",
)
eq(
    "整合节点关闭去重时保留重复",
    _merge.merge(separator=", ", dedupe=False, prompt_1="a, a")[0],
    "a, a",
)
check("历史接口前缀", ptm.history_routes.ROUTE_PREFIX == "/prompt_history")
check("历史存储模块可导入", hasattr(ptm, "history_store"))

# ---------------------------------------------------------------- 名字安全
print("\n[7] sanitize_name")
eq("路径穿越去掉分隔符", tag_store.sanitize_name("../../etc/passwd"), "etcpasswd")
check("不含斜杠", "/" not in tag_store.sanitize_name("../x/y"))
check("不含反斜杠", "\\" not in tag_store.sanitize_name("..\\x"))
eq("空名回退", tag_store.sanitize_name("   ", "回退"), "回退")
check("长度限制", len(tag_store.sanitize_name("x" * 300)) <= tag_store.MAX_NAME_LEN)
check("保留中文名", tag_store.sanitize_name("我的词库 A") == "我的词库 A")

# ---------------------------------------------------------------- 文件 CRUD
print("\n[8] library CRUD (临时目录)")
tmp = tempfile.mkdtemp(prefix="ptm_test_")
tag_store._USER_DIR_CACHE = tmp
saved = tag_store.save_library("我的词库", base)
eq("保存返回名", saved, "我的词库")
data, kind = tag_store.load_library("我的词库")
eq("回读一级分类数", len(data["groups"]), 2)
eq("回读 kind", kind, "user")
names = [x["name"] for x in tag_store.list_libraries()]
check("出现在列表里", "我的词库" in names, names)
renamed = tag_store.rename_library("我的词库", "改名后")
eq("重命名", renamed, "改名后")
check("旧名消失", not os.path.isfile(os.path.join(tmp, "我的词库.json")))
check("删除", tag_store.delete_library("改名后"))
try:
    tag_store.load_library("改名后")
    check("删除后读取失败", False)
except FileNotFoundError:
    check("删除后读取失败", True)

# 保存内置词库：没有只读保护，直接就地修改内置文件
builtin_names = [x["name"] for x in tag_store.list_libraries() if x["kind"] == "builtin"]
if builtin_names:
    first = builtin_names[0]
    builtin_path = os.path.join(_BUILTIN_TMP, first + ".json")
    before_bytes = open(builtin_path, "rb").read()

    saved = tag_store.save_library(first, base)
    eq("保存内置词库后名字不变", saved, first)
    lib2, kind2 = tag_store.load_library(first)
    eq("内置词库仍是 builtin", kind2, "builtin")
    eq("内置词库内容已更新", len(lib2["groups"]), 2)
    check(
        "内置文件被直接改写（不再另存副本）",
        open(builtin_path, "rb").read() != before_bytes,
        "文件没变",
    )
    check(
        "没有生成 <名字> (用户) 之类的副本",
        not any(x["name"].startswith(first + " (") for x in tag_store.list_libraries()),
        str([x["name"] for x in tag_store.list_libraries()]),
    )
    # 内置词库同样可以重命名和删除
    renamed_b = tag_store.rename_library(first, first + "_改名")
    eq("内置词库可以重命名", renamed_b, tag_store.sanitize_name(first + "_改名"))
    check(
        "重命名后旧文件消失",
        not os.path.isfile(builtin_path),
    )
    check("重命名后新文件在", os.path.isfile(os.path.join(_BUILTIN_TMP, renamed_b + ".json")))
    check("内置词库可以删除", tag_store.delete_library(renamed_b))
    check(
        "删除后真的没了",
        not os.path.isfile(os.path.join(_BUILTIN_TMP, renamed_b + ".json")),
    )

# ---------------------------------------------------------------- 导入接口
print("\n[9] import_library")
tag_store._USER_DIR_CACHE = tmp
r = tag_store.import_library(name="导入测试", text=csv_text, filename="x.csv", mode="replace")
eq("导入 replace tag 数", r["counts"]["tags"], 3)
r = tag_store.import_library(name="导入测试", text="人物,发色,green_hair\n", filename="y.csv", mode="merge")
eq("导入 merge 后 tag 数", r["counts"]["tags"], 4)
r = tag_store.import_library(text="a,b,c\n", filename="z.csv", mode="new", new_name="新词库X")
eq("导入 new 词库名", r["library"], "新词库X")
try:
    tag_store.import_library(name="空", text="", filename="empty.csv")
    check("空导入报错", False)
except ValueError:
    check("空导入报错", True)

# ---------------------------------------------------------------- 中文描述
print("\n[11] 中文描述(descs)")
desc_src = {
    "groups": [
        {
            "name": "人物",
            "subs": [
                {
                    "name": "发色",
                    "tags": [{"text": "red_hair", "desc": "红发"}, "blue_hair"],
                    "descs": {"blue_hair": "蓝发", "不存在的tag": "应该被清掉"},
                }
            ],
        }
    ]
}
dl = tag_store.normalize_library(desc_src, name="描述测试")
dsub = dl["groups"][0]["subs"][0]
eq("tag 仍是字符串", dsub["tags"], ["red_hair", "blue_hair"])
eq("dict 里的 desc 被提取", dsub["descs"].get("red_hair"), "红发")
eq("同级 descs 字段被合并", dsub["descs"].get("blue_hair"), "蓝发")
check("指向不存在 tag 的描述被清理", "不存在的tag" not in dsub.get("descs", {}))

csv_out = tag_store.export_library(dl, "csv")
check("CSV 导出带第 4 列描述", "红发" in csv_out["content"], csv_out["content"])
csv_back = tag_store.parse_text(csv_out["content"], filename="d.csv")
eq("CSV 回读描述", csv_back["groups"][0]["subs"][0]["descs"].get("red_hair"), "红发")
eq("CSV 回读 tag 数", tag_store.library_counts(csv_back)["tags"], 2)

json_back = tag_store.normalize_library(json.loads(tag_store.export_library(dl, "json")["content"]))
eq("JSON 往返保留描述", json_back["groups"][0]["subs"][0]["descs"]["blue_hair"], "蓝发")

merged_desc = tag_store.merge_library(tag_store.normalize_library({"人物": {"发色": ["red_hair"]}}), dl)
eq("合并时描述不丢", merged_desc["groups"][0]["subs"][0]["descs"].get("red_hair"), "红发")

no_desc = tag_store.export_library(tag_store.normalize_library({"a": {"b": ["c"]}}), "csv")
check("没有描述时 CSV 只有 3 列", no_desc["content"].strip().endswith("c"), repr(no_desc["content"]))

# ---------------------------------------------------------------- SQL 导入
print("\n[12] SQL 导入（WeiLin 导出）")
SQL_SAMPLE = """
INSERT OR REPLACE INTO "tag_groups" ("name", "color", "create_time", "p_uuid") VALUES ('人物', 'rgba(1)', 100, 'g1');
INSERT OR REPLACE INTO "tag_groups" ("name", "color", "create_time", "p_uuid") VALUES ('场景', 'rgba(1)', 200, 'g2');
INSERT OR REPLACE INTO "tag_subgroups" ("name", "color", "create_time", "p_uuid", "g_uuid") VALUES ('发色', 'rgba(1)', 150, 'g1', 's1');
INSERT OR REPLACE INTO "tag_subgroups" ("name", "color", "create_time", "p_uuid", "g_uuid") VALUES ('环境', 'rgba(1)', 250, 'g2', 's2');
INSERT OR REPLACE INTO "tag_tags" ("text", "desc", "color", "create_time", "g_uuid", "t_uuid") VALUES ('red_hair', '红发', 'rgba(1)', 300, 's1', 't1');
INSERT OR REPLACE INTO "tag_tags" ("text", "desc", "color", "create_time", "g_uuid", "t_uuid") VALUES ('blue_eyes', '蓝眼', 'rgba(1)', 200, 's1', 't2');
INSERT OR REPLACE INTO "tag_tags" ("text", "desc", "color", "create_time", "g_uuid", "t_uuid") VALUES ('forest', '森林', 'rgba(1)', 100, 's2', 't3');
INSERT OR REPLACE INTO "tag_tags" ("text", "desc", "color", "create_time", "g_uuid", "t_uuid") VALUES ('it''s_tag', '带单引号', 'rgba(1)', 50, 's2', 't4');
INSERT OR REPLACE INTO "tag_tags" ("text", "desc", "color", "create_time", "g_uuid", "t_uuid") VALUES ('semi;colon', '含分号', 'rgba(1)', 40, 's2', 't5');
INSERT OR REPLACE INTO "tag_tags" ("text", "desc", "color", "create_time", "g_uuid", "t_uuid") VALUES ('empty_desc', '', 'rgba(1)', 30, 's2', 't6');
"""
check("能识别 SQL", tag_store.looks_like_sql(SQL_SAMPLE))
check("普通 CSV 不会被误判为 SQL", not tag_store.looks_like_sql("人物,发色,red_hair\n"))

sl = tag_store.parse_text(SQL_SAMPLE, filename="x.sql")
sc = tag_store.library_counts(sl)
eq("SQL 一级分类数", sc["groups"], 2)
eq("SQL 二级分类数", sc["subs"], 2)
eq("SQL tag 总数", sc["tags"], 6)
eq("SQL 一级分类按创建时间排序", [g["name"] for g in sl["groups"]], ["人物", "场景"])
eq("SQL 二级分类挂对父级", sl["groups"][1]["subs"][0]["name"], "环境")
eq("SQL tag 按创建时间倒序", sl["groups"][0]["subs"][0]["tags"], ["red_hair", "blue_eyes"])
eq("SQL 描述被保留", sl["groups"][0]["subs"][0]["descs"].get("red_hair"), "红发")
scene_tags = sl["groups"][1]["subs"][0]["tags"]
check("SQL 单引号转义正确", "it's_tag" in scene_tags, str(scene_tags))
check("SQL 字符串里的分号不截断语句", "semi;colon" in scene_tags, str(scene_tags))
check("空描述不产生 descs", "empty_desc" not in (sl["groups"][1]["subs"][0].get("descs") or {}))

# 多行 VALUES + 大写关键字
MULTI_SQL = (
    'insert into "tag_groups" ("name","p_uuid","create_time") values (\'A\',\'ga\',1);\n'
    'insert into "tag_subgroups" ("name","p_uuid","g_uuid","create_time") values (\'B\',\'ga\',\'sb\',2);\n'
    'insert into "tag_tags" ("text","g_uuid","desc") values (\'x\',\'sb\',\'甲\'),(\'y\',\'sb\',\'乙\');\n'
)
ms = tag_store.parse_text(MULTI_SQL, filename="m.sql")
eq("多行 VALUES 解析", tag_store.library_counts(ms)["tags"], 2)
eq("大写/小写 INSERT 都能识别", ms["groups"][0]["name"], "A")

try:
    tag_store.parse_text("INSERT INTO other VALUES (1);", filename="bad.sql")
    check("非 WeiLin SQL 报错", False)
except ValueError:
    check("非 WeiLin SQL 报错", True)

sql_export = tag_store.export_library(sl, "json")["content"]
eq("SQL 导入后可导出 JSON", json.loads(sql_export)["groups"][0]["name"], "人物")

# ------------------------------------------------------- 大文件：流式解析/拆分
print("\n[14] 从文件路径导入 + 拆分")

_tmpdir = tempfile.mkdtemp(prefix="ptm_file_")
tag_store._USER_DIR_CACHE = _tmpdir
_big_sql = os.path.join(_tmpdir, "big.sql")
_lines = [
    "INSERT OR REPLACE INTO \"tag_groups\" (\"name\", \"color\", \"create_time\", \"p_uuid\") VALUES ('G1', 'rgba', 10, 'g1');",
    "INSERT OR REPLACE INTO \"tag_groups\" (\"name\", \"color\", \"create_time\", \"p_uuid\") VALUES ('G2', 'rgba', 20, 'g2');",
    "INSERT OR REPLACE INTO \"tag_subgroups\" (\"name\", \"color\", \"create_time\", \"p_uuid\", \"g_uuid\") VALUES ('S1', 'rgba', 11, 'g1', 's1');",
    "INSERT OR REPLACE INTO \"tag_subgroups\" (\"name\", \"color\", \"create_time\", \"p_uuid\", \"g_uuid\") VALUES ('S2', 'rgba', 12, 'g1', 's2');",
    "INSERT OR REPLACE INTO \"tag_subgroups\" (\"name\", \"color\", \"create_time\", \"p_uuid\", \"g_uuid\") VALUES ('S3', 'rgba', 21, 'g2', 's3');",
]
for sub, count in (("s1", 4), ("s2", 3), ("s3", 5)):
    for i in range(count):
        _lines.append(
            "INSERT OR REPLACE INTO \"tag_tags\" (\"text\", \"desc\", \"color\", \"create_time\", \"g_uuid\", \"t_uuid\") "
            "VALUES ('%s_tag_%d', '%s译', 'rgba', %d, '%s', 't_%s_%d');" % (sub, i, sub, 100 - i, sub, sub, i)
        )
# 再来一条跨行的 INSERT，验证流式解析器能拼起来
_lines.append(
    "INSERT OR REPLACE INTO \"tag_tags\" (\"text\", \"desc\", \"color\", \"create_time\", \"g_uuid\", \"t_uuid\")\n"
    "VALUES ('multiline_tag', '跨行', 'rgba', 1, 's3', 't_ml');"
)
with open(_big_sql, "w", encoding="utf-8") as f:
    f.write("\n".join(_lines) + "\n")

_parsed = tag_store.parse_sql_file(_big_sql)
_c = tag_store.library_counts(_parsed)
eq("流式解析一级分类数", _c["groups"], 2)
eq("流式解析二级分类数", _c["subs"], 3)
eq("流式解析 tag 数", _c["tags"], 13)
check(
    "流式解析跨行 INSERT",
    "multiline_tag" in _parsed["groups"][1]["subs"][0]["tags"],
    str(_parsed["groups"][1]["subs"][0]["tags"]),
)
eq("流式解析保留描述", _parsed["groups"][0]["subs"][0]["descs"].get("s1_tag_0"), "s1译")

_pf = tag_store.parse_file(_big_sql, name="路径导入")
eq("parse_file 按扩展名解析", tag_store.library_counts(_pf)["tags"], 13)

_json_path = os.path.join(_tmpdir, "x.json")
with open(_json_path, "w", encoding="utf-8") as f:
    json.dump({"groups": [{"name": "A", "subs": [{"name": "B", "tags": ["t1", "t2"]}]}]}, f)
eq("parse_file 读 JSON", tag_store.library_counts(tag_store.parse_file(_json_path))["tags"], 2)

_csv_path = os.path.join(_tmpdir, "x.csv")
with open(_csv_path, "w", encoding="utf-8") as f:
    f.write("A,B,t1,说明1\nA,B,t2\n")
_csv_lib = tag_store.parse_file(_csv_path)
eq("parse_file 读 CSV", tag_store.library_counts(_csv_lib)["tags"], 2)
eq("parse_file 读 CSV 描述", _csv_lib["groups"][0]["subs"][0]["descs"].get("t1"), "说明1")

try:
    tag_store.parse_file(os.path.join(_tmpdir, "nope.sql"))
    check("不存在的文件报错", False)
except FileNotFoundError:
    check("不存在的文件报错", True)

# 拆分：按二级分类整体切，不把一个二级分类拆散
_split_lib = tag_store.normalize_library(
    {
        "groups": [
            {"name": "G", "subs": [
                {"name": "A", "tags": ["a1", "a2"]},
                {"name": "B", "tags": ["b1", "b2", "b3"]},
                {"name": "C", "tags": ["c1"]},
                {"name": "D", "tags": ["d1", "d2"]},
            ]}
        ]
    },
    name="拆分测试",
)
_parts = tag_store.split_library(_split_lib, 3)
check("拆分成了多份", len(_parts) >= 2, str(len(_parts)))
_names = [p["name"] for p in _parts]
check("拆分后名字带序号", _names[0].startswith("拆分测试-") and _names[1].startswith("拆分测试-"), str(_names))
_total = sum(tag_store.library_counts(p)["tags"] for p in _parts)
eq("拆分后总数不变", _total, 8)
_all_subs = [s["name"] for p in _parts for g in p["groups"] for s in g["subs"]]
eq("拆分后二级分类不重复不丢失", sorted(_all_subs), ["A", "B", "C", "D"])
for p in _parts:
    sizes = [len(s["tags"]) for g in p["groups"] for s in g["subs"]]
    check("每份不超过上限（单分类可略超）", sum(sizes) <= 3 + max(sizes or [0]), str(sizes))

eq("小词库不拆分", len(tag_store.split_library(_split_lib, 100)), 1)

# import_path：不拆分 / 拆分
_p = tag_store.import_path(_big_sql, name="路径库", mode="new")
eq("import_path 新建词库", _p["library"], "路径库")
eq("import_path 落盘 tag 数", tag_store.library_counts(tag_store.load_library("路径库")[0])["tags"], 13)

_p2 = tag_store.import_path(_big_sql, name="拆分路径库", split=5)
check("import_path 触发拆分", _p2["split"] is True, str(_p2.get("split")))
check("import_path 拆出多份", len(_p2["libraries"]) >= 2, str(len(_p2["libraries"])))
eq(
    "拆分后总数不变",
    sum(x["counts"]["tags"] for x in _p2["libraries"]),
    13,
)
for item in _p2["libraries"]:
    check("拆分出的词库可读 %s" % item["name"], not tag_store.load_library(item["name"])[0].get("error"))

# ------------------------------------------------------- 随机池「只存引用」
print("\n[18] 随机池只存引用（避免把工作流撑大）")


def _fake_resolver(library, group, sub):
    return ["%s/%s/%s_%d" % (library, group, sub, i) for i in range(50)]


_ref_cfg = {
    "v": 1,
    "library": "演示库",
    "items": [
        {
            "kind": "pool",
            "label": "演示库/发色",
            "library": "演示库",
            "group": "人物",
            "sub": "发色",
            "count": 2,
            "weight": 1.0,
            "enabled": True,
            "size": 50,
        }
    ],
}
_loaded = pb.load_config(_ref_cfg)
eq("ref 池被保留", len(_loaded["items"]), 1)
check("ref 池此时还没有候选", _loaded["items"][0]["tags"] == [])
eq("ref 标记", _loaded["items"][0]["ref"], True)
_prompt0, _tags0 = pb.build_prompt(_ref_cfg, seed=1, underscore_to_space=False)
eq("没有 resolver 时不报错、输出为空", _tags0, [])

_prompt1, _tags1 = pb.build_prompt(_ref_cfg, seed=3, underscore_to_space=False, resolver=_fake_resolver)
eq("有 resolver 时抽出 count 条", len(_tags1), 2)
check("抽出内容来自解析结果", all(t.startswith("演示库/人物/发色_") for t in _tags1), str(_tags1))
_prompt2, _tags2 = pb.build_prompt(_ref_cfg, seed=3, underscore_to_space=False, resolver=_fake_resolver)
eq("同种子可复现", _tags1, _tags2)

_old_cfg = {
    "items": [{"kind": "pool", "label": "旧池", "count": 1, "weight": 1.0, "enabled": True, "tags": ["a", "b", "c"]}]
}
_, _old_tags = pb.build_prompt(_old_cfg, seed=1, underscore_to_space=False, dedupe=False)
eq("老格式随机池（自带候选）仍可用", len(_old_tags), 1)


def _broken_resolver(library, group, sub):
    raise FileNotFoundError("词库不存在")


_, _broken_tags = pb.build_prompt(_ref_cfg, seed=1, resolver=_broken_resolver)
eq("resolver 失败时优雅跳过", _broken_tags, [])

_real_sub = None
for _g in tag_store.load_library("renwu")[0]["groups"]:
    for _s in _g["subs"]:
        if _s["tags"]:
            _real_sub = (_g["name"], _s["name"], len(_s["tags"]))
            break
    if _real_sub:
        break
if _real_sub:
    _real_tags = tag_store.library_sub_tags("renwu", _real_sub[0], _real_sub[1])
    eq("library_sub_tags 返回该二级分类全部 tag", len(_real_tags), _real_sub[2])
    _group_tags = tag_store.library_sub_tags("renwu", _real_sub[0], "*")
    check("sub=* 返回整个一级分类", len(_group_tags) >= len(_real_tags), str(len(_group_tags)))
    check("library_sub_tags 用了缓存", len(tag_store._LIB_READ_CACHE) > 0)

    _ref_node_cfg = json.dumps(
        {
            "v": 1,
            "library": "renwu",
            "items": [
                {
                    "kind": "pool",
                    "label": "renwu/人物",
                    "library": "renwu",
                    "group": _real_sub[0],
                    "sub": _real_sub[1],
                    "count": 3,
                    "weight": 1.0,
                    "enabled": True,
                }
            ],
        },
        ensure_ascii=False,
    )
    _node_out = nodes.PromptTagSelector().build(tag_config=_ref_node_cfg, seed=11)
    _tags_out = _node_out["result"][1]
    check("节点能用引用式随机池产出内容", len(_tags_out) > 0, _tags_out[:80])
    eq("节点产出 3 个 tag", len(_tags_out.split(", ")), 3)
    check("引用式配置很小", len(_ref_node_cfg.encode("utf-8")) < 800, "%d 字节" % len(_ref_node_cfg))

    # 体积对比：内嵌 vs 引用
    _embed_cfg = json.dumps(
        {
            "items": [
                {
                    "kind": "pool",
                    "label": "x",
                    "count": 1,
                    "weight": 1.0,
                    "enabled": True,
                    "tags": _real_tags,
                }
            ]
        },
        ensure_ascii=False,
    )
    check(
        "引用式配置比内嵌小 10 倍以上",
        len(_embed_cfg) > len(_ref_node_cfg) * 10,
        "内嵌 %d 字节 vs 引用 %d 字节" % (len(_embed_cfg), len(_ref_node_cfg)),
    )

# ------------------------------------------------------- 手动提示词框
print("\n[19] 手动提示词框 + 使用方式")
eq("使用方式是 4 种", len(pb.MANUAL_MODES), 4)
check("默认是两者结合", pb.DEFAULT_MANUAL_MODE.startswith("两者结合"), pb.DEFAULT_MANUAL_MODE)

eq(
    "结合：提示词框在前",
    pb.combine_prompt("masterpiece, best quality", "red hair, blue eyes", "两者结合（提示词框在前）"),
    "masterpiece, best quality, red hair, blue eyes",
)
eq(
    "结合：提示词框在后",
    pb.combine_prompt("masterpiece", "red hair", "两者结合（提示词框在后）"),
    "red hair, masterpiece",
)
eq("仅使用提示词框（忽略 tag）", pb.combine_prompt("只用手写", "tag_a, tag_b", "仅使用提示词框"), "只用手写")
eq("仅使用 TAG 词库（忽略手写）", pb.combine_prompt("手写要被忽略", "tag_a, tag_b", "仅使用 TAG 词库"), "tag_a, tag_b")
eq("手写为空时只出 tag", pb.combine_prompt("", "tag_a", "两者结合（提示词框在前）"), "tag_a")
eq("tag 为空时只出手写", pb.combine_prompt("手写", "", "两者结合（提示词框在后）"), "手写")
eq("都为空", pb.combine_prompt("", "", "两者结合（提示词框在前）"), "")
eq("非法模式回退默认", pb.combine_prompt("A", "B", "乱写的模式"), "A, B")
eq("自定义连接符", pb.combine_prompt("A", "B", "两者结合（提示词框在前）", separator=" | "), "A | B")
eq("连接符支持 \\n", pb.combine_prompt("A", "B", "两者结合（提示词框在前）", separator="\\n"), "A\nB")
eq("多行原样保留", pb.combine_prompt("第一行\n第二行", "", "仅使用提示词框"), "第一行\n第二行")
eq("多余空行被压缩", pb.clean_manual_prompt("a\n\n\n\nb\n"), "a\n\nb")
eq("首尾空白被去掉", pb.clean_manual_prompt("  x  \n"), "x")
check("仅提示词框不需要 tag", pb.uses_tags("仅使用提示词框") is False)
check("仅 TAG 词库不需要手写", pb.uses_manual("仅使用 TAG 词库") is False)

_node = nodes.PromptTagSelector()
_tag_cfg = json.dumps({"items": [{"kind": "tag", "text": "1girl", "weight": 1.0}]}, ensure_ascii=False)

eq(
    "节点：两者结合（前）",
    _node.build(tag_config=_tag_cfg, manual_prompt="masterpiece", manual_mode="两者结合（提示词框在前）")["result"][0],
    "masterpiece, 1girl",
)
eq(
    "节点：两者结合（后）",
    _node.build(tag_config=_tag_cfg, manual_prompt="solo", manual_mode="两者结合（提示词框在后）")["result"][0],
    "1girl, solo",
)
eq(
    "节点：仅提示词框",
    _node.build(tag_config=_tag_cfg, manual_prompt="只用手写提示词", manual_mode="仅使用提示词框")["result"][0],
    "只用手写提示词",
)
_only_tag = _node.build(tag_config=_tag_cfg, manual_prompt="忽略我", manual_mode="仅使用 TAG 词库")
eq("节点：仅 TAG 词库", _only_tag["result"][0], "1girl")
eq("节点：仅 TAG 词库时标签列表正常", _only_tag["result"][1], "1girl")
eq(
    "节点：仅提示词框时标签列表为空",
    _node.build(tag_config=_tag_cfg, manual_prompt="x", manual_mode="仅使用提示词框")["result"][1],
    "",
)
eq(
    "节点：手写支持权重语法（原样保留）",
    _node.build(tag_config="", manual_prompt="(1girl:1.2), solo", manual_mode="仅使用提示词框")["result"][0],
    "(1girl:1.2), solo",
)
eq(
    "节点：不选 tag 也能只用提示词框",
    _node.build(tag_config="", manual_prompt="free form prompt", manual_mode="仅使用提示词框")["result"][0],
    "free form prompt",
)
check("节点声明里有 manual_mode", "manual_mode" in nodes.PromptTagSelector.INPUT_TYPES()["optional"])
check("节点声明里有 manual_prompt", "manual_prompt" in nodes.PromptTagSelector.INPUT_TYPES()["optional"])
check(
    "manual_prompt 是多行文本",
    bool(nodes.PromptTagSelector.INPUT_TYPES()["optional"]["manual_prompt"][1].get("multiline")),
)

# ----------------------------------------- 空格转连接符 + 节点名
print("\n[20] 空格转连接符 / 节点显示名")
check("声明了 manual_space_as_sep", "manual_space_as_sep" in nodes.PromptTagSelector.INPUT_TYPES()["optional"])
check(
    "空格转连接符默认关闭",
    nodes.PromptTagSelector.INPUT_TYPES()["optional"]["manual_space_as_sep"][1].get("default") is False,
)
eq("节点显示名", nodes.NODE_DISPLAY_NAME_MAPPINGS["PromptTagSelector"], "汐皮笑脸的随机tag")

eq(
    "默认不转换（多词 tag 保留）",
    pb.combine_prompt("masterpiece best quality", "", "仅使用提示词框"),
    "masterpiece best quality",
)
eq(
    "开启后空格转逗号",
    pb.combine_prompt("masterpiece best quality solo", "", "仅使用提示词框", space_as_separator=True),
    "masterpiece, best, quality, solo",
)
eq(
    "换行也换成连接符",
    pb.combine_prompt("1girl\nlong_hair  solo", "", "仅使用提示词框", space_as_separator=True),
    "1girl, long_hair, solo",
)
eq(
    "用自定义连接符",
    pb.combine_prompt("a b c", "", "仅使用提示词框", separator=" | ", space_as_separator=True),
    "a | b | c",
)
eq(
    "连接符为换行时按行拆",
    pb.combine_prompt("a b", "", "仅使用提示词框", separator="\\n", space_as_separator=True),
    "a\nb",
)
eq(
    "权重语法原样保留",
    pb.combine_prompt("(1girl:1.2) solo", "", "仅使用提示词框", space_as_separator=True),
    "(1girl:1.2), solo",
)
eq(
    "和 tag 结合时也转换",
    pb.combine_prompt("a b", "x, y", "两者结合（提示词框在前）", space_as_separator=True),
    "a, b, x, y",
)
eq(
    "仅 TAG 词库模式不受影响",
    pb.combine_prompt("a b", "x", "仅使用 TAG 词库", space_as_separator=True),
    "x",
)
eq("空提示词不产生空项", pb.combine_prompt("   ", "", "仅使用提示词框", space_as_separator=True), "")
eq("split_manual_by_space 单独可用", pb.split_manual_by_space(" a  b\nc ", ", "), "a, b, c")

_n = nodes.PromptTagSelector()
eq(
    "节点：开启空格转连接符",
    _n.build(tag_config="", manual_prompt="a b c", manual_mode="仅使用提示词框", manual_space_as_sep=True)["result"][0],
    "a, b, c",
)
eq(
    "节点：关闭时保持原样",
    _n.build(tag_config="", manual_prompt="a b c", manual_mode="仅使用提示词框", manual_space_as_sep=False)["result"][0],
    "a b c",
)
eq(
    "节点：错位值也能兜底（字符串 'true'）",
    _n.build(tag_config="", manual_prompt="a b", manual_mode="仅使用提示词框", manual_space_as_sep="true")["result"][0],
    "a, b",
)

# ----------------------------------------- 自然语言框 + 选项说明
print("\n[21] 自然语言框 / 选项说明")
check("声明了 natural_prompt", "natural_prompt" in nodes.PromptTagSelector.INPUT_TYPES()["optional"])
check("声明了 natural_append", "natural_append" in nodes.PromptTagSelector.INPUT_TYPES()["optional"])
check(
    "natural_prompt 是多行文本",
    bool(nodes.PromptTagSelector.INPUT_TYPES()["optional"]["natural_prompt"][1].get("multiline")),
)
check(
    "natural_append 默认关闭",
    nodes.PromptTagSelector.INPUT_TYPES()["optional"]["natural_append"][1].get("default") is False,
)

_nat = "a girl standing in the rain, cinematic lighting"
eq(
    "不组合时自然语言不参与",
    pb.combine_prompt("a", "x, y", "两者结合（提示词框在前）", natural=_nat, natural_append=False),
    "a, x, y",
)
eq(
    "组合在末尾",
    pb.combine_prompt("a", "x, y", "两者结合（提示词框在前）", natural=_nat, natural_append=True),
    "a, x, y, " + _nat,
)
eq(
    "没有 tag 时只有自然语言",
    pb.combine_prompt("", "", "两者结合（提示词框在前）", natural=_nat, natural_append=True),
    _nat,
)
eq(
    "仅提示词框模式下也追加",
    pb.combine_prompt("only", "", "仅使用提示词框", natural="nature", natural_append=True),
    "only, nature",
)
eq(
    "自然语言不受空格转连接符影响",
    pb.combine_prompt("a b", "", "仅使用提示词框", space_as_separator=True, natural="girl in rain", natural_append=True),
    "a, b, girl in rain",
)
eq(
    "自定义连接符也用于自然语言",
    pb.combine_prompt("a", "b", "两者结合（提示词框在前）", separator=" | ", natural="nat", natural_append=True),
    "a | b | nat",
)
eq(
    "自然语言里的空行被压缩",
    pb.combine_prompt("", "", "两者结合（提示词框在前）", natural="x\n\n\n\ny", natural_append=True),
    "x\n\ny",
)

_nat_node = nodes.PromptTagSelector()
eq(
    "节点：自然语言组合在末尾",
    _nat_node.build(
        tag_config=json.dumps({"items": [{"kind": "tag", "text": "1girl", "weight": 1.0}]}),
        natural_prompt="sitting by a window",
        natural_append=True,
    )["result"][0],
    "1girl, sitting by a window",
)
eq(
    "节点：自然语言默认不组合",
    _nat_node.build(
        tag_config=json.dumps({"items": [{"kind": "tag", "text": "1girl", "weight": 1.0}]}),
        natural_prompt="sitting by a window",
        natural_append=False,
    )["result"][0],
    "1girl",
)
eq(
    "节点：错位值也能兜底",
    _nat_node.build(tag_config="", natural_prompt=123, natural_append="yes")["result"][0],
    "",
)

# 所有输入都必须有 tooltip（用户要求「未作解释的选项都注释解释」）
for _cls in (nodes.PromptTagSelector,):
    _types = _cls.INPUT_TYPES()
    for _section in ("required", "optional"):
        for _name, _spec in _types.get(_section, {}).items():
            _tip = _spec[1].get("tooltip") if len(_spec) > 1 else None
            check("%s.%s 有 tooltip" % (_cls.__name__, _name), bool(_tip and _tip.strip()), repr(_tip))
    check("%s 有 DESCRIPTION" % _cls.__name__, bool((_cls.DESCRIPTION or "").strip()))

# ------------------------------------- 生成后控制 / 逗号收敛 / 选项说明
print("\n[22] 生成后控制 + 逗号收敛")

check("已删除 seed_mode 选项", "seed_mode" not in nodes.PromptTagSelector.INPUT_TYPES()["optional"])
check(
    "seed 使用 ComfyUI 自带 control_after_generate",
    nodes.PromptTagSelector.INPUT_TYPES()["optional"]["seed"][1].get("control_after_generate") is True,
)
check(
    "不再声明 hidden.unique_id",
    "unique_id" not in nodes.PromptTagSelector.INPUT_TYPES().get("hidden", {}),
)
_w_names = list(nodes.PromptTagSelector.INPUT_TYPES()["required"]) + list(
    nodes.PromptTagSelector.INPUT_TYPES()["optional"]
)
check(
    "seed 后直接是 separator",
    _w_names.index("separator") == _w_names.index("seed") + 1,
    str(_w_names[:4]),
)
check("已删除 prompt_prefix/prompt_suffix", "prompt_prefix" not in _w_names and "prompt_suffix" not in _w_names)

_pool_cfg = json.dumps(
    {
        "items": [
            {
                "kind": "pool",
                "library": "renwu",
                "group": "人物",
                "sub": "头发",
                "count": 2,
                "weight": 1.0,
                "enabled": True,
                "size": 200,
            }
        ]
    },
    ensure_ascii=False,
)
_snode = nodes.PromptTagSelector()
_s_fixed_1 = _snode.build(tag_config=_pool_cfg, seed=7)["result"][0]
_s_fixed_2 = _snode.build(tag_config=_pool_cfg, seed=7)["result"][0]
eq("同种子结果一致", _s_fixed_1, _s_fixed_2)

# 粘贴内容自带逗号时不能出现 ", ,"
print("\n[23] 粘贴带逗号的提示词不产生多余逗号")
for _label, _manual in (
    ("末尾逗号+空格", "masterpiece, best quality, "),
    ("末尾只有逗号", "masterpiece, best quality,"),
    ("末尾逗号+换行", "masterpiece,\n"),
    ("中间双逗号", "masterpiece,, best quality"),
    ("中间逗号加空格", "masterpiece, , best quality"),
):
    _out = pb.combine_prompt(_manual, "1girl", "两者结合（提示词框在前）")
    check(
        "combine_prompt 不出现连续逗号：%s" % _label,
        ",," not in _out.replace(" ", "") and "，," not in _out,
        _out,
    )
    check(
        "结果以 tag 结尾：%s" % _label,
        _out.endswith("1girl"),
        _out,
    )
eq(
    "末尾逗号被清理",
    pb.combine_prompt("a, ", "b", "两者结合（提示词框在前）"),
    "a, b",
)
eq(
    "清理后仍保留中间逗号",
    pb.combine_prompt("a, c, ", "b", "两者结合（提示词框在前）"),
    "a, c, b",
)
eq(
    "自然语言末尾逗号也清理",
    pb.combine_prompt("a", "b", "两者结合（提示词框在前）", natural="nature, ", natural_append=True),
    "a, b, nature",
)
eq("collapse_separators 单独可用", pb.collapse_separators("a,, b, , c"), "a, b, c")

# ---------------------------------------------------------- 翻译接口
print("\n[24] 翻译接口")
tr = ptm.translate

check("默认服务是免费的 mymemory", tr.DEFAULT_SETTINGS["provider"] == "mymemory", tr.DEFAULT_SETTINGS["provider"])
check("默认目标语言是中文", tr.DEFAULT_SETTINGS["target"] == "zh-CN", tr.DEFAULT_SETTINGS["target"])
check("可选服务里含 fake（离线测试用）", "fake" in tr.PROVIDERS, str(tr.PROVIDERS))

_tr_dir = tempfile.mkdtemp(prefix="ptm_translate_")
tag_store._USER_DIR_CACHE = _tr_dir
tr._memory_cache.clear()
tr._cache_loaded = False

_cfg = tr.save_settings({"provider": "fake", "target": "zh-CN", "source": "auto"})
eq("保存设置：服务", _cfg["provider"], "fake")
eq("保存设置：目标语言", _cfg["target"], "zh-CN")
eq("重新读取设置", tr.get_settings()["provider"], "fake")
_pub = tr.public_settings()
eq("公开设置里不暴露 api_key", _pub["api_key"], "")
check("公开设置里标明是否已填 Key", _pub["has_api_key"] is False)
check("公开设置带服务名列表", isinstance(_pub["provider_labels"], dict), "")

_one = tr.translate_one("long hair")
check("单条翻译有结果", bool(_one), _one)
eq("第二次命中缓存", tr.translate_many(["long hair"])["cached"], 1)

_batch = tr.translate_many(["a", "b", "a", "", "  "])
eq("批量去重后翻译 2 条", _batch["total"], 2)
eq("批量结果条数", len(_batch["translations"]), 2)
eq("批量没有失败", _batch["failed"], 0)
check("缓存文件写出来了", os.path.isfile(os.path.join(_tr_dir, tr.CACHE_FILENAME)))
check(
    "缓存文件不会被当成词库",
    not any(n.startswith(".") for n in [x["name"] for x in tag_store.list_libraries()]),
)

_t = tr.test_translate()
check("自检返回 ok", _t.get("ok") is True, str(_t))
eq("自检用的服务", _t.get("provider"), "fake")
check("清缓存能清掉", tr.clear_cache() >= 0)

_norm = tr.normalize_settings({"provider": "不存在的服务", "target": "xx", "source": "yy"})
eq("非法服务回退默认", _norm["provider"], "mymemory")
eq("非法目标语言回退", _norm["target"], "zh-CN")
eq("非法源语言回退", _norm["source"], "auto")

try:
    tr.translate_one("x", {"provider": "libretranslate", "base_url": "", "fallback": False})
    check("libretranslate 缺地址时报错", False)
except Exception as exc:
    check("libretranslate 缺地址时报错", "地址" in str(exc), str(exc))

# ------------------------------------- 控件顺序 / 兜底
print("\n[20] 控件顺序与脏值兜底")

_widget_names = list(nodes.PromptTagSelector.INPUT_TYPES()["required"]) + list(
    nodes.PromptTagSelector.INPUT_TYPES()["optional"]
)
check(
    "参数顺序：tag_config/seed/separator 在最前",
    _widget_names[:4] == ["tag_config", "seed", "separator", "dedupe"],
    str(_widget_names[:6]),
)
check(
    "已移除 seed_mode / 前后缀",
    not any(name in _widget_names for name in ("seed_mode", "prompt_prefix", "prompt_suffix")),
    str(_widget_names),
)
check("prompt_preview 仍在最后", _widget_names[-1] == "prompt_preview", str(_widget_names[-1]))

_new_values = [
    json.dumps({"items": [{"kind": "tag", "text": "1girl", "weight": 1.0}]}, ensure_ascii=False),
    0,          # seed
    ", ",       # separator
    True,       # dedupe
    True,       # underscore_to_space
    "不输出权重",  # weight_style
    "两者结合（提示词框在前）",  # manual_mode
    "",         # manual_prompt
    False,      # manual_space_as_sep
    "",         # natural_prompt
    False,      # natural_append
    "",         # prompt_preview
]
_new = dict(zip(_widget_names, _new_values))
eq("新布局字段对位正确", nodes.PromptTagSelector().build(**_new)["result"][0], "1girl")

# 就算参数被串成乱七八糟的类型（老 bug 的表现），也不能崩
_junk = {
    "tag_config": json.dumps({"items": [{"kind": "tag", "text": "a"}, {"kind": "tag", "text": "b"}]}),
    "seed": "abc",
    "separator": True,          # ← 就是这个让之前崩了
    "dedupe": "x",
    "underscore_to_space": 0,
    "weight_style": 123,
    "manual_mode": 0,
    "manual_prompt": True,
    "prompt_preview": None,
}
_junk_out = nodes.PromptTagSelector().build(**_junk)
eq("错位垃圾值也不会崩（separator 回退默认）", _junk_out["result"][0], "a, b")
eq("错位时 seed 回退 0", pb.build_prompt({"items": [{"kind": "tag", "text": "x"}]}, seed="abc")[0], "x")
eq(
    "build_prompt 自己也会兜底 separator",
    pb.build_prompt({"items": [{"kind": "tag", "text": "x"}, {"kind": "tag", "text": "y"}]}, separator=True)[0],
    "x, y",
)
eq(
    "build_prompt 兜底 weight_style 为不输出权重",
    pb.build_prompt({"items": [{"kind": "tag", "text": "x", "weight": 1.5}]}, weight_style=123, underscore_to_space=False)[0],
    "x",
)

# ---------------------------------------------------------------- 内置词库
print("\n[15] builtin 词库")
for entry in tag_store.list_libraries():
    if entry["kind"] == "builtin":
        check("内置词库可读 %s" % entry["name"], not entry.get("error"), entry.get("error", ""))
        check(
            "内置词库有 tag %s" % entry["name"],
            entry["counts"]["tags"] > 0,
            str(entry["counts"]),
        )

default_name = tag_store.get_default_library_name()
eq("默认词库是内置人物词库", default_name, "renwu")
eq("DEFAULT_LIBRARY_NAME 与默认一致", tag_store.DEFAULT_LIBRARY_NAME, default_name)
default_counts = None
for entry in tag_store.list_libraries():
    if entry["name"] == default_name:
        default_counts = entry["counts"]
check("默认词库可读", bool(default_counts), default_name)
if default_counts:
    check(
        "预置词库不会抢走默认",
        default_name == tag_store.DEFAULT_LIBRARY_NAME,
        "默认=%s" % default_name,
    )

# 命名以 . 开头的文件（索引等）不能被当成词库
names_all = [x["name"] for x in tag_store.list_libraries()]
check("索引文件不会被列成词库", not any(n.startswith(".") for n in names_all), str(names_all))
check("列表里没有重复", len(names_all) == len(set(names_all)), str(names_all))

# 词库统计索引：第二次调用应该非常快（命中缓存）
_t0 = __import__("time").time()
tag_store.list_libraries()
_t1 = __import__("time").time()
check("list_libraries 命中索引后很快", (_t1 - _t0) < 0.5, "%.3f s" % (_t1 - _t0))

# 预置的「一键模式」库（来自用户的 119MB SQL，按二级分类拆成多份）
_yijian = [x for x in tag_store.list_libraries() if x["name"].startswith("yijian")]
if _yijian:
    _sum = sum(x["counts"]["tags"] for x in _yijian)
    check("预置一键模式词库已就位", _sum > 100000, "共 %d 个 tag / %d 份" % (_sum, len(_yijian)))
    check("预置词库都是内置且可读", all(x["kind"] == "builtin" and not x.get("error") for x in _yijian))
    _first = tag_store.load_library(_yijian[0]["name"])[0]
    _nonempty = next((s for g in _first["groups"] for s in g["subs"] if s["tags"]), None)
    check("预置词库里有非空二级分类", _nonempty is not None, _yijian[0]["name"])
    if _nonempty:
        _sample = _nonempty["tags"][0]
        check("预置内容是整句提示词", "," in _sample, _sample[:60])
        check("预置内容是完整 prompt", len(_sample) > 100, str(len(_sample)))

# 环境变量能覆盖默认词库
os.environ["PROMPT_TAG_DEFAULT_LIBRARY"] = "danbooru_basic"
eq("环境变量可指定默认词库", tag_store.get_default_library_name(), "danbooru_basic")
os.environ.pop("PROMPT_TAG_DEFAULT_LIBRARY", None)
eq("取消环境变量后回到内置默认", tag_store.get_default_library_name(), "renwu")

renwu_path = os.path.join(tag_store.BUILTIN_DIR, "renwu.json")
if os.path.isfile(renwu_path):
    renwu = tag_store.normalize_library(tag_store._read_json(renwu_path), name="renwu")
    rc = tag_store.library_counts(renwu)
    check("人物词库规模正确", rc["tags"] >= 1500, str(rc))
    check("人物词库有中文描述", any(s.get("descs") for g in renwu["groups"] for s in g["subs"]), "无描述")
    eq("人物词库只有一个一级分类", rc["groups"], 1)

# 仓库里真实的内置词库（只读检查，测试不会改它）
print("\n[16] 仓库内置词库文件（只读检查）")
_real_files = sorted(glob.glob(os.path.join(REAL_BUILTIN_DIR, "*.json")))
check(
    "内置词库文件齐全",
    {os.path.basename(p) for p in _real_files}
    >= {"chinese_style.json", "danbooru_basic.json", "renwu.json"},
    str([os.path.basename(p) for p in _real_files]),
)
_yijian = sorted(glob.glob(os.path.join(REAL_BUILTIN_DIR, "yijian-*.json")))
if _yijian:
    _total = 0
    _broken = []
    for path in _yijian:
        try:
            _info = tag_store._quick_counts(tag_store._read_json(path))
            _total += _info["counts"]["tags"]
        except Exception as exc:
            _broken.append("%s: %s" % (os.path.basename(path), exc))
    check("一键模式预置库可解析", not _broken, str(_broken))
    check("一键模式预置库总量", _total > 100000, "%d 个 tag / %d 份" % (_total, len(_yijian)))
    _sample_lib = tag_store.normalize_library(
        tag_store._read_json(os.path.join(REAL_BUILTIN_DIR, os.path.basename(_yijian[0]))),
        name="sample",
    )
    _sn = next((s for g in _sample_lib["groups"] for s in g["subs"] if s["tags"]), None)
    check("预置内容是整句提示词", bool(_sn) and "," in _sn["tags"][0], (_sn["tags"][0][:60] if _sn else "空"))

_real_renwu = os.path.join(REAL_BUILTIN_DIR, "renwu.json")
if os.path.isfile(_real_renwu):
    _r = tag_store._quick_counts(tag_store._read_json(_real_renwu))
    eq("仓库里的人物词库没被测试改动", _r["counts"]["tags"], 1612)

# ------------------------------------------------------------ HTTP 接口开关
print("\n[17] HTTP 接口开关（默认开启）")
_settings_dir = tempfile.mkdtemp(prefix="ptm_settings_")
tag_store._USER_DIR_CACHE = _settings_dir
os.environ.pop(tag_store.ENV_HTTP, None)

check("默认是开启的", tag_store.is_http_enabled() is True, str(tag_store.is_http_enabled()))
check("没写设置文件时也开启", not os.path.isfile(tag_store._settings_path()))

eq("手动关闭返回 False", tag_store.set_http_enabled(False), False)
check("关闭后生效", tag_store.is_http_enabled() is False)
check("设置写进了 .settings.json", os.path.isfile(tag_store._settings_path()))
eq("设置内容正确", tag_store.read_settings().get("http_enabled"), False)
check("设置文件不会被当成词库", not any(n.startswith(".") for n in [x["name"] for x in tag_store.list_libraries()]))

eq("手动开启返回 True", tag_store.set_http_enabled(True), True)
check("开启后生效", tag_store.is_http_enabled() is True)
eq("设置内容更新", tag_store.read_settings().get("http_enabled"), True)

# 删掉设置文件后回到默认（开启）
try:
    os.remove(tag_store._settings_path())
except OSError:
    pass
check("删掉设置文件后回到默认开启", tag_store.is_http_enabled() is True)

# 环境变量优先级
os.environ[tag_store.ENV_HTTP] = "1"
eq("环境变量 override", tag_store.env_http_override(), True)
check("环境变量可强制开启", tag_store.is_http_enabled() is True)
os.environ[tag_store.ENV_HTTP] = "0"
check("环境变量可强制关闭", tag_store.is_http_enabled() is False)
os.environ[tag_store.ENV_HTTP] = "off"
check("off 也算关闭", tag_store.is_http_enabled() is False)
os.environ.pop(tag_store.ENV_HTTP, None)
check("去掉环境变量后回到设置/默认", tag_store.is_http_enabled() is True)

print("\n[20] 自定义翻译（本地 .custom_descs.json）")
_desc_dir = tempfile.mkdtemp(prefix="ptm_descs_")
tag_store._USER_DIR_CACHE = _desc_dir
eq("初始没有自定义翻译", tag_store.load_custom_descs(), {})
check(
    "空字典保存后返回空",
    tag_store.save_custom_descs({"": "", "  ": "  "}) == {},
    str(tag_store.load_custom_descs()),
)
check(
    "只有空值的字典不会留下垃圾键",
    not tag_store.load_custom_descs(),
    str(tag_store.load_custom_descs()),
)
_saved = tag_store.save_custom_descs({"a girl in the rain": "雨天里的女孩", "cinematic lighting": "电影感打光"})
eq("保存返回完整映射", len(_saved), 2)
eq("落盘后能读回", tag_store.load_custom_descs().get("cinematic lighting"), "电影感打光")
check("文件写在用户目录", os.path.isfile(os.path.join(_desc_dir, tag_store.CUSTOM_DESC_FILENAME)))
check(
    "自定义翻译文件不会被当成词库",
    not any(n.startswith(".") for n in [x["name"] for x in tag_store.list_libraries()]),
)
eq(
    "再次保存是合并而不是覆盖",
    len(tag_store.save_custom_descs({"long hair": "长发"})),
    3,
)
eq("要改的键会覆盖旧值", tag_store.load_custom_descs().get("long hair"), "长发")
eq("空字符串删除单条", len(tag_store.save_custom_descs({"long hair": ""})), 2)
check("被删除的键读不到", "long hair" not in tag_store.load_custom_descs())
eq("remove 参数可批量删除", len(tag_store.save_custom_descs({}, remove=["cinematic lighting"])), 1)
eq("空译文等于删除", tag_store.save_custom_descs({"a girl in the rain": ""}), {})
eq("全删后文件里也没了", tag_store.load_custom_descs(), {})
# 词库自带的 tag 级译文和这里互不影响
_lib_desc = tag_store.load_library_cached(tag_store.get_default_library_name())
check("自定义翻译不影响词库文件", _lib_desc is not None)

print("\n==================================")
print("通过 %d 项，失败 %d 项" % (PASSES, len(FAILS)))
if FAILS:
    for f in FAILS:
        print("  - " + f)
    sys.exit(1)
