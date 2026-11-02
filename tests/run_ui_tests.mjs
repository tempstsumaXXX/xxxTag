/**
 * 界面端到端测试：用 jsdom 跑真实的 TagEditor，并访问真实的 Python 接口。
 *
 *   1) 先启动后端替身： python tests/e2e_server.py
 *   2) 再运行：           node tests/run_ui_tests.mjs
 *
 * jsdom 不是插件依赖。如果没装在全局，可以用环境变量指定路径：
 *   PTM_JSDOM="file:///D:/path/to/node_modules/jsdom/lib/api.js" node tests/run_ui_tests.mjs
 */

let jsdomMod = null;
for (const spec of [process.env.PTM_JSDOM, "jsdom", "jsdom/lib/api.js"].filter(Boolean)) {
  try {
    jsdomMod = await import(spec);
    break;
  } catch (err) {
    /* 试下一个 */
  }
}
if (!jsdomMod) {
  console.error(
    "找不到 jsdom。请先 `npm install jsdom`，或设置 PTM_JSDOM 指向 jsdom/lib/api.js。"
  );
  process.exit(2);
}
const JSDOM = jsdomMod.JSDOM || (jsdomMod.default && jsdomMod.default.JSDOM);

const BASE = process.env.PTM_BASE || "http://127.0.0.1:8399";
/* ------------------------------------------------------------ 环境准备 */

const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="host"></div></body></html>`, {
  url: BASE + "/",
  pretendToBeVisual: true,
});

const { window } = dom;
const copied = [];

globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Event = window.Event;
globalThis.MouseEvent = window.MouseEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.DragEvent = window.DragEvent || window.Event;
globalThis.localStorage = window.localStorage;

// jsdom 不会去加载外部样式表，这里把真实 CSS 注入进文档，
// 这样 getComputedStyle 才能验证排版（例如 tag 列表是不是纵向的）
try {
  const fs = await import("node:fs");
  const pathMod = await import("node:path");
  const urlMod = await import("node:url");
  const here = pathMod.dirname(urlMod.fileURLToPath(import.meta.url));
  const cssPath = pathMod.join(pathMod.dirname(here), "web", "css", "prompt_tag.css");
  const styleEl = window.document.createElement("style");
  styleEl.textContent = fs.readFileSync(cssPath, "utf-8");
  window.document.head.appendChild(styleEl);
} catch (err) {
  console.warn("注入样式表失败（排版断言会跳过）:", err.message);
}
// 模拟「全新浏览器」：清掉上次运行留下的记忆词库/开关
try {
  window.localStorage.clear();
} catch (err) {
  /* ignore */
}
globalThis.Blob = window.Blob;
globalThis.FileReader = window.FileReader;
globalThis.File = window.File;

// URL：保留 createObjectURL 桩
const NodeURL = globalThis.URL;
globalThis.URL = window.URL || NodeURL;
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = () => "blob:ptm-test";
  globalThis.URL.revokeObjectURL = () => {};
}

// navigator.clipboard
try {
  const nav = window.navigator;
  Object.defineProperty(nav, "clipboard", {
    value: {
      writeText: async (text) => {
        copied.push(text);
      },
    },
    configurable: true,
  });
  globalThis.navigator = nav;
} catch (err) {
  try {
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: async (t) => copied.push(t) } },
      configurable: true,
      writable: true,
    });
  } catch (e2) {
    console.warn("navigator 桩设置失败，剪贴板相关用例会被跳过", e2.message);
  }
}

// fetch：相对路径 → 真实后端
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? new URL(input, BASE + "/").href : input;
  return nativeFetch(url, init);
};

/* ------------------------------------------------------------ 测试框架 */

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function click(el, label) {
  if (!el) throw new Error("找不到可点击元素：" + label);
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

function setValue(el, value, eventName = "input") {
  el.value = value;
  el.dispatchEvent(new window.Event(eventName, { bubbles: true }));
}

function byText(nodes, text) {
  return Array.from(nodes).find((n) => (n.textContent || "").trim().includes(text)) || null;
}

/* ------------------------------------------------------------ 开始测试 */

const { TagEditor } = await import("../web/js/tag_editor.js");

console.log("\n[1] 挂载与词库加载");
await fetch("/prompt_tag/health"); // 确认后端活着

const container = document.getElementById("host");
const configs = [];
const editor = new TagEditor({
  onConfigChange: (cfg) => configs.push(JSON.parse(JSON.stringify(cfg))),
  getOptions: () => ({ separator: ", ", dedupe: true, underscoreToSpace: true, weightStyle: "(tag:1.2)" }),
  getSeed: () => 12345,
});

await editor.mount(container);
await sleep(60);

check("后端模式", editor.state.mode === "server", editor.state.mode);
check("状态 ready", editor.state.status === "ready", editor.state.error);
check("词库列表已载入", editor.libraries.length >= 2, String(editor.libraries.length));

const serverState = await (await fetch("/prompt_tag/state")).json();
check("默认词库 = 服务端默认", editor.state.libraryName === serverState.default, editor.state.libraryName);
check("默认词库是人物词库", editor.state.libraryName === "renwu", editor.state.libraryName);
check("根节点已渲染", Boolean(container.querySelector(".ptm-root")));
check("当前词库有分类", editor.state.library.groups.length >= 1, String(editor.state.library.groups.length));

const cols = container.querySelectorAll(".ptm-col");
eq("三栏结构", cols.length, 3);
const colG = cols[0];
const colS = cols[1];
const colT = cols[2];
check(
  "一级分类行已渲染",
  colG.querySelectorAll(".ptm-row").length >= editor.state.library.groups.length + 1,
  String(colG.querySelectorAll(".ptm-row").length)
);

console.log("\n[2] 三级分类浏览");
const firstGroupRow = Array.from(colG.querySelectorAll(".ptm-row")).find(
  (r) => r.querySelector(".ptm-row-label").textContent.trim() !== "全部"
);
click(firstGroupRow, "第一个一级分类");
await sleep(20);
check("选中一级分类", Boolean(editor.state.ui.group), String(editor.state.ui.group));
check("二级分类行已渲染", colS.querySelectorAll(".ptm-row").length >= 2, String(colS.querySelectorAll(".ptm-row").length));

const firstSubRow = Array.from(colS.querySelectorAll(".ptm-row")).find(
  (r) => r.querySelector(".ptm-row-label").textContent.trim() !== "全部"
);
click(firstSubRow, "第一个二级分类");
await sleep(20);
const tagChipsInSub = colT.querySelectorAll(".ptm-tag");
check("子项已渲染", tagChipsInSub.length > 3, String(tagChipsInSub.length));

console.log("\n[3] 勾选 tag 同步节点配置");
const beforeCount = configs.length;
click(tagChipsInSub[0], "第一个 tag");
await sleep(20);
check("产生了配置回调", configs.length > beforeCount);
let cfg = configs[configs.length - 1];
eq("已选 1 个", cfg.items.length, 1);
check("配置带词库名", cfg.library === editor.state.libraryName, cfg.library);
check("选中态高亮", colT.querySelectorAll(".ptm-tag.on").length === 1);
eq("已选区渲染", container.querySelectorAll(".ptm-chip").length, 1);

const firstTagText = cfg.items[0].text;
click(tagChipsInSub[0], "第一个 tag（再次点击取消）");
await sleep(20);
eq("再次点击取消勾选", configs[configs.length - 1].items.length, 0);

click(tagChipsInSub[0], "第一个 tag（重新选中）");
await sleep(20);

console.log("\n[4] 随机池");
const selectedSubRow = Array.from(colS.querySelectorAll(".ptm-row")).find((r) =>
  r.classList.contains("active")
);
const poolBtn = byText(selectedSubRow.querySelectorAll(".ptm-row-actions .ptm-mini"), "🎲");
click(poolBtn, "🎲 随机池按钮");
await sleep(20);
cfg = configs[configs.length - 1];
const poolItem = cfg.items.find((i) => i.kind === "pool");
check("已添加随机池", Boolean(poolItem), JSON.stringify(cfg.items));
check(
  "随机池记录库/分类引用（不内嵌候选）",
  Boolean(poolItem && poolItem.library && poolItem.group && poolItem.sub),
  JSON.stringify(poolItem)
);
check("随机池记录候选数量", (poolItem?.size || 0) > 3, String(poolItem?.size));
check("随机池不内嵌候选列表", !poolItem?.tags || poolItem.tags.length === 0, "内嵌了 " + (poolItem?.tags || []).length);
eq("随机池默认抽 1 个", poolItem?.count, 1);

click(poolBtn, "🎲 再点一次（数量 +1）");
await sleep(20);
eq("再次点击数量 +1", configs[configs.length - 1].items.find((i) => i.kind === "pool").count, 2);

const poolChip = container.querySelector(".ptm-chip.pool");
check("已选区出现随机池 chip", Boolean(poolChip));
const minusBtn = poolChip && byText(poolChip.querySelectorAll(".ptm-chip-btn"), "−");
click(minusBtn, "随机池 −");
await sleep(20);
eq("点 − 数量回落", configs[configs.length - 1].items.find((i) => i.kind === "pool").count, 1);

console.log("\n[5] 权重编辑");
const weightEl = container.querySelector(".ptm-chip .ptm-chip-weight");
click(weightEl, "权重");
await sleep(10);
const weightInput = container.querySelector(".ptm-chip-weight.editing input");
check("权重进入编辑态", Boolean(weightInput));
if (weightInput) {
  setValue(weightInput, "1.45");
  weightInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await sleep(30);
  const w = configs[configs.length - 1].items.find((i) => i.kind === "tag").weight;
  eq("权重已更新", w, 1.45);
}

console.log("\n[6] 搜索");
const searchInput = container.querySelector(".ptm-search-wrap input");
setValue(searchInput, "hair");
await sleep(400); // 搜索有 220ms 防抖（超大词库保护）
const hits = colT.querySelectorAll(".ptm-tag");
check("搜索有结果", hits.length > 3, String(hits.length));
check("搜索结果显示归属", Boolean(colT.querySelector(".ptm-tag-where")));
const badgeTexts = Array.from(container.querySelectorAll(".ptm-badge")).map((n) => n.textContent || "");
check("命中数徽标", badgeTexts.some((t) => t.includes("命中")), badgeTexts.join(" | "));
setValue(searchInput, "");
await sleep(400);

console.log("\n[7] 批量导入（走弹窗 + 真实接口）");
// 以「服务端当前状态」为基准，并给本次导入用唯一命名，
// 这样即使在同一份数据上重复跑测试也成立（同名分类本来就该合并）
const tagsBefore = (await (await fetch("/prompt_tag/library?name=" + editor.state.libraryName)).json()).data;
const countBefore = tagsBefore.groups.reduce((n, g) => n + g.subs.length, 0);
const uniq = "r" + Date.now().toString(36).slice(-6);
const gName = "测试分类" + uniq;
const sName = "测试二级" + uniq;
const tNameA = "e2e_tag_" + uniq + "_a";
const tNameB = "e2e_tag_" + uniq + "_b";

const importBtn = byText(container.querySelectorAll(".ptm-toolbar .ptm-btn"), "导入");
click(importBtn, "📥 导入");
await sleep(40);
const dialog = document.querySelector(".ptm-modal-backdrop .ptm-dialog");
check("导入弹窗已打开", Boolean(dialog));
const importArea = dialog.querySelector("textarea");
setValue(importArea, `${gName},${sName},${tNameA}\n${gName},${sName},${tNameB}\n`);
await sleep(30);
check("导入预览统计出现", (dialog.textContent || "").includes("2 个 tag"), dialog.textContent.slice(0, 200));
const startBtn = byText(dialog.querySelectorAll(".ptm-dialog-foot .ptm-btn"), "开始导入");
click(startBtn, "开始导入");
await sleep(400);
check("弹窗已关闭", !document.querySelector(".ptm-modal-backdrop"));
const newLib = editor.state.library;
const foundGroup = newLib.groups.find((g) => g.name === gName);
check("新分类已合并进词库", Boolean(foundGroup), newLib.groups.map((g) => g.name).join(","));
check(
  "新 tag 已写入",
  Boolean(foundGroup && foundGroup.subs.some((s) => s.tags.includes(tNameA))),
  JSON.stringify(foundGroup)
);
const subCountAfter = newLib.groups.reduce((n, g) => n + g.subs.length, 0);
eq("二级分类数 +1", subCountAfter, countBefore + 1);

const persisted = await (await fetch("/prompt_tag/library?name=" + editor.state.libraryName)).json();
check(
  "导入结果已落盘",
  JSON.stringify(persisted.data).includes(tNameA),
  "服务端没有找到新 tag"
);

console.log("\n[8] 批量导出");
const exportBtn = byText(container.querySelectorAll(".ptm-toolbar .ptm-btn"), "导出");
click(exportBtn, "📤 导出");
await sleep(400);
const exportDlg = document.querySelector(".ptm-modal-backdrop .ptm-dialog");
check("导出弹窗已打开", Boolean(exportDlg));
const exportPreview = exportDlg.querySelector("textarea");
check("导出内容已生成", (exportPreview.value || "").length > 100, String((exportPreview.value || "").length));
check("导出内容含 JSON 结构", (exportPreview.value || "").trim().startsWith("{"));
const copyBtn = byText(exportDlg.querySelectorAll(".ptm-dialog-foot .ptm-btn"), "复制到剪贴板");
click(copyBtn, "复制到剪贴板");
await sleep(120);
check("剪贴板收到内容", copied.length > 0 && copied[copied.length - 1].length > 100, String(copied.length));
const closeBtn = exportDlg.querySelector(".ptm-dialog-head .ptm-btn");
click(closeBtn, "关闭导出弹窗");
await sleep(60);

console.log("\n[9] 词库 CRUD（新建 / 重命名 / 删除）");
const newLibBtn = byText(container.querySelectorAll(".ptm-toolbar .ptm-btn"), "新建");
click(newLibBtn, "＋ 新建");
await sleep(40);
let nameInput = document.querySelector(".ptm-modal-backdrop .ptm-dialog input.ptm-input");
check("新建弹窗已打开", Boolean(nameInput));
setValue(nameInput, "UI测试词库", "input");
const okBtn = byText(document.querySelectorAll(".ptm-modal-backdrop .ptm-dialog-foot .ptm-btn"), "确定");
click(okBtn, "确定新建");
await sleep(400);
eq("切到新词库", editor.state.libraryName, "UI测试词库");
eq("新词库是空的", editor.state.library.groups.length, 0);
const stateAfterCreate = await (await fetch("/prompt_tag/state")).json();
check("服务端出现新词库", stateAfterCreate.libraries.some((l) => l.name === "UI测试词库"));

// 回到内置词库
const libSelect = container.querySelector(".ptm-select");
setValue(libSelect, "danbooru_basic", "change");
await sleep(400);
eq("切换词库生效", editor.state.libraryName, "danbooru_basic");

console.log("\n[9.5] 分类增删改（在独立测试词库上）");

async function answerDialog(text, okLabel = "确定") {
  await sleep(50);
  const dlg = document.querySelector(".ptm-modal-backdrop .ptm-dialog");
  if (!dlg) throw new Error("没有弹出对话框（期望：" + okLabel + "）");
  if (text !== null) {
    const input = dlg.querySelector("input.ptm-input");
    if (!input) throw new Error("对话框里没有输入框");
    setValue(input, text, "input");
  }
  const btn = byText(dlg.querySelectorAll(".ptm-dialog-foot .ptm-btn"), okLabel);
  click(btn, okLabel);
  await sleep(300);
  return true;
}

const headBtn = (colIdx, glyph) => {
  const head = container.querySelectorAll(".ptm-col")[colIdx].querySelector(".ptm-col-head");
  return byText(head.querySelectorAll(".ptm-mini"), glyph);
};

click(byText(container.querySelectorAll(".ptm-toolbar .ptm-btn"), "新建"), "新建词库");
await answerDialog("CRUD测试库");
eq("已切到 CRUD 测试词库", editor.state.libraryName, "CRUD测试库");

click(headBtn(0, "＋"), "新建一级分类");
await answerDialog("分类A");
check("一级分类已创建", editor.state.library.groups.some((g) => g.name === "分类A"));
eq("新建后自动选中", editor.state.ui.group, "分类A");

const groupRowA = Array.from(colG.querySelectorAll(".ptm-row")).find(
  (r) => r.querySelector(".ptm-row-label").textContent.trim() === "分类A"
);
click(byText(groupRowA.querySelectorAll(".ptm-row-actions .ptm-mini"), "✎"), "重命名一级分类");
await answerDialog("分类B");
check("一级分类已改名", editor.state.library.groups.some((g) => g.name === "分类B"));
check("旧名字已不存在", !editor.state.library.groups.some((g) => g.name === "分类A"));
eq("改名后仍保持选中（回归）", editor.state.ui.group, "分类B");
check(
  "中栏标题跟随改名",
  (container.querySelectorAll(".ptm-col")[1].querySelector(".ptm-col-head").textContent || "").includes("分类B"),
  container.querySelectorAll(".ptm-col")[1].querySelector(".ptm-col-head").textContent
);

click(headBtn(1, "＋"), "新建二级分类");
await answerDialog("二级X");
const groupB = editor.state.library.groups.find((g) => g.name === "分类B");
check("二级分类已创建", Boolean(groupB && groupB.subs.some((s) => s.name === "二级X")));
eq("新建二级后自动选中", editor.state.ui.sub, "二级X");

const subRowX = Array.from(colS.querySelectorAll(".ptm-row")).find(
  (r) => r.querySelector(".ptm-row-label").textContent.trim() === "二级X"
);
click(byText(subRowX.querySelectorAll(".ptm-row-actions .ptm-mini"), "✎"), "重命名二级分类");
await answerDialog("二级Y");
check("二级分类已改名", Boolean(groupB.subs.some((s) => s.name === "二级Y")));
eq("改名后仍保持选中（回归）", editor.state.ui.sub, "二级Y");

// 加 tag 再批量编辑
click(byText(container.querySelectorAll(".ptm-col-3 .ptm-btn"), "批量添加"), "批量添加 tag");
await answerDialog("crud_tag_1, crud_tag_2, crud_tag_3");
const subY = groupB.subs.find((s) => s.name === "二级Y");
eq("批量添加 3 个 tag", subY.tags.length, 3);

const subRowY = Array.from(colS.querySelectorAll(".ptm-row")).find(
  (r) => r.querySelector(".ptm-row-label").textContent.trim() === "二级Y"
);
click(byText(subRowY.querySelectorAll(".ptm-row-actions .ptm-mini"), "≡"), "批量编辑");
await sleep(60);
const batchDlg = document.querySelector(".ptm-modal-backdrop .ptm-dialog");
check("批量编辑弹窗已打开", Boolean(batchDlg));
setValue(batchDlg.querySelector("textarea"), "crud_tag_1\ncrud_tag_keep\n");
await sleep(30);
click(byText(batchDlg.querySelectorAll(".ptm-dialog-foot .ptm-btn"), "保存"), "保存批量编辑");
await sleep(300);
eq("批量编辑后只剩 2 个 tag", subY.tags.length, 2);
check("保留修改后的 tag", subY.tags.includes("crud_tag_keep"), JSON.stringify(subY.tags));
check("删除被移除的 tag", !subY.tags.includes("crud_tag_2"), JSON.stringify(subY.tags));

// 删除二级分类
const subRowY2 = Array.from(colS.querySelectorAll(".ptm-row")).find(
  (r) => r.querySelector(".ptm-row-label").textContent.trim() === "二级Y"
);
click(byText(subRowY2.querySelectorAll(".ptm-row-actions .ptm-mini"), "🗑"), "删除二级分类");
await answerDialog(null, "删除");
check("二级分类已删除", !groupB.subs.some((s) => s.name === "二级Y"));
eq("删除后取消选中", editor.state.ui.sub, null);

// 删除整个测试词库
click(byText(container.querySelectorAll(".ptm-toolbar .ptm-btn"), "删除"), "删除词库");
await answerDialog(null, "删除");
await sleep(400);
check("测试词库已删除", editor.state.libraryName !== "CRUD测试库", editor.state.libraryName);
const stateAfterDelete = await (await fetch("/prompt_tag/state")).json();
check(
  "服务端也删掉了测试词库",
  !stateAfterDelete.libraries.some((l) => l.name === "CRUD测试库"),
  stateAfterDelete.libraries.map((l) => l.name).join(",")
);

console.log("\n[10] 中文词库 + 配置往返");
setValue(container.querySelector(".ptm-select"), "chinese_style", "change");
await sleep(400);
eq("切到国风词库", editor.state.libraryName, "chinese_style");
check("国风词库有内容", editor.state.library.groups.length === 8, String(editor.state.library.groups.length));
const groups = editor.state.library.groups;
check("一级分类含中文名", groups.some((g) => /[\u4e00-\u9fff]/.test(g.name)), groups.map((g) => g.name).join(","));

const roundTripCfg = {
  v: 1,
  library: "chinese_style",
  items: [
    { kind: "tag", text: "hanfu", weight: 1.2, enabled: true },
    { kind: "pool", label: "国风画风/笔触", count: 2, weight: 1, enabled: true, tags: ["a", "b", "c"] },
    { kind: "tag", text: "停用的tag", weight: 1, enabled: false },
  ],
};
editor.setConfig(roundTripCfg);
await sleep(60);
const backCfg = editor.getConfig();
eq("配置往返 items 数", backCfg.items.length, 3);
eq("权重保留", backCfg.items[0].weight, 1.2);
eq("随机池保留", backCfg.items[1].count, 2);
eq("停用状态保留", backCfg.items[2].enabled, false);
const preview = container.querySelector(".ptm-preview-body").textContent;
check("预览显示固定 tag", preview.includes("(hanfu:1.2)"), preview);
check("预览显示随机池占位", preview.includes("🎲"), preview);

console.log("\n[11] 只导出已选 tag");
const selectedLib = editor.buildSelectedLibrary();
// hanfu(1) + 随机池的 3 个候选；停用的 tag 不计入
eq(
  "已选词库只含启用项与随机池候选",
  selectedLib.groups.reduce((n, g) => n + g.subs.reduce((m, s) => m + s.tags.length, 0), 0),
  4
);
check(
  "停用的 tag 不在导出里",
  !JSON.stringify(selectedLib).includes("停用的tag"),
  JSON.stringify(selectedLib)
);

console.log("\n[12] 卸载");
editor.unmount();
await sleep(50);
check("根节点已移除", !container.querySelector(".ptm-root"));

console.log("\n[13] 浮窗");
const { openTagWindow, getTagWindow, closeTagWindow } = await import("../web/js/tag_window.js");
const windowConfigs = [];
const handle = openTagWindow({
  nodeId: "42",
  title: "测试节点 #42",
  config: {
    v: 1,
    library: "danbooru_basic",
    items: [{ kind: "tag", text: "solo", weight: 1, enabled: true }],
  },
  host: { onConfigChange: (c) => windowConfigs.push(c) },
});
await sleep(400);
check("浮窗已创建", Boolean(document.querySelector(".ptm-window")));
check("浮窗标题", (document.querySelector(".ptm-window-title")?.textContent || "").includes("#42"));
check("浮窗里编辑器已挂载", Boolean(document.querySelector(".ptm-window .ptm-root")));
eq("浮窗载入了正确词库", handle.editor.state.libraryName, "danbooru_basic");
check(
  "浮窗恢复了节点已选 tag",
  handle.editor.state.items.some((i) => i.text === "solo"),
  JSON.stringify(handle.editor.state.items)
);

const again = openTagWindow({ nodeId: "42" });
check("同节点复用同一个窗口", again === handle);
check("getTagWindow 可查到", getTagWindow("42") === handle);

closeTagWindow("42");
await sleep(120);
check("浮窗已关闭", !document.querySelector(".ptm-window"));
check("getTagWindow 查不到了", getTagWindow("42") === null);

console.log("\n[14] 离线模式（接口不可用时降级）");
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("模拟网络不可用");
};
try {
  const { probe, getState, loadLibrary, saveLibrary } = await import("../web/js/tag_api.js");
  await probe(true);
  const st = await getState();
  eq("降级为本地模式", st.mode, "offline");
  check("本地有种子词库", st.libraries.length >= 1, JSON.stringify(st.libraries));
  const local = await loadLibrary(st.libraries[0].name);
  check("本地词库可读", local.data.groups.length > 0, JSON.stringify(local.data.groups.length));
  const before = local.data.groups.length;
  local.data.groups.push({ name: "离线新增", subs: [{ name: "测试", tags: ["offline_tag"] }] });
  await saveLibrary(local.name, local.data);
  const reread = await loadLibrary(local.name);
  check(
    "本地保存生效",
    reread.data.groups.some((g) => g.name === "离线新增"),
    JSON.stringify(reread.data.groups.map((g) => g.name))
  );
  eq("本地词库分类数 +1", reread.data.groups.length, before + 1);
} finally {
  globalThis.fetch = realFetch;
}

console.log("\n[15] 中文描述 + 中文搜索 + .sql 导入");
const { probe: reprobe } = await import("../web/js/tag_api.js");
await reprobe(true); // 从 [14] 的离线模式切回真实后端

const host2 = document.createElement("div");
document.body.appendChild(host2);
const editor2 = new TagEditor({
  onConfigChange: () => {},
  getOptions: () => ({ separator: ", ", dedupe: true, underscoreToSpace: true, weightStyle: "(tag:1.2)" }),
  getSeed: () => 1,
});
await editor2.mount(host2);
await sleep(120);
await editor2.switchLibrary("renwu", { silent: true });
await sleep(200);

const renwu = editor2.state.library;
// 注意：前面的用例把测试 tag 合并进了同一个词库（影子覆盖），所以这里只校验「是人物词库」而不是「只有 1 个分类」
eq("载入的是人物词库", editor2.state.libraryName, "renwu");
check(
  "人物词库里有「人物」分类",
  (renwu.groups || []).some((g) => g.name === "人物"),
  (renwu.groups || []).map((g) => g.name).join(",")
);
const totalTags = renwu.groups.reduce((n, g) => n + g.subs.reduce((m, s) => m + s.tags.length, 0), 0);
check("人物词库 tag 数量", totalTags > 1500, String(totalTags));

editor2.state.ui.group = "人物";
editor2.renderColumns();
await sleep(20);
const renwuGroup = renwu.groups.find((g) => g.name === "人物");
const subWithDesc = renwuGroup.subs.find((s) => s.descs && Object.keys(s.descs).length);
check("存在带中文描述的二级分类", Boolean(subWithDesc), JSON.stringify(renwuGroup.subs.map((s) => s.name)));

editor2.state.ui.sub = subWithDesc.name;
editor2.renderColumns();
await sleep(20);
const descTag = subWithDesc.tags.find((t) => subWithDesc.descs[t]);
const chipEl = Array.from(host2.querySelectorAll(".ptm-col-3 .ptm-tag")).find(
  (c) => (c.querySelector(".ptm-tag-text") || {}).textContent === descTag
);
check("找到目标 tag 的胶囊", Boolean(chipEl), descTag);
if (chipEl) {
  const firstLine = String(chipEl.title || "").split("\n")[0];
  eq("胶囊提示第一行是中文描述", firstLine, subWithDesc.descs[descTag]);
  const inlineDesc = chipEl.querySelector(".ptm-tag-desc");
  check("tag 上直接显示中文", Boolean(inlineDesc), "没有 .ptm-tag-desc");
  if (inlineDesc) eq("行内中文内容正确", inlineDesc.textContent, subWithDesc.descs[descTag]);
}

// 中文显示开关
const descToggle = Array.from(host2.querySelectorAll(".ptm-toolbar .ptm-btn")).find((b) =>
  (b.textContent || "").includes("中 已开")
);
check("存在中文显示开关（默认开）", Boolean(descToggle), "没找到开关");
if (descToggle) {
  click(descToggle, "中文开关");
  await sleep(40);
  check("关掉后 tag 上不再显示中文", !host2.querySelector(".ptm-tag-desc"), "还有 .ptm-tag-desc");
  click(descToggle, "中文开关");
  await sleep(40);
  check("再打开又显示中文", Boolean(host2.querySelector(".ptm-tag-desc")), "没有 .ptm-tag-desc");
}

// 用中文描述搜索
const search2 = host2.querySelector(".ptm-search-wrap input");
const someDescWord = String(subWithDesc.descs[descTag]).slice(0, 1);
setValue(search2, someDescWord);
await sleep(400);
const hitChips = host2.querySelectorAll(".ptm-col-3 .ptm-tag");
check("按中文描述能搜到 tag", hitChips.length > 0, `搜索词=${someDescWord} 命中=${hitChips.length}`);
check(
  "搜索结果里包含目标 tag",
  Array.from(hitChips).some((c) => (c.querySelector(".ptm-tag-text") || {}).textContent === descTag),
  descTag
);
setValue(search2, "");
await sleep(30);

// .sql 直接导入
click(byText(host2.querySelectorAll(".ptm-toolbar .ptm-btn"), "导入"), "📥 导入");
await sleep(60);
const sqlDialog = document.querySelector(".ptm-modal-backdrop .ptm-dialog");
check("导入弹窗已打开", Boolean(sqlDialog));
const SQL_SAMPLE =
  'INSERT OR REPLACE INTO "tag_groups" ("name", "color", "create_time", "p_uuid") VALUES (\'SQL分类\', \'rgba(1)\', 100, \'g1\');\n' +
  'INSERT OR REPLACE INTO "tag_subgroups" ("name", "color", "create_time", "p_uuid", "g_uuid") VALUES (\'SQL二级\', \'rgba(1)\', 150, \'g1\', \'s1\');\n' +
  'INSERT OR REPLACE INTO "tag_tags" ("text", "desc", "color", "create_time", "g_uuid", "t_uuid") VALUES (\'sql_tag_a\', \'甲\', \'rgba(1)\', 300, \'s1\', \'t1\');\n' +
  'INSERT OR REPLACE INTO "tag_tags" ("text", "desc", "color", "create_time", "g_uuid", "t_uuid") VALUES (\'sql_tag_b\', \'乙\', \'rgba(1)\', 200, \'s1\', \'t2\');\n';
setValue(sqlDialog.querySelector("textarea"), SQL_SAMPLE);
await sleep(50);
check("SQL 预览统计正确", (sqlDialog.textContent || "").includes("2 个 tag"), sqlDialog.textContent.slice(0, 200));
const modeSel = sqlDialog.querySelector("select.ptm-select");
setValue(modeSel, "new", "change");
await sleep(30);
const sqlNameInput = sqlDialog.querySelector("input.ptm-input");
setValue(sqlNameInput, "SQL导入测试", "input");
click(byText(sqlDialog.querySelectorAll(".ptm-dialog-foot .ptm-btn"), "开始导入"), "开始导入");
await sleep(500);
eq("切到 SQL 导入的新词库", editor2.state.libraryName, "SQL导入测试");
eq("SQL 词库分类数", editor2.state.library.groups.length, 1);
eq(
  "SQL 词库 tag 数",
  editor2.state.library.groups[0].subs[0].tags.length,
  2
);
eq("SQL 描述进入词库", editor2.state.library.groups[0].subs[0].descs.sql_tag_a, "甲");

editor2.unmount();
host2.remove();

console.log("\n[16] 巨型预置词库（一键模式 20 万条提示词）");

const presetList = (await (await fetch("/prompt_tag/state")).json()).libraries.filter((l) =>
  l.name.startsWith("yijian")
);
check("服务端有预置词库", presetList.length > 0, String(presetList.length));
if (presetList.length) {
  const bigName = presetList[0].name;
  const host3 = document.createElement("div");
  document.body.appendChild(host3);
  const editor3 = new TagEditor({
    onConfigChange: () => {},
    getOptions: () => ({ separator: ", ", dedupe: true, underscoreToSpace: true, weightStyle: "(tag:1.2)" }),
    getSeed: () => 1,
  });
  await editor3.mount(host3);
  await sleep(100);

  const t0 = Date.now();
  await editor3.switchLibrary(bigName, { silent: true });
  const loadMs = Date.now() - t0;
  await sleep(200);
  eq("打开了巨型词库", editor3.state.libraryName, bigName);
  const bigTotal = editor3.state.library.groups.reduce(
    (n, g) => n + g.subs.reduce((m, s) => m + s.tags.length, 0),
    0
  );
  check("巨型词库 tag 数量很大", bigTotal > 5000, String(bigTotal));
  check("加载巨型词库耗时可接受", loadMs < 20000, loadMs + " ms");

  // 未选分类时展示全部 → 必须有渲染保护
  const chipsBefore = host3.querySelectorAll(".ptm-col-3 .ptm-tag").length;
  check("超大列表一次只渲染 400 个", chipsBefore === 400, String(chipsBefore));
  const moreBtn = Array.from(host3.querySelectorAll(".ptm-col-3 .ptm-btn")).find((b) =>
    (b.textContent || "").includes("还有")
  );
  check("有『显示更多』按钮", Boolean(moreBtn), "没找到");
  if (moreBtn) {
    click(moreBtn, "显示更多");
    await sleep(150);
    eq("点一次多渲染 400 个", host3.querySelectorAll(".ptm-col-3 .ptm-tag").length, 800);
  }

  // 选一个二级分类，确认能正常列出
  const group = editor3.state.library.groups[0];
  const sub = group.subs.find((s) => s.tags.length > 0);
  check("存在有内容的二级分类", Boolean(sub), JSON.stringify(group.subs.map((s) => s.name)));
  editor3.state.ui.group = group.name;
  editor3.state.ui.sub = sub.name;
  editor3.renderColumns();
  await sleep(150);
  const subChips = host3.querySelectorAll(".ptm-col-3 .ptm-tag").length;
  check("二级分类下能列出提示词", subChips > 50, String(subChips));
  eq("切分类后分页重置", Math.min(subChips, 400), Math.min(sub.tags.length, 400));

  // 点一条预设 → 应该是整句提示词进配置和预览
  const firstChip = host3.querySelectorAll(".ptm-col-3 .ptm-tag")[0];
  click(firstChip, "第一条预设");
  await sleep(120);
  const cfg3 = editor3.getConfig();
  eq("已选区有 1 条", cfg3.items.length, 1);
  check("预设是整句提示词（含逗号）", cfg3.items[0].text.includes(","), cfg3.items[0].text.slice(0, 60));
  check("预设很长（完整 prompt）", cfg3.items[0].text.length > 100, String(cfg3.items[0].text.length));
  const previewText = host3.querySelector(".ptm-preview-body").textContent || "";
  check("预览里能看到这条提示词", previewText.length > 100, String(previewText.length));
  check(
    "预览内容与预设一致",
    previewText.includes(cfg3.items[0].text.split(",")[0].trim()),
    previewText.slice(0, 80)
  );

  // 随机池：一个二级分类 = 一堆候选整句，抽 1 条
  const subRow = Array.from(host3.querySelectorAll(".ptm-col-2 .ptm-row")).find((r) =>
    (r.querySelector(".ptm-row-label") || {}).textContent === sub.name
  );
  if (subRow) {
    const dice = Array.from(subRow.querySelectorAll(".ptm-row-actions .ptm-mini")).find(
      (b) => (b.textContent || "").includes("🎲")
    );
    if (dice) {
      click(dice, "🎲 随机池");
      await sleep(120);
      const poolCfg = editor3.getConfig();
      const pool = poolCfg.items.find((i) => i.kind === "pool");
      check("能为预设分类建随机池", Boolean(pool), JSON.stringify(poolCfg.items.map((i) => i.kind)));
      if (pool) {
        // 关键：随机池只存引用，绝不把上千条候选塞进节点配置，
        // 否则工作流会变成几百 KB~几 MB，撑爆 localStorage 导致 ComfyUI 无法自动存档
        eq("随机池记录词库引用", pool.library, bigName);
        eq("随机池记录一级分类", pool.group, group.name);
        eq("随机池记录二级分类", pool.sub, sub.name);
        check("随机池不再内嵌候选列表", !pool.tags || pool.tags.length === 0, "仍内嵌了 " + (pool.tags || []).length);
        eq("随机池记录了候选数量（供界面显示）", pool.size, sub.tags.length);
        eq("随机池默认抽 1 条", pool.count, 1);

        const poolCfgText = JSON.stringify(poolCfg);
        check(
          "建了随机池后节点配置依然很小",
          poolCfgText.length < 2000,
          poolCfgText.length + " 字节（候选 " + sub.tags.length + " 条）"
        );

        // 执行侧：后端要能按引用解析出候选
        const prevRes = await (
          await fetch("/prompt_tag/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              config: poolCfgText,
              seed: 5,
              separator: ", ",
              dedupe: true,
              underscore_to_space: true,
              weight_style: "(tag:1.2)",
            }),
          })
        ).json();
        check(
          "后端能按引用解析随机池",
          prevRes.ok === true && (prevRes.prompt || "").length > 20,
          JSON.stringify(prevRes).slice(0, 120)
        );
        check("解析出的提示词来自该分类", (prevRes.prompt || "").includes("1girl"), (prevRes.prompt || "").slice(0, 60));
      }
    }
  }

  editor3.unmount();
  host3.remove();
}

console.log("\n[17] tag 列表排版（从上至下）+ 翻译可手动修改");
{
  // 用一份专属词库，避免改动污染别的用例（插件没有只读保护，改动会落盘）
  const fixtureLib = {
    name: "翻译测试库",
    groups: [
      {
        name: "测试一级",
        subs: [
          {
            name: "测试二级",
            tags: ["t_alpha", "t_beta", "t_gamma", "t_delta", "t_epsilon", "t_zeta"],
            descs: { t_alpha: "甲", t_beta: "乙", t_gamma: "丙" },
          },
        ],
      },
    ],
  };
  await fetch("/prompt_tag/library/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "翻译测试库", data: fixtureLib }),
  });

  const host4 = document.createElement("div");
  document.body.appendChild(host4);
  const editor4 = new TagEditor({
    onConfigChange: () => {},
    getOptions: () => ({ separator: ", ", dedupe: true, underscoreToSpace: true, weightStyle: "(tag:1.2)" }),
    getSeed: () => 1,
  });
  await editor4.mount(host4);
  await sleep(120);
  await editor4.switchLibrary("翻译测试库", { silent: true });
  await sleep(250);
  eq("已切到翻译测试库", editor4.state.libraryName, "翻译测试库");

  const g = editor4.state.library.groups[0];
  const s = g.subs[0];
  editor4.state.ui.group = g.name;
  editor4.state.ui.sub = s.name;
  editor4.renderColumns();
  await sleep(120);

  // 1) 单列纵向排列
  const tagsBox = host4.querySelector(".ptm-tags");
  check("tag 区是一个纵向列表容器", Boolean(tagsBox));
  const cs = window.getComputedStyle(tagsBox);
  check(
    "tag 区 flex-direction 为 column",
    (cs.flexDirection || "").includes("column"),
    "实际=" + (cs.flexDirection || "(空)")
  );
  const rows = host4.querySelectorAll(".ptm-tags > .ptm-tag");
  check("每一行都是一个 tag", rows.length > 5, String(rows.length));
  const firstRow = rows[0];
  check("tag 行整宽显示（不再是一颗颗胶囊）", (firstRow.className || "").includes("ptm-tag"));
  const descEl = firstRow.querySelector(".ptm-tag-desc");
  check("每行都有翻译列（含无翻译占位）", Boolean(descEl), "没有 .ptm-tag-desc");

  // 2) 翻译可编辑：点 ✎ 打开弹窗
  const targetTag = "t_alpha";
  const targetRow = Array.from(rows).find(
    (r) => (r.querySelector(".ptm-tag-text") || {}).textContent === targetTag
  );
  check("找到目标 tag 行", Boolean(targetRow), targetTag);
  const editBtn = targetRow && targetRow.querySelector(".ptm-tag-act");
  check("行内有翻译编辑按钮", Boolean(editBtn), "没有 .ptm-tag-act");
  if (editBtn) {
    click(editBtn, "编辑翻译");
    await sleep(120);
    const dlg = document.querySelector(".ptm-modal-backdrop .ptm-dialog");
    check("翻译编辑弹窗已打开", Boolean(dlg));
    const input = dlg.querySelector("input.ptm-input");
    check("弹窗里带出当前翻译", (input.value || "").length > 0, input.value);
    setValue(input, "我改的翻译", "input");
    click(byText(dlg.querySelectorAll(".ptm-dialog-foot .ptm-btn"), "确定"), "确定");
    await sleep(400);
    eq("翻译已写入词库数据", (s.descs || {})[targetTag], "我改的翻译");
    const rowAfter = Array.from(host4.querySelectorAll(".ptm-tags > .ptm-tag")).find(
      (r) => (r.querySelector(".ptm-tag-text") || {}).textContent === targetTag
    );
    eq(
      "翻译立刻显示在行里",
      (rowAfter.querySelector(".ptm-tag-desc") || {}).textContent,
      "我改的翻译"
    );

    // 落盘检查
    await editor4.flushSave();
    await sleep(200);
    const persisted4 = await (
      await fetch("/prompt_tag/library?name=" + encodeURIComponent(editor4.state.libraryName))
    ).json();
    const pSub = persisted4.data.groups
      .find((x) => x.name === g.name)
      .subs.find((x) => x.name === s.name);
    eq("翻译已保存到磁盘", (pSub.descs || {})[targetTag], "我改的翻译");
  }

  // 3) 批量编辑：同时改 tag 和翻译
  editor4.state.ui.group = g.name;
  editor4.state.ui.sub = s.name;
  const subRow = Array.from(host4.querySelectorAll(".ptm-col-2 .ptm-row")).find((r) =>
    (r.querySelector(".ptm-row-label") || {}).textContent === s.name
  );
  const batchBtn = subRow && byText(subRow.querySelectorAll(".ptm-row-actions .ptm-mini"), "≡");
  check("有批量编辑入口", Boolean(batchBtn));
  if (batchBtn) {
    click(batchBtn, "批量编辑");
    await sleep(150);
    const dlg = document.querySelector(".ptm-modal-backdrop .ptm-dialog");
    check("批量编辑弹窗已打开", Boolean(dlg));
    const area = dlg.querySelector("textarea");
    check("批量编辑里带出了翻译", (area.value || "").includes(" = "), (area.value || "").slice(0, 120));
    setValue(area, "bulk_tag_1 = 批量翻译一\nbulk_tag_2 = 批量翻译二\nbulk_tag_3\n");
    await sleep(60);
    check("批量弹窗统计带翻译行数", (dlg.textContent || "").includes("2 行带翻译"), dlg.textContent.slice(-80));
    click(byText(dlg.querySelectorAll(".ptm-dialog-foot .ptm-btn"), "保存"), "保存");
    await sleep(400);
    eq("批量后 tag 数", s.tags.length, 3);
    eq("批量翻译一", (s.descs || {}).bulk_tag_1, "批量翻译一");
    eq("批量翻译二", (s.descs || {}).bulk_tag_2, "批量翻译二");
    check("没写翻译的行没有翻译", !(s.descs || {}).bulk_tag_3, JSON.stringify(s.descs));
  }

  editor4.unmount();
  host4.remove();
}

console.log("\n[18] HTTP 接口开关（默认关闭，面板里可一键开启）");
{
  const postJson = (url, body) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  const api = await import("../web/js/tag_api.js");

  // 关掉接口
  const offRes = await postJson("/prompt_tag/switch", { enable: false });
  check("可以关闭 HTTP 接口", offRes.ok === true && offRes.http_enabled === false, JSON.stringify(offRes));

  const guardState = await (await fetch("/prompt_tag/state")).json();
  check(
    "关闭后 /state 被拒绝",
    guardState.ok === false && guardState.code === "http_disabled",
    JSON.stringify(guardState).slice(0, 120)
  );
  const guardLib = await (await fetch("/prompt_tag/library?name=renwu")).json();
  check("关闭后读词库被拒绝", guardLib.ok === false && guardLib.code === "http_disabled");
  const guardSave = await postJson("/prompt_tag/library/save", { name: "x", data: { groups: [] } });
  check("关闭后保存被拒绝", guardSave.ok === false && guardSave.code === "http_disabled");

  const statusOff = await (await fetch("/prompt_tag/status")).json();
  check("关闭后 /status 仍可访问", statusOff.ok === true && statusOff.http_enabled === false);
  eq("状态里标明默认是开启", statusOff.http_default, true);

  // 面板应进入「接口已关闭」模式，并给出开启按钮
  await api.probe(true);
  eq("前端识别为已关闭", api.apiState.mode, "disabled");
  check("isHttpDisabled 为真", api.isHttpDisabled() === true);

  const host5 = document.createElement("div");
  document.body.appendChild(host5);
  const editor5 = new TagEditor({ onConfigChange: () => {} });
  await editor5.mount(host5);
  await sleep(200);
  eq("面板状态为已关闭", editor5.state.mode, "disabled");
  const banner = host5.querySelector(".ptm-banner.warn");
  check("出现『接口已关闭』提示条", Boolean(banner), "没有 .ptm-banner.warn");
  check("提示条说明是本地词库", (banner?.textContent || "").includes("本地"), (banner?.textContent || "").slice(0, 80));
  const enableBtn = Array.from(host5.querySelectorAll(".ptm-banner .ptm-btn")).find((b) =>
    (b.textContent || "").includes("开启 HTTP 接口")
  );
  check("提示条里有开启按钮", Boolean(enableBtn));

  if (enableBtn) {
    click(enableBtn, "开启 HTTP 接口");
    await sleep(1200);
    eq("点击后面板切回后端模式", editor5.state.mode, "server");
    const diskNames = (editor5.libraries || []).map((l) => l.name);
    check("开启后加载到磁盘词库", diskNames.includes("renwu"), JSON.stringify(diskNames.slice(0, 6)));
    check(
      "开启后词库来自磁盘（人物库有内容）",
      (editor5.state.library.groups || []).length > 0,
      editor5.state.libraryName
    );
    check("提示条已隐藏", (host5.querySelector(".ptm-banner")?.style.display || "") === "none");
  }

  editor5.unmount();
  host5.remove();

  // 恢复开启状态，避免影响后续（服务端设置是持久的）
  const onRes = await postJson("/prompt_tag/switch", { enable: true });
  check("可以重新开启", onRes.ok === true && onRes.http_enabled === true);
  const statusOn = await (await fetch("/prompt_tag/status")).json();
  check("状态已变为开启", statusOn.http_enabled === true);
  await api.probe(true);
  eq("前端恢复为 server 模式", api.apiState.mode, "server");
}

console.log("\n[19] 老数据兼容：浏览器缓存清理 + 老随机池瘦身");
{
  const api = await import("../web/js/tag_api.js");

  // 1) 模拟旧版本留下的超大本地词库缓存（会占满 localStorage，连带 ComfyUI 存不了工作流）
  const bigLib = {
    name: "旧本地库",
    groups: [
      {
        name: "G",
        subs: [
          {
            name: "S",
            tags: Array.from({ length: 30000 }, (_, i) => "old_local_tag_" + i + "_" + "x".repeat(6)),
          },
        ],
      },
    ],
  };
  window.localStorage.setItem("ptm.offline.libraries.v2", JSON.stringify({ 旧本地库: bigLib }));
  const bigBefore = (window.localStorage.getItem("ptm.offline.libraries.v2") || "").length;
  check("造出过大的本地缓存", bigBefore > 512 * 1024, bigBefore + " 字节");

  await api.probe(true);
  await sleep(100);
  const bigAfter = (window.localStorage.getItem("ptm.offline.libraries.v2") || "").length;
  check("服务端模式下自动清空过大的本地缓存", bigAfter === 0, "剩余 " + bigAfter + " 字节");
  check("记录了释放的字节数", (api.apiState.freedBytes || 0) > 0, String(api.apiState.freedBytes));

  // 2) 老工作流：随机池内嵌上千条候选 → 打开面板后自动改成「只存引用」
  const host6 = document.createElement("div");
  document.body.appendChild(host6);
  const editor6 = new TagEditor({ onConfigChange: () => {} });
  await editor6.mount(host6);
  await sleep(150);
  // 用「一键模式」预设库做样本：整句提示词，内嵌后最容易把工作流撑爆
  const presetName = presetList.length ? presetList[0].name : "renwu";
  await editor6.switchLibrary(presetName, { silent: true });
  await sleep(400);

  const g6 = editor6.state.library.groups[0];
  const s6 = g6.subs.reduce((a, b) => ((b.tags || []).length > (a.tags || []).length ? b : a), g6.subs[0]);
  check("找到用于测试的二级分类", Boolean(s6 && s6.tags.length > 100), JSON.stringify(g6.subs.map((x) => x.name)));
  if (s6) {
    const legacyCfg = {
      v: 1,
      library: presetName,
      items: [{ kind: "pool", label: "老池", count: 1, weight: 1, enabled: true, tags: s6.tags.slice() }],
    };
    const legacySize = JSON.stringify(legacyCfg).length;
    check("老格式配置确实很大", legacySize > 100000, legacySize + " 字节");

    editor6.setConfig(legacyCfg);
    await sleep(200);
    const migrated = editor6.getConfig();
    const pool6 = migrated.items[0];
    check("老随机池仍在", Boolean(pool6 && pool6.kind === "pool"), JSON.stringify(migrated.items).slice(0, 120));
    check(
      "老随机池自动补上了库/分类引用",
      Boolean(pool6 && pool6.library && pool6.group && pool6.sub),
      JSON.stringify(pool6)
    );
    check("老随机池内嵌的候选已清空", !pool6?.tags || pool6.tags.length === 0, "仍内嵌 " + (pool6?.tags || []).length);
    eq("界面上仍显示候选数量", pool6?.size, s6.tags.length);
    const newSize = JSON.stringify(migrated).length;
    check("配置体积大幅下降", newSize < legacySize / 5, legacySize + " -> " + newSize + " 字节");

    // 迁移后执行侧仍能产出
    const prevRes = await (
      await fetch("/prompt_tag/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: JSON.stringify(migrated), seed: 9, separator: ", " }),
      })
    ).json();
    check("迁移后的配置执行正常", prevRes.ok === true && (prevRes.prompt || "").length > 0, JSON.stringify(prevRes).slice(0, 100));
  }

  editor6.unmount();
  host6.remove();
}

console.log("\n==================================");
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
