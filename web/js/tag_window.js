/**
 * 可拖拽 / 可缩放的浮动面板（把 TagEditor 装进去）。
 * 每个节点一个窗口，窗口位置与大小记在 localStorage。
 */

import { h, clear } from "./dom.js";
import { TagEditor } from "./tag_editor.js";


const RECT_KEY = "ptm.window.rect.v2";
const DEFAULTS = { width: 1000, height: 680 };

const openWindows = new Map();
let zTop = 2147482800;

function readRect() {
  try {
    const raw = localStorage.getItem(RECT_KEY);
    if (!raw) return { ...DEFAULTS };
    const r = JSON.parse(raw);
    if (!r || typeof r !== "object") return { ...DEFAULTS };
    return {
      width: Math.max(620, Number(r.width) || DEFAULTS.width),
      height: Math.max(380, Number(r.height) || DEFAULTS.height),
    };
  } catch (err) {
    return { ...DEFAULTS };
  }
}

function saveRect(win) {
  try {
    const rect = win.getBoundingClientRect();
    localStorage.setItem(
      RECT_KEY,
      JSON.stringify({ width: Math.round(rect.width), height: Math.round(rect.height) })
    );
  } catch (err) {
    /* ignore */
  }
}

function clampToViewport(win, left, top) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = win.offsetWidth;
  const hgt = win.offsetHeight;
  const minVisible = 60;
  const x = Math.min(Math.max(left, -(w - minVisible)), vw - minVisible);
  const y = Math.min(Math.max(top, 0), vh - minVisible);
  win.style.left = Math.round(x) + "px";
  win.style.top = Math.round(y) + "px";
  return { left: x, top: y };
}

function makeDraggable(win, handle) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origTop = 0;

  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    if (ev.target.closest("button, input, select, textarea")) return;
    const rect = win.getBoundingClientRect();
    dragging = true;
    startX = ev.clientX;
    startY = ev.clientY;
    origLeft = rect.left;
    origTop = rect.top;
    handle.setPointerCapture(ev.pointerId);
    document.body.style.userSelect = "none";
    ev.preventDefault();
  });

  handle.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    clampToViewport(win, origLeft + (ev.clientX - startX), origTop + (ev.clientY - startY));
  });

  const end = (ev) => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = "";
    try {
      handle.releasePointerCapture(ev.pointerId);
    } catch (err) {
      /* ignore */
    }
    saveRect(win);
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function bringToFront(win) {
  zTop += 1;
  win.style.zIndex = String(zTop);
}

/**
 * 打开（或聚焦）某个节点的 TAG 面板
 * @param {{nodeId:string|number, title?:string, config?:object, host?:object, onClose?:Function}} opts
 */
export function openTagWindow(opts = {}) {
  const nodeId = String(opts.nodeId);
  const existing = openWindows.get(nodeId);
  if (existing) {
    bringToFront(existing.win);
    existing.win.style.display = "flex";
    if (opts.config) existing.editor.setConfig(opts.config);
    return existing;
  }

  const container = h("div", { class: "ptm-window-body", style: { padding: "0" } });
  const titleText = opts.title || "TAG 词库面板";
  const closeBtn = h("button", { class: "ptm-btn ghost icon", title: "关闭（不丢失已选 tag）" }, "✕");
  const head = h(
    "div",
    { class: "ptm-window-head" },
    h("span", { class: "ptm-window-title" }, "🏷 " + titleText),
    h("span", { class: "ptm-grow" }),
    closeBtn
  );

  const win = h("div", { class: "ptm-window" }, head, container);
  const rect = readRect();
  win.style.width = rect.width + "px";
  win.style.height = rect.height + "px";

  // 初次打开居中偏上
  const rectNow = { width: rect.width, height: rect.height };
  const left = Math.max(10, (window.innerWidth - rectNow.width) / 2);
  const top = Math.max(10, (window.innerHeight - rectNow.height) / 2.4);
  win.style.left = Math.round(left) + "px";
  win.style.top = Math.round(top) + "px";

  document.body.appendChild(win);
  bringToFront(win);
  makeDraggable(win, head);

  win.addEventListener("pointerdown", () => bringToFront(win), true);
  win.addEventListener("mouseup", () => saveRect(win));

  const editor = new TagEditor(opts.host || {});
  editor.mount(container);
  if (opts.config) editor.setConfig(opts.config);

  const handle = {
    win,
    editor,
    close() {
      editor.unmount();
      clear(container);
      win.remove();
      openWindows.delete(nodeId);
      if (opts.onClose) opts.onClose();
      document.removeEventListener("keydown", onKey);
    },
  };

  function onKey(ev) {
    if (ev.key === "Escape" && win.style.display !== "none") {
      // 只在没有别的弹窗时关闭
      if (!document.querySelector(".ptm-modal-backdrop")) {
        ev.stopPropagation();
      }
    }
  }
  document.addEventListener("keydown", onKey);

  closeBtn.addEventListener("click", () => handle.close());
  openWindows.set(nodeId, handle);
  return handle;
}

export function closeTagWindow(nodeId) {
  const handle = openWindows.get(String(nodeId));
  if (handle) handle.close();
}

export function closeAllTagWindows() {
  for (const id of Array.from(openWindows.keys())) closeTagWindow(id);
}

export function getTagWindow(nodeId) {
  return openWindows.get(String(nodeId)) || null;
}

/** 所有打开着的 TAG 面板（提示词历史导入词库后，用来刷新正在看的面板） */
export function getOpenTagWindows() {
  return Array.from(openWindows.values());
}
