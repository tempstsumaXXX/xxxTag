/**
 * 词库 API：优先走后端 /prompt_tag/*；后端不可用时自动降级为浏览器本地模式。
 */

import * as ops from "./lib_ops.js";
import { SEED_LIBRARY } from "./seed_library.js";

const BASE = "/prompt_tag";
const LS_LIBS = "ptm.offline.libraries.v2";
const LS_DEFAULT = "ptm.offline.default.v2";
const LS_LAST = "ptm.last.library.v1";
const LS_CLEANUP = "ptm.data.cleaned.v1";

// 一次性清理旧版本留在浏览器里的词库缓存；插件本体不带用户词库。
// 清理后如果用户在本地模式新建/导入词库，仍会正常保存，不会每次启动都删。
try {
  if (!localStorage.getItem(LS_CLEANUP)) {
    localStorage.removeItem(LS_LIBS);
    localStorage.removeItem(LS_DEFAULT);
    localStorage.removeItem(LS_LAST);
    localStorage.setItem(LS_CLEANUP, "1");
  }
} catch (err) {
  /* localStorage 不可用时忽略 */
}

export const apiState = {
  mode: "unknown", // "server" | "disabled" | "offline"
  dataDir: "",
  error: null,
  checked: false,
  version: "",
  httpEnabled: false,
  envLocked: false,
  envVar: "PROMPT_TAG_HTTP",
};

export function isOffline() {
  return apiState.mode !== "server";
}

/** HTTP 接口是否被服务端关掉了（关掉时面板退化为浏览器本地词库） */
export function isHttpDisabled() {
  return apiState.mode === "disabled";
}

const LS_LIBS_MAX = 512 * 1024; // 本地模式词库允许占用的上限（localStorage 一共才 ~5MB）

/**
 * 清理历史遗留的浏览器本地词库缓存。
 *
 * 旧版本在「本地模式」下把词库写进 localStorage，导入稍大的词库就会长期占住几百 KB~几 MB，
 * 而 ComfyUI 的工作流自动存档也写 localStorage —— 存满就会「保存失败」。
 * 现在每次启动检查一次：服务端模式下直接删掉，本地模式下瘦身到只剩示例词库。
 */
export function cleanLegacyStorage(mode) {
  let raw = null;
  try {
    raw = localStorage.getItem(LS_LIBS);
  } catch (err) {
    return 0;
  }
  if (!raw || raw.length <= LS_LIBS_MAX) return 0;
  const freed = raw.length;
  try {
    if (mode === "server") {
      localStorage.removeItem(LS_LIBS);
      localStorage.removeItem(LS_DEFAULT);
    } else {
      writeOffline({ [SEED_LIBRARY.name]: SEED_LIBRARY });
      setDefaultName(SEED_LIBRARY.name);
    }
  } catch (err) {
    return 0;
  }
  console.warn(
    "[PromptTag] 已清理 %s KB 的浏览器本地词库缓存（它可能占满了 localStorage，进而让 ComfyUI 保存工作流失败）",
    (freed / 1024).toFixed(0)
  );
  return freed;
}

/* --------------------------------------------------------------- 请求封装 */

async function request(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(BASE + path, init);
  } catch (err) {
    throw new Error("无法连接后端接口（" + (err && err.message ? err.message : "网络错误") + "）");
  }
  if (!res.ok) throw new Error("接口返回 HTTP " + res.status);
  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error("接口返回内容不是 JSON");
  }
  if (!json.ok) throw new Error(json.error || "接口调用失败");
  return json;
}

/**
 * 探测后端状态（只探测一次）。
 * 返回 "server"（接口已开启）/ "disabled"（接口被关掉了）/ "offline"（连不上后端）
 */
export async function probe(force = false) {
  if (apiState.checked && !force) return apiState.mode;
  apiState.checked = true;
  try {
    const st = await request("GET", "/status");
    apiState.httpEnabled = Boolean(st.http_enabled);
    apiState.envLocked = Boolean(st.env_locked);
    apiState.envVar = st.env_var || "PROMPT_TAG_HTTP";
    apiState.dataDir = st.data_dir || "";
    apiState.version = st.version || "";
    apiState.mode = apiState.httpEnabled ? "server" : "disabled";
    apiState.error = null;
    apiState.freedBytes = cleanLegacyStorage(apiState.mode);
    if (apiState.mode !== "server") ensureOfflineSeeded(); // 只有本地模式才需要浏览器副本
  } catch (err) {
    // 老版本插件没有 /status，退回去试 /state
    try {
      const res = await request("GET", "/state");
      apiState.mode = "server";
      apiState.httpEnabled = true;
      apiState.dataDir = res.data_dir || "";
      apiState.version = res.version || "";
      apiState.error = null;
      apiState.freedBytes = cleanLegacyStorage("server");
      return apiState.mode;
    } catch (err2) {
      apiState.mode = "offline";
      apiState.httpEnabled = false;
      apiState.error = err && err.message ? err.message : String(err);
      apiState.freedBytes = cleanLegacyStorage("offline");
      ensureOfflineSeeded();
    }
  }
  return apiState.mode;
}

/** 手动开启 / 关闭 HTTP 接口（默认是关闭的） */
export async function switchHttp(enable) {
  const res = await request("POST", "/switch", { enable: Boolean(enable) });
  apiState.httpEnabled = Boolean(res.http_enabled);
  apiState.mode = apiState.httpEnabled ? "server" : "disabled";
  apiState.checked = true;
  if (apiState.httpEnabled) {
    apiState.dataDir = res.data_dir || apiState.dataDir;
  }
  return apiState.httpEnabled;
}

/* ------------------------------------------------------------- 本地模式 */

function readOffline() {
  try {
    const raw = localStorage.getItem(LS_LIBS);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

function writeOffline(libs) {
  let text;
  try {
    text = JSON.stringify(libs);
  } catch (err) {
    throw new Error("本地词库序列化失败：" + (err && err.message ? err.message : err));
  }
  // localStorage 一般只有 5MB；写满会让 ComfyUI 自己的工作流自动存档一起失败，
  // 所以这里主动设上限并明确报错，绝不悄无声息地撑爆。
  const LIMIT = 3 * 1024 * 1024;
  if (text.length > LIMIT) {
    throw new Error(
      "本地词库已超过 3MB，浏览器存储放不下（会连带影响 ComfyUI 的工作流自动存档）。" +
        "请点面板上方「开启 HTTP 接口」改用磁盘词库，或删掉部分本地词库后重试。"
    );
  }
  try {
    localStorage.setItem(LS_LIBS, text);
  } catch (err) {
    throw new Error(
      "浏览器存储写入失败（可能已满）：" +
        (err && err.message ? err.message : err) +
        "。建议开启 HTTP 接口改用磁盘词库。"
    );
  }
}

function ensureOfflineSeeded() {
  try {
    const libs = readOffline();
    if (libs && Object.keys(libs).length) return libs;
    const seeded = { [SEED_LIBRARY.name]: SEED_LIBRARY };
    writeOffline(seeded);
    localStorage.setItem(LS_DEFAULT, SEED_LIBRARY.name);
    return seeded;
  } catch (err) {
    return { [SEED_LIBRARY.name]: SEED_LIBRARY };
  }
}

function offlineLibraries() {
  const libs = ensureOfflineSeeded() || {};
  return Object.keys(libs)
    .sort()
    .map((name) => {
      const lib = ops.normalizeLibrary(libs[name], name);
      return {
        name,
        kind: "user",
        display_name: lib.name || name,
        counts: ops.libraryCounts(lib),
      };
    });
}

/* ----------------------------------------------------------------- 对外 */

export async function getState() {
  await probe();
  if (apiState.mode === "server") {
    const res = await request("GET", "/state");
    return { mode: "server", libraries: res.libraries || [], default: res.default, dataDir: res.data_dir || "" };
  }
  return {
    mode: apiState.mode === "disabled" ? "disabled" : "offline",
    libraries: offlineLibraries(),
    default: defaultName(),
    dataDir:
      apiState.mode === "disabled"
        ? "浏览器本地存储（HTTP 接口已关闭）"
        : "浏览器本地存储（localStorage）",
  };
}

function defaultName() {
  try {
    const libs = ensureOfflineSeeded() || {};
    const saved = localStorage.getItem(LS_DEFAULT);
    if (saved && libs[saved]) return saved;
    return Object.keys(libs)[0] || SEED_LIBRARY.name;
  } catch (err) {
    return SEED_LIBRARY.name;
  }
}

export function setDefaultName(name) {
  try {
    localStorage.setItem(LS_DEFAULT, name);
    localStorage.setItem(LS_LAST, name);
  } catch (err) {
    /* ignore */
  }
}

/** 记住最近使用的词库（新节点/配置为空时优先打开它） */
export function rememberLibrary(name) {
  if (!name) return;
  try {
    localStorage.setItem(LS_LAST, name);
  } catch (err) {
    /* ignore */
  }
}

export function getRememberedLibrary() {
  try {
    return localStorage.getItem(LS_LAST) || "";
  } catch (err) {
    return "";
  }
}

export async function loadLibrary(name) {
  await probe();
  if (apiState.mode === "server") {
    const res = await request("GET", "/library?name=" + encodeURIComponent(name || ""));
    return { name: res.name, kind: res.kind, data: ops.normalizeLibrary(res.data, res.name) };
  }
  const libs = ensureOfflineSeeded() || {};
  const key = name && libs[name] ? name : defaultName();
  return { name: key, kind: "user", data: ops.normalizeLibrary(libs[key], key) };
}

export async function saveLibrary(name, data) {
  await probe();
  const safe = ops.sanitizeName(name);
  if (apiState.mode === "server") {
    const res = await request("POST", "/library/save", { name: safe, data });
    return { name: res.name, libraries: res.libraries || [] };
  }
  const libs = ensureOfflineSeeded() || {};
  if (libs[safe]) delete libs[safe];
  libs[safe] = ops.normalizeLibrary(data, safe);
  libs[safe].name = safe;
  writeOffline(libs);
  setDefaultName(safe);
  return { name: safe, libraries: offlineLibraries() };
}

export async function deleteLibrary(name) {
  await probe();
  if (apiState.mode === "server") {
    const res = await request("POST", "/library/delete", { name });
    return { libraries: res.libraries || [] };
  }
  const libs = ensureOfflineSeeded() || {};
  if (!libs[name]) throw new Error("词库不存在：" + name);
  delete libs[name];
  writeOffline(libs);
  return { libraries: offlineLibraries() };
}

export async function renameLibrary(name, newName) {
  await probe();
  const safe = ops.sanitizeName(newName);
  if (apiState.mode === "server") {
    const res = await request("POST", "/library/rename", { name, new_name: safe });
    return { name: res.name, libraries: res.libraries || [] };
  }
  const libs = ensureOfflineSeeded() || {};
  if (!libs[name]) throw new Error("词库不存在：" + name);
  if (libs[safe]) throw new Error("已存在同名词库：" + safe);
  const data = ops.normalizeLibrary(libs[name], safe);
  data.name = safe;
  delete libs[name];
  libs[safe] = data;
  writeOffline(libs);
  return { name: safe, libraries: offlineLibraries() };
}

/**
 * 批量导入
 * @param {{name?:string, text:string, filename?:string, mode:"replace"|"merge"|"new", newName?:string}} payload
 */
export async function importContent(payload) {
  await probe();
  const mode = payload.mode || "replace";
  if (apiState.mode === "server") {
    const res = await request("POST", "/import", {
      name: payload.name,
      text: payload.text,
      filename: payload.filename || "",
      mode,
      new_name: payload.newName || null,
    });
    return {
      name: res.library,
      kind: res.kind || "user",
      data: ops.normalizeLibrary(res.data, res.library),
      counts: res.counts,
      imported: res.imported,
      libraries: res.libraries || [],
    };
  }

  const incoming = ops.parseText(payload.text, payload.filename || "", payload.newName || payload.name);
  const counts = ops.libraryCounts(incoming);
  if (!counts.tags) throw new Error("没有解析到任何 tag，请检查文件内容");

  if (mode === "new") {
    const target = ops.sanitizeName(payload.newName || incoming.name || "导入词库");
    await saveLibrary(target, incoming);
    return { name: target, kind: "user", data: ops.normalizeLibrary(incoming, target), counts, imported: counts, libraries: offlineLibraries() };
  }

  const target = payload.name || defaultName();
  const libs = ensureOfflineSeeded() || {};
  const base = libs[target] ? ops.normalizeLibrary(libs[target], target) : ops.emptyLibrary(target);
  const result = mode === "merge" ? ops.mergeLibrary(base, incoming) : ops.normalizeLibrary(incoming, target);
  result.name = target;
  await saveLibrary(target, result);
  return {
    name: target,
    kind: "user",
    data: result,
    counts: ops.libraryCounts(result),
    imported: counts,
    libraries: offlineLibraries(),
  };
}

/**
 * 从服务器本地路径导入（大文件推荐：完全不经过浏览器上传/下载）
 * @param {{path:string, name?:string, mode?:string, newName?:string, split?:number}} payload
 */
export async function importPath(payload) {
  await probe();
  if (apiState.mode !== "server") {
    throw new Error("本地模式不支持路径导入，请先确认后端接口可用");
  }
  const res = await request("POST", "/import_path", {
    path: payload.path,
    name: payload.name,
    mode: payload.mode || "new",
    new_name: payload.newName || null,
    split: Number(payload.split) || 0,
  });
  const splitList = res.split ? res.libraries || [] : [];
  return {
    split: Boolean(res.split),
    libraries: splitList,
    counts: res.counts,
    imported: res.imported,
    name: res.library || (splitList[0] && splitList[0].name) || "",
    kind: res.kind || "user",
    data: res.data ? ops.normalizeLibrary(res.data, res.library || (splitList[0] && splitList[0].name)) : null,
    libraryList: res.libraries || [],
  };
}

/* ------------------------------------------------------- 自定义翻译（本地） */

export async function getCustomDescs() {
  await probe();
  requireServer("自定义翻译");
  const res = await request("GET", "/descs");
  return res.descs || {};
}

export async function saveCustomDesc(text, desc) {
  await probe();
  requireServer("自定义翻译");
  const res = await request("POST", "/descs", { text, desc: desc || "" });
  return res.descs || {};
}

export async function saveCustomDescs(descs, remove) {
  await probe();
  requireServer("自定义翻译");
  const res = await request("POST", "/descs", { descs: descs || {}, remove: remove || [] });
  return res.descs || {};
}

/* ---------------------------------------------------------------- 翻译 */

function requireServer(what) {
  if (apiState.mode !== "server") {
    throw new Error(what + "需要开启 HTTP 接口（面板顶部提示条里可以打开）");
  }
}

export async function getTranslateSettings() {
  await probe();
  requireServer("翻译");
  const res = await request("GET", "/translate/settings");
  return res.settings || {};
}

export async function saveTranslateSettings(settings) {
  await probe();
  requireServer("翻译");
  const res = await request("POST", "/translate/settings", { settings: settings || {} });
  return res.settings || {};
}

export async function translateTexts(texts, settings) {
  await probe();
  requireServer("翻译");
  return await request("POST", "/translate", { texts: texts || [], settings: settings || null });
}

export async function testTranslate(settings) {
  await probe();
  requireServer("翻译");
  return await request("POST", "/translate/test", { settings: settings || null });
}

export async function clearTranslateCache() {
  await probe();
  requireServer("翻译");
  return await request("POST", "/translate/clear", {});
}

export async function exportContent(payload) {
  await probe();
  const fmt = payload.format || "json";
  if (apiState.mode === "server") {
    const res = await request("POST", "/export", {
      data: payload.data,
      format: fmt,
      group: payload.group || null,
      sub: payload.sub || null,
    });
    return { filename: res.filename, content: res.content };
  }
  const subset = ops.exportSubset(payload.data, payload.group || null, payload.sub || null);
  return ops.exportLibrary(subset, fmt);
}

/**
 * 提示词预览（含随机抽样）。后端可用时用后端（与节点输出完全一致），
 * 否则用本地近似算法。
 */
export async function previewPrompt(payload) {
  await probe();
  const opts = {
    separator: payload.separator,
    dedupe: payload.dedupe,
    underscoreToSpace: payload.underscoreToSpace,
    weightStyle: payload.weightStyle,
  };
  if (apiState.mode === "server") {
    const res = await request("POST", "/preview", {
      config: payload.config,
      seed: payload.seed || 0,
      separator: payload.separator,
      dedupe: payload.dedupe !== false,
      underscore_to_space: payload.underscoreToSpace !== false,
      weight_style: payload.weightStyle,
    });
    return { prompt: res.prompt, tags: res.tags || [], count: res.count || 0, exact: true };
  }
  const items = typeof payload.config === "string" ? (JSON.parse(payload.config || "{}").items || []) : (payload.config.items || []);
  const out = ops.randomPreview(items, opts, payload.seed || 0);
  return { prompt: out.text, tags: out.tags, count: out.tags.length, exact: false };
}

export { ops };
