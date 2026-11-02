/**
 * 提示词历史 → TAG 词库。
 *
 * 每条历史记录右侧的「导入词库」会弹出一个小窗口：选词库、一级 / 二级分类、
 * 是拆成一个个 tag 还是整条存进去，然后写进词库文件（有 HTTP 接口时落盘，
 * 关掉接口时写浏览器本地词库）。
 */

import { el, button, iconButton, toast } from "./ph_util.js";
import {
  getState,
  loadLibrary,
  saveLibrary,
  rememberLibrary,
  getRememberedLibrary,
} from "./tag_api.js";
import { getOpenTagWindows } from "./tag_window.js";

const SPLIT_RE = /[\n\r,，、;；]+/;
const DEFAULT_GROUP = "提示词历史";
const DEFAULT_SUB = "导入";

/** 把一条提示词拆成 tag：按逗号 / 换行 / 顿号 / 分号切，去掉空白与空段 */
export function splitPromptTags(text) {
  return String(text || "")
    .split(SPLIT_RE)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 把若干条内容并进词库的「一级 / 二级分类」，返回实际新增条数（已存在的跳过） */
export function mergeIntoLibrary(library, groupName, subName, items) {
  if (!library || typeof library !== "object") return 0;
  if (!Array.isArray(library.groups)) library.groups = [];

  let group = library.groups.find((item) => item && item.name === groupName);
  if (!group) {
    group = { name: groupName, subs: [] };
    library.groups.push(group);
  }
  if (!Array.isArray(group.subs)) group.subs = [];

  let sub = group.subs.find((item) => item && item.name === subName);
  if (!sub) {
    sub = { name: subName, tags: [], descs: {} };
    group.subs.push(sub);
  }
  if (!Array.isArray(sub.tags)) sub.tags = [];
  if (!sub.descs || typeof sub.descs !== "object") sub.descs = {};

  const seen = new Set(sub.tags.map((tag) => String(tag).trim().toLowerCase()));
  let added = 0;
  for (const raw of items || []) {
    const text = String(raw || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sub.tags.push(text);
    added += 1;
  }
  return added;
}

/** 导入后刷新正在看的 TAG 面板：只刷新打开着、且正看着同一个词库的那种 */
function refreshOpenTagPanels(libraryName) {
  if (!libraryName) return;
  for (const win of getOpenTagWindows()) {
    try {
      const editor = win && win.editor;
      if (!editor || !editor.state) continue;
      if (editor.state.libraryName !== libraryName) continue;
      if (typeof editor.switchLibrary !== "function") continue;
      editor.switchLibrary(libraryName, { silent: true }).catch(() => {});
    } catch (err) {
      /* 面板刷新失败不影响导入结果 */
    }
  }
}

function field(labelText, control, hintText) {
  const wrap = el("label", "ph-field");
  wrap.appendChild(el("span", "ph-field-label", labelText));
  wrap.appendChild(control);
  if (hintText) wrap.appendChild(el("span", "ph-field-hint", hintText));
  return wrap;
}

function makeInput(value, placeholder) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "ph-input";
  input.value = value || "";
  if (placeholder) input.placeholder = placeholder;
  return input;
}

function makeSelect(options, value) {
  const select = document.createElement("select");
  select.className = "ph-select";
  for (const item of options) {
    const opt = document.createElement("option");
    opt.value = item.value;
    opt.textContent = item.label;
    select.appendChild(opt);
  }
  if (value) select.value = value;
  return select;
}

/**
 * 打开「导入到词库」对话框。
 * @param {{positive?:string}} entry 历史记录
 */
export async function openLibraryImportDialog(entry) {
  const text = String((entry && entry.positive) || "");
  if (!text.trim()) {
    toast("这条提示词是空的", "warn");
    return;
  }

  let state = null;
  try {
    state = await getState();
  } catch (err) {
    toast("读取词库列表失败：" + (err && err.message ? err.message : err), "error");
    return;
  }
  const libraries = (state && state.libraries) || [];
  if (!libraries.length) {
    toast("还没有可用的词库：先打开「Tag词库面板」新建一个", "warn");
    return;
  }

  // 默认词库：正在看的 TAG 面板 → 上次用的词库 → 服务端默认
  const openLib = getOpenTagWindows()
    .map((win) => win && win.editor && win.editor.state && win.editor.state.libraryName)
    .find(Boolean);
  const preferred = [openLib, getRememberedLibrary(), state && state.default]
    .filter(Boolean)
    .find((name) => libraries.some((lib) => lib.name === name));
  const defaultLib = preferred || libraries[0].name;

  const layer = el("div", "ph-modal-backdrop");
  const panel = el("div", "ph-modal");
  const head = el("div", "ph-modal-head");
  head.appendChild(el("span", "ph-modal-title", "导入到词库"));
  head.appendChild(iconButton("✕", "关闭", () => close()));
  panel.appendChild(head);

  const body = el("div", "ph-modal-body");
  const libSelect = makeSelect(
    libraries.map((lib) => ({
      value: lib.name,
      label: lib.display_name && lib.display_name !== lib.name ? `${lib.display_name}（${lib.name}）` : lib.name,
    })),
    defaultLib
  );
  body.appendChild(field("词库", libSelect));

  const groupInput = makeInput(DEFAULT_GROUP, "一级分类");
  const subInput = makeInput(DEFAULT_SUB, "二级分类");
  body.appendChild(field("一级分类", groupInput));
  body.appendChild(field("二级分类", subInput));

  const modeSelect = makeSelect(
    [
      { value: "whole", label: "整条提示词作为一条" },
      { value: "split", label: "按逗号 / 换行拆成一个个 tag" },
    ],
    "whole"
  );
  body.appendChild(field("导入方式", modeSelect));

  const preview = el("div", "ph-modal-preview", text.length > 240 ? text.slice(0, 240) + "…" : text);
  preview.title = text;
  body.appendChild(preview);

  const hint = el("div", "ph-modal-hint");
  body.appendChild(hint);

  const updateHint = () => {
    const items = modeSelect.value === "split" ? splitPromptTags(text) : [text.trim()].filter(Boolean);
    const group = groupInput.value.trim() || "?";
    const sub = subInput.value.trim() || "?";
    hint.textContent = `将写入 ${items.length} 条到「${group} / ${sub}」，词库里已有的会自动跳过`;
  };
  modeSelect.addEventListener("change", updateHint);
  groupInput.addEventListener("input", updateHint);
  subInput.addEventListener("input", updateHint);
  updateHint();

  const actions = el("div", "ph-modal-actions");
  const cancelBtn = button("取消", "ph-btn-ghost", () => close());
  const confirmBtn = button("导入", "ph-btn-primary", () => submit());
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  panel.appendChild(body);
  panel.appendChild(actions);
  layer.appendChild(panel);
  document.body.appendChild(layer);

  function onKey(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    } else if (event.key === "Enter" && event.target !== cancelBtn) {
      event.preventDefault();
      submit();
    }
  }
  document.addEventListener("keydown", onKey, true);
  libSelect.focus();

  function close() {
    document.removeEventListener("keydown", onKey, true);
    layer.remove();
  }

  layer.addEventListener("pointerdown", (event) => {
    if (event.target === layer) close();
  });

  let busy = false;
  async function submit() {
    if (busy) return;
    const library = libSelect.value;
    const groupName = groupInput.value.trim();
    const subName = subInput.value.trim();
    if (!groupName || !subName) {
      toast("一级 / 二级分类不能为空", "warn");
      return;
    }
    const items = modeSelect.value === "split" ? splitPromptTags(text) : [text.trim()].filter(Boolean);
    if (!items.length) {
      toast("没有可导入的内容", "warn");
      return;
    }

    busy = true;
    confirmBtn.disabled = true;
    confirmBtn.textContent = "导入中…";
    try {
      const loaded = await loadLibrary(library);
      const data = loaded.data;
      const added = mergeIntoLibrary(data, groupName, subName, items);
      if (!added) {
        toast("这些内容词库里已经有了，没有新增", "warn");
        close();
        return;
      }
      await saveLibrary(loaded.name || library, data);
      rememberLibrary(loaded.name || library);
      refreshOpenTagPanels(loaded.name || library);
      toast(
        `已导入 ${added} 条到「${loaded.name || library} / ${groupName} / ${subName}」`,
        "success"
      );
      close();
    } catch (err) {
      toast("导入失败：" + (err && err.message ? err.message : err), "error");
    } finally {
      busy = false;
      confirmBtn.disabled = false;
      confirmBtn.textContent = "导入";
    }
  }
}
