/**
 * 前端纯逻辑自测（node 直接运行，不需要浏览器）
 *   node tests/run_js_tests.mjs
 */

import * as ops from "../web/js/lib_ops.js";

let pass = 0;
const fails = [];

function check(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    console.log("  ok   " + name);
  } else {
    fails.push(`${name} ${extra}`);
    console.log("  FAIL " + name + " " + extra);
  }
}

function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

/* ---------------------------------------------------------------- 规范化 */
console.log("\n[1] normalizeLibrary");
const lib = ops.normalizeLibrary({ 人物: { 发色: ["red_hair", "blue_hair"], 眼: ["blue_eyes"] } }, "测试");
eq("嵌套字典一级", lib.groups.length, 1);
eq("嵌套字典二级", lib.groups[0].subs.length, 2);
eq("词库名", lib.name, "测试");

const lib2 = ops.normalizeLibrary([{ group: "服装", sub: "上装", tag: "shirt" }, ["服装", "上装", "jacket"], "orphan"]);
eq("三元组一级数", lib2.groups.length, 2);
eq("三元组 tag 数", ops.libraryCounts(lib2).tags, 3);

const lib3 = ops.normalizeLibrary({ groups: [{ name: "人物", tags: [{ text: "1girl" }, { text: "1boy" }] }] });
eq("WeiLin 风格进默认二级", lib3.groups[0].subs[0].name, "默认");
eq("WeiLin 风格 tag 数", ops.libraryCounts(lib3).tags, 2);

const lib4 = ops.normalizeLibrary({ tags: ["a", "b", "a"] });
eq("单层 tags 去重", ops.libraryCounts(lib4).tags, 2);

/* ---------------------------------------------------------------- 解析 */
console.log("\n[2] parseText");
const csvText = "一级分类,二级分类,子项\n人物,发色,red hair\n人物,发色,blue hair\n服装,上装,shirt\n";
const pc = ops.parseText(csvText, "a.csv");
eq("CSV 表头跳过", ops.libraryCounts(pc).tags, 3);
eq("CSV 一级数", pc.groups.length, 2);
eq("CSV 二级数", ops.libraryCounts(pc).subs, 2);

const pn = ops.parseText("人物,发色,red hair\n人物,发色,blue hair\n", "b.csv");
eq("CSV 无表头", ops.libraryCounts(pn).tags, 2);

const p2 = ops.parseText("发色,red hair\n发色,blue hair\n");
eq("两列 tag", p2.groups[0].subs[0].tags, ["red hair", "blue hair"]);
eq("两列一级名", p2.groups[0].name, "发色");

const p1 = ops.parseText("masterpiece\nbest quality\nhighres\n");
eq("单列 tag 数", ops.libraryCounts(p1).tags, 3);
eq("单列进未分类", p1.groups[0].name, "未分类");

const pt = ops.parseText("# 人物\n## 发色\nred_hair\nblue_hair\n## 眼睛\ngreen_eyes\n# 场景\nforest\n", "c.txt");
eq("TXT 一级数", pt.groups.length, 2);
eq("TXT 二级数", ops.libraryCounts(pt).subs, 3);
eq("TXT tag 数", ops.libraryCounts(pt).tags, 4);
eq("TXT 分组", pt.groups[0].subs[0].tags, ["red_hair", "blue_hair"]);

const pcj = ops.parseText('{"groups":[{"name":"人物","subs":[{"name":"发色","tags":["a","b"]}]}]}', "d.json");
eq("JSON 解析", ops.libraryCounts(pcj).tags, 2);

let threw = false;
try {
  ops.parseText("{bad json", "e.json");
} catch (err) {
  threw = true;
}
check("非法 JSON 抛错", threw);

eq("TSV 解析", ops.libraryCounts(ops.parseText("人物\t发色\tred_hair\n人物\t发色\tblue_hair\n")).tags, 2);

const ptb = ops.parseText("人物 > 发色 > red_hair\n人物 > 发色 > blue_hair\n");
eq("箭头分隔符", ops.libraryCounts(ptb).tags, 2);
eq("箭头二级名", ptb.groups[0].subs[0].name, "发色");

/* ---------------------------------------------------------------- 导出 */
console.log("\n[3] export round-trip");
const base = ops.normalizeLibrary(
  {
    groups: [
      { name: "人物", subs: [{ name: "发色", tags: ["red_hair", "blue_hair"] }] },
      { name: "场景", subs: [{ name: "自然环境", tags: ["forest", "ocean"] }] },
    ],
  },
  "往返"
);
for (const fmt of ["json", "csv", "txt"]) {
  const out = ops.exportLibrary(base, fmt);
  const back = ops.parseText(out.content, out.filename);
  eq(`导出 ${fmt} 回读一致`, ops.libraryCounts(back), ops.libraryCounts(base));
  eq(`导出 ${fmt} 一级数`, back.groups.length, 2);
}
eq("子集导出", ops.exportSubset(base, "场景").groups.length, 1);
eq("子集二级导出", ops.exportSubset(base, "场景", "自然环境").groups[0].subs.length, 1);

/* ---------------------------------------------------------------- 合并 */
console.log("\n[4] mergeLibrary");
const a = ops.normalizeLibrary({ 人物: { 发色: ["red_hair"] } });
const b = ops.normalizeLibrary({ 人物: { 发色: ["red_hair", "black_hair"], 眼: ["blue_eyes"] } });
eq("合并 tag 数", ops.libraryCounts(ops.mergeLibrary(a, b)).tags, 3);
eq("合并二级数", ops.libraryCounts(ops.mergeLibrary(a, b)).subs, 2);

/* ---------------------------------------------------------------- 预览 */
console.log("\n[5] previewPrompt");
const items = [
  { kind: "tag", text: "masterpiece", weight: 1, enabled: true },
  { kind: "tag", text: "1girl", weight: 1.2, enabled: true },
  { kind: "tag", text: "red_hair", weight: 1, enabled: true },
];
const pv = ops.previewPrompt(items, { separator: ", " });
eq("固定 tag 拼接（默认不输出权重）", pv.text, "masterpiece, 1girl, red hair");
eq("标签列表", pv.tags, ["masterpiece", "1girl", "red hair"]);

eq(
  "不转空格",
  ops.previewPrompt(items, { separator: ", ", underscoreToSpace: false }).text,
  "masterpiece, 1girl, red_hair"
);
eq(
  "括号权重语法",
  ops.previewPrompt(items, { weightStyle: "(tag:1.2)" }).text,
  "masterpiece, (1girl:1.2), red hair"
);
eq(
  "裸权重语法",
  ops.previewPrompt(items, { weightStyle: "tag:1.2" }).text,
  "masterpiece, 1girl:1.2, red hair"
);
eq("不输出权重", ops.previewPrompt(items, { weightStyle: "不输出权重" }).text, "masterpiece, 1girl, red hair");
eq(
  "去重",
  ops.previewPrompt([
    { kind: "tag", text: "a", weight: 1 },
    { kind: "tag", text: "A", weight: 1 },
  ]).tags,
  ["a"]
);
eq(
  "默认不输出权重",
  ops.previewPrompt([{ kind: "tag", text: "color (red)", weight: 1.5 }], { underscoreToSpace: false }).text,
  "color (red)"
);
eq(
  "括号转义（显式权重语法）",
  ops.previewPrompt(
    [{ kind: "tag", text: "color (red)", weight: 1.5 }],
    { underscoreToSpace: false, weightStyle: "(tag:1.2)" }
  ).text,
  "(color \\(red\\):1.5)"
);

const poolItems = [
  { kind: "tag", text: "定值", weight: 1 },
  { kind: "pool", label: "发色", count: 2, weight: 1, tags: ["red", "blue", "black", "silver"] },
  { kind: "tag", text: "尾巴", weight: 1 },
];
const prev = ops.previewPrompt(poolItems, { underscoreToSpace: false });
eq("随机池占位", prev.text, "定值, [🎲发色×2], 尾巴");
eq("随机池计数", prev.poolCount, 1);

const r1 = ops.randomPreview(poolItems, { underscoreToSpace: false }, 42);
const r2 = ops.randomPreview(poolItems, { underscoreToSpace: false }, 42);
const r3 = ops.randomPreview(poolItems, { underscoreToSpace: false }, 43);
eq("同种子可复现", r1.text, r2.text);
check("不同种子不同", r1.text !== r3.text, `${r1.text} vs ${r3.text}`);
eq("随机预览 tag 数", r1.tags.length, 4);
check("随机预览开头结尾", r1.tags[0] === "定值" && r1.tags[3] === "尾巴", JSON.stringify(r1.tags));
check("随机池不重复", new Set(r1.tags.slice(1, 3)).size === 2, JSON.stringify(r1.tags));

const over = ops.randomPreview([{ kind: "pool", count: 5, tags: ["a", "b"] }], { dedupe: false }, 1);
eq("超量抽取补齐", over.tags.length, 5);

/* ------------------------------------------------------------ 名称安全 */
console.log("\n[6] sanitizeName");
eq("路径穿越", ops.sanitizeName("../../etc/passwd"), "etcpasswd");
check("不含斜杠", !ops.sanitizeName("../x/y").includes("/"));
check("不含反斜杠", !ops.sanitizeName("..\\x").includes("\\"));
eq("空名回退", ops.sanitizeName("   ", "回退"), "回退");
check("长度限制", ops.sanitizeName("x".repeat(300)).length <= 64);
eq("保留中文", ops.sanitizeName("我的词库 A"), "我的词库 A");

/* -------------------------------------------------------------- 种子词库 */
console.log("\n[7] seed library");
const { SEED_LIBRARY } = await import("../web/js/seed_library.js");
const seedCounts = ops.libraryCounts(ops.normalizeLibrary(SEED_LIBRARY));
check("离线词库有 tag", seedCounts.tags > 20, JSON.stringify(seedCounts));
check("离线词库结构完好", seedCounts.groups >= 3 && seedCounts.subs >= 5, JSON.stringify(seedCounts));

/* --------------------------------------------------------------- 描述 */
console.log("\n[8] 中文描述(descs)");
const descLib = ops.normalizeLibrary(
  {
    groups: [
      {
        name: "人物",
        subs: [
          {
            name: "发色",
            tags: [{ text: "red_hair", desc: "红发" }, "blue_hair"],
            descs: { blue_hair: "蓝发", 不存在的tag: "应被清理" },
          },
        ],
      },
    ],
  },
  "描述测试"
);
const descSub = descLib.groups[0].subs[0];
eq("tag 仍是字符串", descSub.tags, ["red_hair", "blue_hair"]);
eq("dict 里的 desc 被提取", descSub.descs.red_hair, "红发");
eq("同级 descs 字段被合并", descSub.descs.blue_hair, "蓝发");
check("指向不存在 tag 的描述被清理", !("不存在的tag" in descSub.descs));

const descCsv = ops.exportLibrary(descLib, "csv");
check("CSV 带第 4 列", descCsv.content.includes("红发"), descCsv.content);
const descBack = ops.parseText(descCsv.content, "d.csv");
eq("CSV 回读描述", descBack.groups[0].subs[0].descs.red_hair, "红发");
eq("CSV 回读 tag 数", ops.libraryCounts(descBack).tags, 2);

const descJson = ops.normalizeLibrary(JSON.parse(ops.exportLibrary(descLib, "json").content));
eq("JSON 往返保留描述", descJson.groups[0].subs[0].descs.blue_hair, "蓝发");

const mergedDesc = ops.mergeLibrary(ops.normalizeLibrary({ 人物: { 发色: ["red_hair"] } }), descLib);
eq("合并时描述不丢", mergedDesc.groups[0].subs[0].descs.red_hair, "红发");

const plainCsv = ops.exportLibrary(ops.normalizeLibrary({ a: { b: ["c"] } }), "csv");
check("无描述时 CSV 只有 3 列", plainCsv.content.trim().endsWith("c"), JSON.stringify(plainCsv.content));

/* --------------------------------------------------------------- SQL */
console.log("\n[9] SQL 导入（WeiLin 导出）");
const SQL_SAMPLE = `
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
`;
check("能识别 SQL", ops.looksLikeSql(SQL_SAMPLE));
check("普通 CSV 不会误判为 SQL", !ops.looksLikeSql("人物,发色,red_hair\n"));

const sqlLib = ops.parseText(SQL_SAMPLE, "x.sql");
const sqlCounts = ops.libraryCounts(sqlLib);
eq("SQL 一级分类数", sqlCounts.groups, 2);
eq("SQL 二级分类数", sqlCounts.subs, 2);
eq("SQL tag 总数", sqlCounts.tags, 6);
eq("SQL 一级分类排序", sqlLib.groups.map((g) => g.name), ["人物", "场景"]);
eq("SQL 二级挂对父级", sqlLib.groups[1].subs[0].name, "环境");
eq("SQL tag 按时间倒序", sqlLib.groups[0].subs[0].tags, ["red_hair", "blue_eyes"]);
eq("SQL 描述保留", sqlLib.groups[0].subs[0].descs.red_hair, "红发");
const sceneTags = sqlLib.groups[1].subs[0].tags;
check("SQL 单引号转义", sceneTags.includes("it's_tag"), JSON.stringify(sceneTags));
check("SQL 字符串内分号不截断", sceneTags.includes("semi;colon"), JSON.stringify(sceneTags));
check("空描述不产生 descs", !(sqlLib.groups[1].subs[0].descs && "empty_desc" in sqlLib.groups[1].subs[0].descs));

const MULTI_SQL = `insert into "tag_groups" ("name","p_uuid","create_time") values ('A','ga',1);
insert into "tag_subgroups" ("name","p_uuid","g_uuid","create_time") values ('B','ga','sb',2);
insert into "tag_tags" ("text","g_uuid","desc") values ('x','sb','甲'),('y','sb','乙');`;
const multiLib = ops.parseText(MULTI_SQL, "m.sql");
eq("多行 VALUES 解析", ops.libraryCounts(multiLib).tags, 2);
eq("小写 INSERT 也能识别", multiLib.groups[0].name, "A");

let sqlThrew = false;
try {
  ops.parseText("INSERT INTO other VALUES (1);", "bad.sql");
} catch (err) {
  sqlThrew = true;
}
check("非 WeiLin SQL 报错", sqlThrew);

/* --------------------------------------------------- 手动提示词框 */
console.log("\n[10] 手动提示词框（combinePrompt）");
eq("使用方式 4 种", ops.MANUAL_MODES.length, 4);
check("默认是两者结合", ops.DEFAULT_MANUAL_MODE.startsWith("两者结合"), ops.DEFAULT_MANUAL_MODE);
eq(
  "结合：提示词框在前",
  ops.combinePrompt({
    manual: "masterpiece, best quality",
    tagPrompt: "red hair, blue eyes",
    mode: "两者结合（提示词框在前）",
  }),
  "masterpiece, best quality, red hair, blue eyes"
);
eq(
  "结合：提示词框在后",
  ops.combinePrompt({ manual: "masterpiece", tagPrompt: "red hair", mode: "两者结合（提示词框在后）" }),
  "red hair, masterpiece"
);
eq("仅使用提示词框", ops.combinePrompt({ manual: "只用手写", tagPrompt: "tag_a, tag_b", mode: "仅使用提示词框" }), "只用手写");
eq("仅使用 TAG 词库", ops.combinePrompt({ manual: "忽略我", tagPrompt: "tag_a, tag_b", mode: "仅使用 TAG 词库" }), "tag_a, tag_b");
eq("手写为空", ops.combinePrompt({ manual: "", tagPrompt: "tag_a", mode: "两者结合（提示词框在前）" }), "tag_a");
eq("tag 为空", ops.combinePrompt({ manual: "手写", tagPrompt: "", mode: "两者结合（提示词框在后）" }), "手写");
eq("都为空", ops.combinePrompt({ manual: "", tagPrompt: "" }), "");
eq("非法模式回退默认", ops.combinePrompt({ manual: "A", tagPrompt: "B", mode: "乱写" }), "A, B");
eq(
  "自定义连接符",
  ops.combinePrompt({ manual: "A", tagPrompt: "B", mode: "两者结合（提示词框在前）", separator: " | " }),
  "A | B"
);
eq(
  "连接符支持 \\n",
  ops.combinePrompt({ manual: "A", tagPrompt: "B", mode: "两者结合（提示词框在前）", separator: "\\n" }),
  "A\nB"
);
eq("多行保留", ops.combinePrompt({ manual: "第一行\n第二行", tagPrompt: "", mode: "仅使用提示词框" }), "第一行\n第二行");
eq("多余空行压缩", ops.cleanManualPrompt("a\n\n\n\nb\n"), "a\n\nb");
eq("首尾空白去掉", ops.cleanManualPrompt("  x  \n"), "x");
eq("CRLF 归一化", ops.cleanManualPrompt("a\r\nb"), "a\nb");
check("manualUsesTags", ops.manualUsesTags("仅使用提示词框") === false);
check("manualUsesText", ops.manualUsesText("仅使用 TAG 词库") === false);

// 空格转连接符
eq(
  "默认不转换",
  ops.combinePrompt({ manual: "masterpiece best quality", mode: "仅使用提示词框" }),
  "masterpiece best quality"
);
eq(
  "开启后空格转逗号",
  ops.combinePrompt({ manual: "masterpiece best quality solo", mode: "仅使用提示词框", spaceAsSeparator: true }),
  "masterpiece, best, quality, solo"
);
eq(
  "换行也换",
  ops.combinePrompt({ manual: "a\nb  c", mode: "仅使用提示词框", spaceAsSeparator: true }),
  "a, b, c"
);
eq(
  "自定义连接符",
  ops.combinePrompt({ manual: "a b", mode: "仅使用提示词框", spaceAsSeparator: true, separator: " | " }),
  "a | b"
);
eq(
  "连接符为换行",
  ops.combinePrompt({ manual: "a b", mode: "仅使用提示词框", spaceAsSeparator: true, separator: "\\n" }),
  "a\nb"
);
eq(
  "权重语法保留",
  ops.combinePrompt({ manual: "(1girl:1.2) solo", mode: "仅使用提示词框", spaceAsSeparator: true }),
  "(1girl:1.2), solo"
);
eq(
  "和 tag 结合也转换",
  ops.combinePrompt({ manual: "a b", tagPrompt: "x, y", mode: "两者结合（提示词框在前）", spaceAsSeparator: true }),
  "a, b, x, y"
);
eq("仅 TAG 词库不受影响", ops.combinePrompt({ manual: "a b", tagPrompt: "x", mode: "仅使用 TAG 词库", spaceAsSeparator: true }), "x");
eq("空提示词不产生空项", ops.combinePrompt({ manual: "   ", mode: "仅使用提示词框", spaceAsSeparator: true }), "");
eq("splitManualBySpace 单独可用", ops.splitManualBySpace(" a  b\nc ", ", "), "a, b, c");

// 自然语言框
const NAT = "a girl standing in the rain, cinematic lighting";
eq(
  "自然语言默认不参与",
  ops.combinePrompt({ manual: "a", tagPrompt: "x, y", natural: NAT, naturalAppend: false }),
  "a, x, y"
);
eq(
  "自然语言组合在末尾",
  ops.combinePrompt({ manual: "a", tagPrompt: "x, y", natural: NAT, naturalAppend: true }),
  "a, x, y, " + NAT
);
eq("只有自然语言", ops.combinePrompt({ tagPrompt: "", natural: NAT, naturalAppend: true }), NAT);
eq(
  "仅提示词框模式也追加",
  ops.combinePrompt({ manual: "only", mode: "仅使用提示词框", natural: "nature", naturalAppend: true }),
  "only, nature"
);
eq(
  "自然语言不被空格拆分",
  ops.combinePrompt({
    manual: "a b",
    mode: "仅使用提示词框",
    spaceAsSeparator: true,
    natural: "girl in rain",
    naturalAppend: true,
  }),
  "a, b, girl in rain"
);
eq(
  "自定义连接符",
  ops.combinePrompt({ manual: "a", tagPrompt: "b", separator: " | ", natural: "nat", naturalAppend: true }),
  "a | b | nat"
);
eq("自然语言空行压缩", ops.combinePrompt({ natural: "x\n\n\n\ny", naturalAppend: true }), "x\n\ny");

// 粘贴带逗号不能产生 ", ,"
eq("末尾逗号被清理", ops.combinePrompt({ manual: "a, b, ", tagPrompt: "1girl" }), "a, b, 1girl");
eq("中间双逗号收敛", ops.combinePrompt({ manual: "a,, b", tagPrompt: "1girl" }), "a, b, 1girl");
eq("逗号加空格收敛", ops.combinePrompt({ manual: "a, , b", tagPrompt: "1girl" }), "a, b, 1girl");
eq(
  "自然语言末尾逗号也清理",
  ops.combinePrompt({ manual: "a", tagPrompt: "b", natural: "nat, ", naturalAppend: true }),
  "a, b, nat"
);
eq("cleanManualPrompt 去掉结尾逗号", ops.cleanManualPrompt("a, b, "), "a, b");
eq("collapseSeparators 单独可用", ops.collapseSeparators("a,, b, , c"), "a, b, c");

console.log("\n==================================");
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
