/**
 * ComfyUI 集成层测试：用一个假的 ComfyUI app / nodeType 驱动 web/prompt_tag_node.js，
 * 验证隐藏控件、按钮、预览同步、执行回调、面板开合、导入后重开不丢数据等行为。
 *
 * 需要先启动后端： python tests/e2e_server.py
 * 运行：PTM_JSDOM=... node tests/run_node_tests.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.dirname(HERE);
const BASE = process.env.PTM_BASE || "http://127.0.0.1:8399";

/* ------------------------------------------------------------- jsdom 环境 */

let jsdomMod = null;
for (const spec of [process.env.PTM_JSDOM, "jsdom", "jsdom/lib/api.js"].filter(Boolean)) {
  try {
    jsdomMod = await import(spec);
    break;
  } catch (err) {
    /* 下一个 */
  }
}
if (!jsdomMod) {
  console.error("找不到 jsdom，请先 npm install jsdom 或设置 PTM_JSDOM");
  process.exit(2);
}
const JSDOM = jsdomMod.JSDOM || (jsdomMod.default && jsdomMod.default.JSDOM);

const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="host"></div></body></html>`, {
  url: BASE + "/",
  pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Event = window.Event;
globalThis.MouseEvent = window.MouseEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.localStorage = window.localStorage;
globalThis.Blob = window.Blob;
globalThis.FileReader = window.FileReader;
globalThis.File = window.File;
globalThis.URL = window.URL;
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = () => "blob:ptm-test";
  globalThis.URL.revokeObjectURL = () => {};
}
try {
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: async () => {} },
    configurable: true,
  });
  globalThis.navigator = window.navigator;
} catch (err) {
  /* 部分环境不可写，忽略 */
}

const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) =>
  nativeFetch(typeof input === "string" ? new URL(input, BASE + "/").href : input, init);

/* ------------------------------------------------------------- 测试框架 */

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

function setValue(el, value, eventName = "input") {
  el.value = value;
  el.dispatchEvent(new window.Event(eventName, { bubbles: true }));
}

/* ------------------------------------------------ 生成被测模块（改写导入） */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ptm-node-test-"));
const fakeAppPath = path.join(tmpDir, "fake_app.mjs");
fs.writeFileSync(
  fakeAppPath,
  `export const app = {
  graph: { setDirtyCanvas() {} },
  registerExtension(ext) { globalThis.__PTM_EXT = ext; },
};
`,
  "utf-8"
);

const srcPath = path.join(PKG_DIR, "web", "prompt_tag_node.js");
let src = fs.readFileSync(srcPath, "utf-8");
src = src.replace(
  /from\s+"\.\.\/\.\.\/scripts\/app\.js"/,
  `from "${pathToFileURL(fakeAppPath).href}"`
);
src = src.replace(/from\s+"\.\/js\/([^"]+)"/g, (m, file) =>
  `from "${pathToFileURL(path.join(PKG_DIR, "web", "js", file)).href}"`
);
const testModulePath = path.join(tmpDir, "prompt_tag_node.test.mjs");
fs.writeFileSync(testModulePath, src, "utf-8");

const schema = JSON.parse(fs.readFileSync(path.join(HERE, "node_schema.json"), "utf-8"));

/* ------------------------------------------------------------- 假节点 */

/** 按 Python 侧声明的顺序造出控件，模拟 ComfyUI 建节点 */
function nodeWidgets() {
  const widgets = [];
  for (const w of schema.widgets) {
    let type = "text";
    if (w.type === "INT") type = "number";
    else if (w.type === "BOOLEAN") type = "toggle";
    else if (w.type === "COMBO") type = "combo";
    else if (w.type === "STRING") type = w.multiline ? "customtext" : "text";
    widgets.push({ type, name: w.name, value: w.default === "" ? "" : w.default, options: {} });
  }
  return widgets;
}

/** 以 nodeType.prototype 为原型造一个假节点实例 */
function makeNode(id = 7) {
  const node = Object.create(nodeType.prototype);
  node.id = id;
  node.title = "随机 TAG 提示词（三级词库）";
  node.widgets = nodeWidgets();
  node.properties = {};
  node.size = [320, 200];
  node.dirtyCount = 0;
  node.addWidget = function (type, name, value, callback, options) {
    const widget = { type, name, value, callback, options: options || {} };
    this.widgets.push(widget);
    return widget;
  };
  node.setDirtyCanvas = function () {
    this.dirtyCount += 1;
  };
  node.findWidget = function (name) {
    return this.widgets.find((w) => w.name === name) || null;
  };
  return node;
}

/* ------------------------------------------------------------- 开始测试 */

await import(pathToFileURL(testModulePath).href);
const ext = globalThis.__PTM_EXT;

console.log("\n[1] 扩展注册");
check("扩展已注册", Boolean(ext), "app.registerExtension 未被调用");
eq("扩展名", ext?.name, "PromptTagManager.Node");
check("注入了样式表", Boolean(document.querySelector('link[data-ptm-style="1"]')), "没有 link 标签");
check(
  "样式表指向插件目录",
  (document.querySelector('link[data-ptm-style="1"]')?.href || "").includes("css/prompt_tag.css"),
  document.querySelector('link[data-ptm-style="1"]')?.href || ""
);

console.log("\n[2] 只处理自己的节点");
const otherType = { prototype: {} };
const before = JSON.stringify(Object.keys(otherType.prototype));
await ext.beforeRegisterNodeDef(otherType, { name: "KSampler" });
eq("其它节点原型未被改动", JSON.stringify(Object.keys(otherType.prototype)), before);

const nodeType = { prototype: {} };
await ext.beforeRegisterNodeDef(nodeType, { name: "PromptTagSelector" });
check("挂上了 onNodeCreated", typeof nodeType.prototype.onNodeCreated === "function");

console.log("\n[3] onNodeCreated");
const node = makeNode();
node.onNodeCreated();
await sleep(30);

const configWidget = node.findWidget("tag_config");
check("配置控件存在", Boolean(configWidget));
eq("配置控件被隐藏", configWidget?.type, "hidden");
eq("隐藏后不占高度", configWidget?.computeSize?.()[1], -4);
check("隐藏控件仍会序列化", configWidget?.options?.serialize !== false);

const buttons = node.widgets.filter((w) => w.type === "button");
eq("新增 3 个按钮", buttons.length, 3);
check(
  "按钮不参与序列化",
  buttons.every((b) => b.options && b.options.serialize === false),
  JSON.stringify(buttons.map((b) => b.options))
);
check(
  "按钮文字可读",
  buttons.some((b) => b.name.includes("打开")) &&
    buttons.some((b) => b.name.includes("种子")) &&
    buttons.some((b) => b.name.includes("清空")),
  buttons.map((b) => b.name).join(" | ")
);

const cfg = JSON.parse(configWidget.value);
eq("初始配置为空", cfg.items.length, 0);
eq("初始配置带版本号", cfg.v, 1);
check("配置写入了 properties", node.properties.prompt_tag_config === configWidget.value);

const previewWidget = node.findWidget("prompt_preview");
check("预览控件存在", Boolean(previewWidget));
eq("初始预览为空", previewWidget?.value, "");
check("预览控件被标记只读", Boolean(previewWidget?.disabled));

console.log("\n[4] 打开面板并勾选 tag");
const { getTagWindow, closeTagWindow } = await import(
  pathToFileURL(path.join(PKG_DIR, "web", "js", "tag_window.js")).href
);
buttons.find((b) => b.name.includes("打开")).callback();
await sleep(900);

let handle = getTagWindow(node.id);
check("面板窗口已打开", Boolean(handle));
check("面板里编辑器就绪", handle?.editor?.state?.status === "ready", handle?.editor?.state?.error);

const editorRoot = document.querySelector(".ptm-window .ptm-root");
check("面板 DOM 已渲染", Boolean(editorRoot));
const tagChips = editorRoot.querySelectorAll(".ptm-tag");
check("面板里有 tag 可选", tagChips.length > 10, String(tagChips.length));
tagChips[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(80);

const cfgAfter = JSON.parse(node.findWidget("tag_config").value);
eq("勾选后配置有 1 个 tag", cfgAfter.items.length, 1);
check("配置记录了词库名", Boolean(cfgAfter.library), cfgAfter.library);
check(
  "节点预览已同步",
  (node.findWidget("prompt_preview").value || "").length > 0,
  node.findWidget("prompt_preview").value
);
check(
  "预览内容包含所选 tag",
  (node.findWidget("prompt_preview").value || "").includes(cfgAfter.items[0].text.split("_").join(" ")),
  node.findWidget("prompt_preview").value
);
check("节点被要求重绘", node.dirtyCount > 0);

console.log("\n[5] 选项变化刷新预览");
const sepWidget = node.findWidget("separator");
check("separator 控件存在", Boolean(sepWidget));
if (sepWidget && sepWidget.callback) {
  sepWidget.value = " | ";
  sepWidget.callback(sepWidget.value);
  await sleep(30);
  check(
    "预览跟随连接符变化",
    !(node.findWidget("prompt_preview").value || "").includes(", "),
    node.findWidget("prompt_preview").value
  );
}

const weightWidget = node.findWidget("weight_style");
if (weightWidget && weightWidget.callback) {
  weightWidget.value = "(tag:1.2)";
  weightWidget.callback(weightWidget.value);
}

console.log("\n[6] 换种子 / 清空");
const seedWidget = node.findWidget("seed");
const seedBefore = seedWidget.value;
buttons.find((b) => b.name.includes("种子")).callback();
await sleep(30);
check("种子已改变", seedWidget.value !== seedBefore, `${seedBefore} -> ${seedWidget.value}`);
check("种子是合法整数", Number.isInteger(Number(seedWidget.value)));

buttons.find((b) => b.name.includes("清空")).callback();
await sleep(60);
eq("清空后配置无 tag", JSON.parse(node.findWidget("tag_config").value).items.length, 0);

console.log("\n[7] onExecuted / onConfigure / onRemoved");
node.onExecuted({ text: ["FINAL, PROMPT"], tags: [["FINAL", "PROMPT"]] });
eq("执行结果写进预览", node.findWidget("prompt_preview").value, "FINAL, PROMPT");
eq("执行结果存进 properties", node.properties.prompt_tag_last, "FINAL, PROMPT");

const cfgKeep = node.findWidget("tag_config").value;
node.onConfigure({});
await sleep(50);
eq("onConfigure 不会清空配置", node.findWidget("tag_config").value, cfgKeep);

node.onRemoved();
await sleep(120);
check("移除节点后窗口关闭", !document.querySelector(".ptm-window"));
check("窗口句柄已释放", getTagWindow(node.id) === null);

console.log("\n[8] 坏配置容错");
const node2 = makeNode(8);
node2.findWidget("tag_config").value = "{这不是合法JSON";
node2.onNodeCreated();
await sleep(30);
const badCfg = JSON.parse(node2.findWidget("tag_config").value);
eq("坏配置被重置为空配置", badCfg.items.length, 0);
check("重置后仍是合法 JSON", typeof badCfg.v === "number");

/* -------------------------------------------------- [9] 导入 → 重开不丢 */
// 回归：以前「编辑后立刻导入 / 自动保存与导入竞争」会让磁盘上的旧快照盖掉导入结果，
// 表现就是「导入完 tag，关掉面板再打开，导入的 tag 没了」。
console.log("\n[9] 导入后重开面板不丢数据");

async function waitReady(n, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const h = getTagWindow(n.id);
    if (h && h.editor.state.status === "ready") return h;
    await sleep(100);
  }
  return getTagWindow(n.id);
}

async function openPanelOf(n) {
  n.widgets.find((w) => w.type === "button" && w.name.includes("打开")).callback();
  return waitReady(n);
}

function clickByText(nodes, text) {
  const el = Array.from(nodes).find((x) => (x.textContent || "").trim().includes(text));
  if (!el) throw new Error("找不到按钮：" + text);
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return el;
}

async function importInto(n, text, mode = "merge", newName = null) {
  const h = getTagWindow(n.id);
  clickByText(h.win.querySelectorAll(".ptm-toolbar .ptm-btn"), "导入");
  await sleep(150);
  const dlg = document.querySelector(".ptm-modal-backdrop .ptm-dialog");
  if (!dlg) throw new Error("导入弹窗没出现");
  const area = dlg.querySelector("textarea");
  area.value = text;
  area.dispatchEvent(new window.Event("input", { bubbles: true }));
  await sleep(60);
  if (mode !== "merge") {
    const sel = dlg.querySelector("select.ptm-select");
    sel.value = mode;
    sel.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(40);
    if (newName) {
      const inp = dlg.querySelector("input.ptm-input");
      inp.value = newName;
      inp.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
  }
  clickByText(dlg.querySelectorAll(".ptm-dialog-foot .ptm-btn"), "开始导入");
  await sleep(800);
}

/** 清空本地自定义翻译，让「翻译/保存译文」相关用例可以重复跑 */
async function clearCustomDescs() {
  const res = await (await fetch("/prompt_tag/descs")).json();
  const keys = Object.keys(res.descs || {});
  if (!keys.length) return 0;
  await fetch("/prompt_tag/descs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ descs: {}, remove: keys }),
  });
  return keys.length;
}

function hasTagIn(editor, group, tag) {  return (editor.state.library.groups || []).some(
    (g) => g.name === group && g.subs.some((s) => s.tags.includes(tag))
  );
}

/** 建节点并跑一次 onNodeCreated（会挂上按钮/隐藏控件/预览同步） */
function makeLiveNode(id) {
  const n = makeNode(id);
  n.onNodeCreated();
  return n;
}

// 9.1 合并导入内置词库 → 关闭 → 重开
{
  const n = makeLiveNode(91);
  const h = await openPanelOf(n);
  check("9.1 面板就绪", Boolean(h && h.editor.state.status === "ready"), h?.editor?.state?.error);
  await h.editor.switchLibrary("renwu", { silent: true });
  await sleep(200);
  eq("9.1 已切到内置人物词库", h.editor.state.libraryName, "renwu");
  await importInto(n, "重开测试组,重开子,reopen_tag_a\n", "merge");
  eq("9.1 导入内置后词库名不变（直接改内置文件）", h.editor.state.libraryName, "renwu");
  check("9.1 导入后编辑器里有新 tag", hasTagIn(h.editor, "重开测试组", "reopen_tag_a"));
  eq("9.1 节点配置里的词库名同步", JSON.parse(n.findWidget("tag_config").value).library, "renwu");

  closeTagWindow(n.id);
  await sleep(250);
  const h2 = await openPanelOf(n);
  eq("9.1 重开后词库还是同一个", h2.editor.state.libraryName, "renwu");
  check("9.1 重开后导入的 tag 还在", hasTagIn(h2.editor, "重开测试组", "reopen_tag_a"));
  closeTagWindow(n.id);
  await sleep(150);
}

// 9.2 编辑后立刻导入（与自动保存竞争）→ 两边数据都要在
{
  const n = makeLiveNode(92);
  const h = await openPanelOf(n);
  await h.editor.switchLibrary("renwu", { silent: true });
  await sleep(200);
  h.editor.state.library.groups.push({
    name: "编辑组",
    subs: [{ name: "编辑子", tags: ["edited_tag"] }],
  });
  h.editor.markLibDirty();
  await sleep(50); // 故意不等防抖，抢在自动保存之前导入
  await importInto(n, "导入组,导入子,imported_tag\n", "merge");
  check("9.2 编辑的 tag 没被导入覆盖", hasTagIn(h.editor, "编辑组", "edited_tag"));
  check("9.2 导入的 tag 也在", hasTagIn(h.editor, "导入组", "imported_tag"));

  closeTagWindow(n.id);
  await sleep(250);
  const h2 = await openPanelOf(n);
  check("9.2 重开后编辑的 tag 还在", hasTagIn(h2.editor, "编辑组", "edited_tag"));
  check("9.2 重开后导入的 tag 还在", hasTagIn(h2.editor, "导入组", "imported_tag"));
  closeTagWindow(n.id);
  await sleep(150);
}

// 9.3 存为新词库 → 重开
{
  const n = makeLiveNode(93);
  const h = await openPanelOf(n);
  await importInto(n, "新库组,新库子,newlib_tag\n", "new", "重开新库");
  eq("9.3 已切到新词库", h.editor.state.libraryName, "重开新库");
  closeTagWindow(n.id);
  await sleep(250);
  const h2 = await openPanelOf(n);
  eq("9.3 重开后是新词库", h2.editor.state.libraryName, "重开新库");
  check("9.3 重开后新词库 tag 在", hasTagIn(h2.editor, "新库组", "newlib_tag"));
  closeTagWindow(n.id);
  await sleep(150);
}

// 9.4 词库被删掉后重开 → 自动回退，不留空白
{
  const n = makeLiveNode(94);
  await openPanelOf(n);
  await importInto(n, "临时组,临时子,temp_tag\n", "new", "会被删掉的库");
  closeTagWindow(n.id);
  await sleep(200);
  const del = await fetch("/prompt_tag/library/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "会被删掉的库" }),
  });
  check("9.4 测试库已从服务端删除", (await del.json()).ok);
  const h2 = await openPanelOf(n);
  check("9.4 词库没了也能打开面板", h2.editor.state.status === "ready", h2.editor.state.error);
  check("9.4 自动回退到别的词库", h2.editor.state.libraryName !== "会被删掉的库", h2.editor.state.libraryName);
  check("9.4 回退后词库有内容", (h2.editor.state.library.groups || []).length > 0, "空词库");
  closeTagWindow(n.id);
  await sleep(150);
}

/* ---------------------------------------------- [10] 手动提示词框 */
console.log("\n[10] 手动提示词框（节点 + 面板同步）");
{
  check("节点有 manual_mode 控件", Boolean(node.findWidget("manual_mode")));
  check("节点有 manual_prompt 控件", Boolean(node.findWidget("manual_prompt")));
  eq("manual_mode 默认值", node.findWidget("manual_mode")?.value, "两者结合（提示词框在前）");

  const n = makeLiveNode(101);
  n.findWidget("tag_config").value = JSON.stringify({
    v: 1,
    library: "",
    items: [{ kind: "tag", text: "1girl", weight: 1.0, enabled: true }],
  });
  n.findWidget("manual_prompt").value = "masterpiece, best quality";
  n.findWidget("manual_mode").value = "两者结合（提示词框在前）";
  n.findWidget("manual_space_as_sep").value = false;
  n.findWidget("manual_prompt").callback?.(n.findWidget("manual_prompt").value);
  await sleep(80);
  const prev = n.findWidget("prompt_preview").value || "";
  check("预览包含手写提示词", prev.includes("masterpiece"), prev.slice(0, 90));
  check("预览包含 tag", prev.includes("1girl"), prev.slice(0, 90));

  n.findWidget("manual_mode").value = "仅使用提示词框";
  n.findWidget("manual_mode").callback?.("仅使用提示词框");
  await sleep(80);
  eq(
    "仅提示词框时预览只有手写内容",
    (n.findWidget("prompt_preview").value || "").trim(),
    "masterpiece, best quality"
  );

  // 组合顺序：切回"在前"应把提示词框放最前
  n.findWidget("manual_mode").value = "两者结合（提示词框在前）";
  n.findWidget("manual_mode").callback?.("两者结合（提示词框在前）");
  await sleep(80);
  check(
    "两者结合（在前）预览顺序正确",
    (n.findWidget("prompt_preview").value || "").trim().startsWith("masterpiece"),
    (n.findWidget("prompt_preview").value || "").slice(0, 60)
  );

  const h = await openPanelOf(n);
  const area = h.win.querySelector(".ptm-manual-input");
  check("面板有提示词框", Boolean(area), "没找到 .ptm-manual-input");
  const modeSel = h.win.querySelector(".ptm-manual-head select");
  check("面板有使用方式下拉", Boolean(modeSel));
  const spaceBox = h.win.querySelector('.ptm-manual-head input[type="checkbox"]');
  check("面板有『空格转连接符』开关", Boolean(spaceBox), "没找到开关");
  if (area && modeSel) {
    eq("面板带出节点里的使用方式", modeSel.value, "两者结合（提示词框在前）");
    setValue(area, "面板里输入的手写提示词");
    await sleep(600); // 有 260ms 防抖
    eq("面板输入会写回节点", n.findWidget("manual_prompt").value, "面板里输入的手写提示词");
    check(
      "面板预览包含手写内容",
      (h.win.querySelector(".ptm-preview-body").textContent || "").includes("面板里输入的手写提示词"),
      h.win.querySelector(".ptm-preview-body").textContent
    );

    setValue(modeSel, "仅使用提示词框", "change");
    await sleep(250);
    eq("面板切换使用方式会写回节点", n.findWidget("manual_mode").value, "仅使用提示词框");
    eq(
      "切到仅提示词框后预览只剩手写内容",
      (h.win.querySelector(".ptm-preview-body").textContent || "").trim(),
      "面板里输入的手写提示词"
    );

    setValue(modeSel, "两者结合（提示词框在前）", "change");
    await sleep(250);
    check(
      "切回两者结合后预览含 tag",
      (h.win.querySelector(".ptm-preview-body").textContent || "").includes("1girl"),
      h.win.querySelector(".ptm-preview-body").textContent
    );

    // 「提示词历史」(ComfyUI-PromptHistory) 注入：外部直接改控件值并触发 callback，
    // 打开的面板里要立刻显示同一份内容
    n.findWidget("manual_prompt").value = "历史面板注入的提示词";
    n.findWidget("manual_prompt").callback?.("历史面板注入的提示词");
    await sleep(120);
    eq(
      "外部注入后面板提示词框同步",
      h.win.querySelector(".ptm-manual-input").value,
      "历史面板注入的提示词"
    );

    n.findWidget("manual_prompt").value = "节点里改的";
    closeTagWindow(n.id);
    await sleep(250);
    const h2 = await openPanelOf(n);
    eq("重开面板带出节点里的手写内容", h2.win.querySelector(".ptm-manual-input").value, "节点里改的");
    closeTagWindow(n.id);
  } else {
    closeTagWindow(n.id);
  }
  await sleep(150);
}

/* ------------------------------- [12] 面板里切换「空格转连接符」 */
console.log("\n[12] 空格转连接符（节点 + 面板同步）");
{
  const n = makeLiveNode(121);
  n.findWidget("tag_config").value = JSON.stringify({ items: [] });
  n.findWidget("manual_prompt").value = "masterpiece best quality solo";
  n.findWidget("manual_mode").value = "仅使用提示词框";
  n.findWidget("manual_space_as_sep").value = false;
  const h = await openPanelOf(n);
  await sleep(250);

  const spaceBox = h.win.querySelector('.ptm-manual-head input[type="checkbox"]');
  const previewText = () => (h.win.querySelector(".ptm-preview-body")?.textContent || "").trim();
  check("面板有空格转连接符开关", Boolean(spaceBox));
  check("默认未勾选", spaceBox ? spaceBox.checked === false : false);
  eq("关闭时保留原样", previewText(), "masterpiece best quality solo");

  if (spaceBox) {
    spaceBox.checked = true;
    spaceBox.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(300);
    eq("勾选后写回节点", n.findWidget("manual_space_as_sep").value, true);
    eq("预览已转换", previewText(), "masterpiece, best, quality, solo");

    spaceBox.checked = false;
    spaceBox.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(300);
    eq("取消后写回节点", n.findWidget("manual_space_as_sep").value, false);
    eq("预览恢复原样", previewText(), "masterpiece best quality solo");
  }

  closeTagWindow(n.id);
  await sleep(150);
}

/* ------------------------------- [13] 自然语言框（节点 + 面板同步） */
console.log("\n[13] 自然语言框（节点 + 面板同步）");
{
  const n = makeLiveNode(131);
  n.findWidget("tag_config").value = JSON.stringify({ items: [{ kind: "tag", text: "1girl", weight: 1.0 }] });
  n.findWidget("manual_mode").value = "仅使用 TAG 词库";
  n.findWidget("natural_prompt").value = "a girl standing in the rain";
  n.findWidget("natural_append").value = false;
  const h = await openPanelOf(n);
  await sleep(250);

  const natArea = h.win.querySelector(".ptm-natural-input");
  const natHead = natArea ? natArea.previousElementSibling : null;
  const natBox = natHead ? natHead.querySelector('input[type="checkbox"]') : null;
  const previewText = () => (h.win.querySelector(".ptm-preview-body")?.textContent || "").trim();

  check("面板有自然语言框", Boolean(natArea), "没找到 .ptm-natural-input");
  check("面板有『组合在末尾』开关", Boolean(natBox));
  eq("面板带出节点里的自然语言", natArea ? natArea.value : "", "a girl standing in the rain");
  eq("默认未勾选时不参与", previewText(), "1girl");

  if (natBox) {
    natBox.checked = true;
    natBox.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(300);
    eq("勾选后写回节点", n.findWidget("natural_append").value, true);
    check(
      "预览末尾出现自然语言",
      previewText().endsWith("a girl standing in the rain"),
      previewText()
    );
    check("预览里 tag 仍在前面", previewText().startsWith("1girl"), previewText());

    natBox.checked = false;
    natBox.dispatchEvent(new window.Event("change", { bubbles: true }));
    await sleep(300);
    eq("取消后写回节点", n.findWidget("natural_append").value, false);
    eq("预览恢复", previewText(), "1girl");
  }

  if (natArea) {
    setValue(natArea, "面板里写的自然语言");
    await sleep(600);
    eq("面板输入写回节点", n.findWidget("natural_prompt").value, "面板里写的自然语言");
  }

  closeTagWindow(n.id);
  await sleep(150);
}

/* ------------------------------- [14] 提示词框便捷删减 */
console.log("\n[14] 提示词框的「整理 / 去重 / 删末尾」");
{
  const n = makeLiveNode(141);
  n.findWidget("tag_config").value = JSON.stringify({ items: [] });
  n.findWidget("manual_mode").value = "仅使用提示词框";
  n.findWidget("manual_prompt").value = "masterpiece, best quality, masterpiece, solo, ";
  const h = await openPanelOf(n);
  await sleep(250);

  const area = h.win.querySelector(".ptm-manual-input");
  const tools = Array.from(h.win.querySelectorAll(".ptm-manual-head .ptm-btn")).map((b) =>
    (b.textContent || "").trim()
  );
  check("有整理按钮", tools.includes("整理"), JSON.stringify(tools));
  check("有去重按钮", tools.includes("去重"), JSON.stringify(tools));
  check("有删末尾按钮", tools.includes("删末尾"), JSON.stringify(tools));

  const clickTool = (label) => {
    const btn = Array.from(h.win.querySelectorAll(".ptm-manual-head .ptm-btn")).find(
      (b) => (b.textContent || "").trim() === label
    );
    if (btn) btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    return Boolean(btn);
  };
  const previewText = () => (h.win.querySelector(".ptm-preview-body")?.textContent || "").trim();

  // 整理：统一连接符 + 去重 + 去掉末尾空段
  check("点整理", clickTool("整理"));
  await sleep(500);
  eq("整理后内容", area.value, "masterpiece, best quality, solo");
  eq("整理后写回节点", n.findWidget("manual_prompt").value, "masterpiece, best quality, solo");
  eq("预览同步", previewText(), "masterpiece, best quality, solo");

  // 删末尾
  check("点删末尾", clickTool("删末尾"));
  await sleep(500);
  eq("删末尾后内容", area.value, "masterpiece, best quality");
  eq("删末尾后写回节点", n.findWidget("manual_prompt").value, "masterpiece, best quality");

  // 去重
  n.findWidget("manual_prompt").value = "a, B, a, b, c";
  h.editor.refreshManualFromHost();
  area.value = "a, B, a, b, c";
  check("点去重", clickTool("去重"));
  await sleep(500);
  eq("去重后内容（忽略大小写）", area.value, "a, B, c");

  // 清空
  check("点清空", clickTool("清空"));
  await sleep(400);
  eq("清空后内容", area.value, "");
  eq("清空后节点值", n.findWidget("manual_prompt").value, "");

  closeTagWindow(n.id);
  await sleep(150);
}

/* ------------------- [15] 提示词框分段：逐段翻译 + 逐段删除 */
console.log("\n[15] 提示词框分段条（翻译 / 删除）");
{
  const n = makeLiveNode(151);
  n.findWidget("tag_config").value = JSON.stringify({ items: [] });
  n.findWidget("manual_mode").value = "仅使用提示词框";
  n.findWidget("manual_prompt").value = "1girl, long hair, (red_hair:1.2), masterpiece, a girl in the rain";
  const h = await openPanelOf(n);
  await sleep(300);
  await h.editor.switchLibrary("renwu", { silent: true });
  await sleep(300);
  h.editor.refreshManualFromHost();
  h.editor.renderManualSegments();
  await sleep(150);

  const bar = h.win.querySelector(".ptm-manual-segs");
  check("有分段条", Boolean(bar), "没找到 .ptm-manual-segs");
  const segs = bar ? bar.querySelectorAll(".ptm-manual-seg") : [];
  eq("分段数量正确", segs.length, 5);
  eq(
    "分段内容正确",
    Array.from(segs).map((el) => (el.querySelector(".ptm-manual-seg-text") || {}).textContent),
    ["1girl", "long hair", "(red_hair:1.2)", "masterpiece", "a girl in the rain"]
  );
  check("每段都有删除按钮", Array.from(segs).every((el) => el.querySelector(".ptm-manual-seg-del")));

  const mixed1 = h.editor.lookupSegmentDesc("long hair");
  const mixed2 = h.editor.lookupSegmentDesc("long_hair");
  check("空格写法能查到翻译（long hair）", Boolean(mixed1), "空");
  eq("空格/下划线两种写法结果一致", mixed1, mixed2);
  check("权重语法里也能查到翻译", Boolean(h.editor.lookupSegmentDesc("(red_hair:1.2)")), "");
  eq(
    "查不到的段落没有翻译",
    h.editor.lookupSegmentDesc("a girl in the rain"),
    ""
  );
  check("分段条显示翻译覆盖数", (bar.textContent || "").includes("翻译"), bar.textContent.slice(0, 60));

  // 逐段删除：删第 2 段（long hair）
  segs[1].querySelector(".ptm-manual-seg-del").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(600);
  eq(
    "删除后提示词框内容",
    h.win.querySelector(".ptm-manual-input").value,
    "1girl, (red_hair:1.2), masterpiece, a girl in the rain"
  );
  eq(
    "删除后写回节点",
    n.findWidget("manual_prompt").value,
    "1girl, (red_hair:1.2), masterpiece, a girl in the rain"
  );
  eq("删除后分段数减少", h.win.querySelectorAll(".ptm-manual-seg").length, 4);
  check(
    "删除后预览同步",
    !(h.win.querySelector(".ptm-preview-body").textContent || "").includes("long hair"),
    h.win.querySelector(".ptm-preview-body").textContent
  );

  h.win.querySelector(".ptm-manual-seg-del").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(600);
  eq(
    "再删一段",
    h.win.querySelector(".ptm-manual-input").value,
    "(red_hair:1.2), masterpiece, a girl in the rain"
  );

  clickByText(h.win.querySelectorAll(".ptm-manual-head .ptm-btn"), "清空");
  await sleep(400);
  eq("清空后分段条隐藏", h.win.querySelector(".ptm-manual-segs").style.display, "none");

  closeTagWindow(n.id);
  await sleep(150);
}

/* ------------------------- [16] 翻译接口（分段机翻） */
console.log("\n[16] 翻译接口：分段机翻 + 设置");
{
  // 确保这两段还没有本地译文（否则「翻译缺失段」无事可做）
  await clearCustomDescs();

  const n = makeLiveNode(161);
  n.findWidget("tag_config").value = JSON.stringify({ items: [] });
  n.findWidget("manual_mode").value = "仅使用提示词框";
  n.findWidget("manual_prompt").value = "a girl in the rain, cinematic lighting";
  const h = await openPanelOf(n);
  await sleep(250);
  await h.editor.switchLibrary("renwu", { silent: true });
  await sleep(300);
  h.editor.refreshManualFromHost();
  h.editor.renderManualSegments();
  await sleep(150);

  const bar = h.win.querySelector(".ptm-manual-segs");
  const buttons = Array.from(bar.querySelectorAll(".ptm-btn")).map((b) => (b.textContent || "").trim());
  check("分段条有翻译按钮", buttons.some((t) => t.includes("翻译缺失段")), JSON.stringify(buttons));
  check("分段条有翻译设置按钮", buttons.some((t) => t.includes("⚙")), JSON.stringify(buttons));

  // 这两句自然语言在词库里查不到翻译
  check("初始没有译文", !h.editor.getApiDesc("a girl in the rain"), "已有译文");

  const btn = Array.from(bar.querySelectorAll(".ptm-btn")).find((b) => (b.textContent || "").includes("翻译缺失段"));
  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(1200);

  check("翻译后拿到了机翻译文", Boolean(h.editor.getApiDesc("a girl in the rain")), "没有译文");
  check("译文来自接口（fake 带标记）", h.editor.getApiDesc("a girl in the rain").includes("机翻"), h.editor.getApiDesc("a girl in the rain"));
  const apiDescEls = h.win.querySelectorAll(".ptm-manual-seg-desc.api");
  check("分段条上显示了机翻文字", apiDescEls.length >= 1, String(apiDescEls.length));
  check(
    "分段条显示机翻数量徽标",
    (h.win.querySelector(".ptm-manual-segs").textContent || "").includes("机翻"),
    h.win.querySelector(".ptm-manual-segs").textContent.slice(0, 80)
  );

  // 再次点击：应该提示没有需要翻译的
  const btn2 = Array.from(h.win.querySelectorAll(".ptm-manual-segs .ptm-btn")).find((b) =>
    (b.textContent || "").includes("翻译缺失段")
  );
  check("翻完之后按钮不再带数量", (btn2.textContent || "").trim() === "翻译缺失段", btn2.textContent);

  // 中文段不该被翻译（已经是目标语言时接口照样返回，但这里只验证接口链路）
  const apiRes = await (
    await fetch("/prompt_tag/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: ["long hair"] }),
    })
  ).json();
  check("翻译接口可用", apiRes.ok === true && apiRes.translations["long hair"], JSON.stringify(apiRes).slice(0, 120));
  check("接口返回服务名", Boolean(apiRes.provider), JSON.stringify(apiRes.provider));

  const again = await (
    await fetch("/prompt_tag/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: ["long hair"] }),
    })
  ).json();
  check("第二次走缓存", again.cached >= 1, JSON.stringify(again).slice(0, 100));

  const settingsRes = await (await fetch("/prompt_tag/translate/settings")).json();
  check("能读到翻译设置", settingsRes.ok === true && settingsRes.settings.provider, JSON.stringify(settingsRes).slice(0, 120));
  check("设置里不暴露 Key", settingsRes.settings.api_key === "", JSON.stringify(settingsRes.settings.api_key));
  check("设置里带服务列表", Array.isArray(settingsRes.settings.providers), "");

  const testRes = await (
    await fetch("/prompt_tag/translate/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  ).json();
  check("测试接口可用", testRes.ok === true && testRes.result, JSON.stringify(testRes).slice(0, 120));

  closeTagWindow(n.id);
  await sleep(150);
}

/* ------------------------------- [11] 老工作流控件值错位自愈 */
console.log("\n[11] 老工作流控件值错位自愈");
{
  const n = makeLiveNode(111);
  // 模拟「旧版工作流按位置填值」造成的错位：separator 拿到 bool 等
  n.findWidget("seed").value = true;
  n.findWidget("separator").value = true;
  n.findWidget("dedupe").value = "(tag:1.2)";
  n.findWidget("underscore_to_space").value = "";
  n.findWidget("weight_style").value = "";
  n.findWidget("manual_mode").value = "";
  check("先造出错位状态", n.findWidget("separator").value === true);

  // onConfigure 里会自动修复
  n.onConfigure({ widgets_values: [] });
  await sleep(120);

  check("separator 被修回字符串", typeof n.findWidget("separator").value === "string", String(n.findWidget("separator").value));
  eq("separator 恢复默认值", n.findWidget("separator").value, ", ");
  eq("dedupe 被修回布尔", n.findWidget("dedupe").value, true);
  eq("underscore_to_space 被修回布尔", n.findWidget("underscore_to_space").value, true);
  eq("weight_style 被修回合法值", n.findWidget("weight_style").value, "不输出权重");
  eq("manual_mode 被修回合法值", n.findWidget("manual_mode").value, "两者结合（提示词框在前）");
  eq("seed 被修回数字", n.findWidget("seed").value, 0);

  // 修复后能正常预览
  n.findWidget("tag_config").value = JSON.stringify({ items: [{ kind: "tag", text: "1girl", weight: 1.0 }] });
  const sepW = n.findWidget("separator");
  if (sepW && sepW.callback) sepW.callback(sepW.value); // 触发 refreshPreview
  await sleep(80);
  check(
    "修复后预览正常",
    (n.findWidget("prompt_preview").value || "").includes("1girl"),
    n.findWidget("prompt_preview").value
  );
}

/* ---------------- [17] 译文可修改并保存到本地（自定义翻译） */
console.log("\n[17] 译文修改 + 保存到本地");
{
  // 上一轮跑测试可能留下自定义翻译，先清空，保证可重复执行
  await clearCustomDescs();

  const n = makeLiveNode(171);
  n.findWidget("tag_config").value = JSON.stringify({ items: [] });
  n.findWidget("manual_mode").value = "仅使用提示词框";
  n.findWidget("manual_prompt").value = "a girl in the rain, cinematic lighting, long hair";
  const h = await openPanelOf(n);
  await sleep(250);
  await h.editor.switchLibrary("renwu", { silent: true });
  await sleep(300);
  h.editor.refreshManualFromHost();
  h.editor.renderManualSegments();
  await sleep(150);

  // 先翻译出机翻
  const btn = Array.from(h.win.querySelectorAll(".ptm-manual-segs .ptm-btn")).find((b) =>
    (b.textContent || "").includes("翻译缺失段")
  );
  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(1200);
  check("机翻有了", Boolean(h.editor.getApiDesc("a girl in the rain")), "空");

  // 点译文就能改：弹窗预填当前译文，改成自定义文字后保存
  const apiDescEl = h.win.querySelector(".ptm-manual-seg-desc.api");
  check("机翻文字可点击", Boolean(apiDescEl), "没找到 .ptm-manual-seg-desc.api");
  apiDescEl.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(150);
  const dlg = document.querySelector(".ptm-modal-backdrop .ptm-dialog");
  check("弹出译文编辑框", Boolean(dlg), "弹窗没出现");
  const input = dlg.querySelector("input.ptm-input");
  check("编辑框预填了当前译文", (input.value || "").length > 0, String(input.value));
  input.value = "雨天里的女孩";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  clickByText(dlg.querySelectorAll(".ptm-dialog-foot .ptm-btn"), "确定");
  await sleep(600);

  check("译文改成自定义文字", h.editor.getCustomDesc("a girl in the rain") === "雨天里的女孩", h.editor.getCustomDesc("a girl in the rain"));
  const customEls = h.win.querySelectorAll(".ptm-manual-seg-desc.custom");
  check("分段条用绿色标记本地译文", customEls.length >= 1, String(customEls.length));

  // 后端真的存盘了
  const saved = await (await fetch("/prompt_tag/descs")).json();
  check("接口能读回自定义译文", saved.ok === true && Object.values(saved.descs || {}).includes("雨天里的女孩"), JSON.stringify(saved).slice(0, 160));

  // 批量「保存译文」：剩下的机翻一次性存到本地
  const saveBtn = Array.from(h.win.querySelectorAll(".ptm-manual-segs .ptm-btn")).find((b) =>
    (b.textContent || "").trim().includes("保存译文")
  );
  check("有机翻时有保存译文按钮", Boolean(saveBtn), "");
  if (saveBtn) {
    saveBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(900);
  }
  check("保存后机翻清空", !h.editor.getApiDesc("cinematic lighting"), h.editor.getApiDesc("cinematic lighting"));
  check("保存后能查到本地译文", Boolean(h.editor.getCustomDesc("cinematic lighting")), "空");
  const saved2 = await (await fetch("/prompt_tag/descs")).json();
  check("批量保存落到本地文件", Object.keys(saved2.descs || {}).length >= 2, JSON.stringify(saved2.descs));

  // 词库里本来就有的 tag：译文写回词库而不是自定义翻译
  const longHairLoc = h.editor.findTagLocation("long hair");
  check("能定位 tag 所在分类", Boolean(longHairLoc) && Boolean(longHairLoc.group), JSON.stringify(longHairLoc));
  h.editor.editSegmentDesc("long hair"); // 不 await：先点「取消」
  await sleep(150);
  const dlg2 = document.querySelector(".ptm-modal-backdrop .ptm-dialog");
  check("编辑词库 tag 也会弹窗", Boolean(dlg2), "弹窗没出现");
  if (dlg2) {
    clickByText(dlg2.querySelectorAll(".ptm-dialog-foot .ptm-btn"), "取消");
    await sleep(250);
  }
  check("取消编辑不会写入自定义翻译", !h.editor.getCustomDesc("long hair"), h.editor.getCustomDesc("long hair"));

  closeTagWindow(n.id);
  await sleep(150);
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("\n==================================");
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
