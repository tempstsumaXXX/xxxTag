/**
 * 提示词历史 —— 独立浮动窗口
 *
 * 不再占用 ComfyUI 的侧边栏：点节点上的「📋 打开历史Tag生成面板」或顶部菜单的「提示词历史」
 * 都会弹出这个窗口。窗口可以拖动、缩放，位置与大小记在 localStorage，关掉再开还是原样。
 */

import { mountPanel, refresh } from "./ph_panel.js";
import { el, iconButton } from "./ph_util.js";

const RECT_KEY = "ph.window.rect.v1";
const DEFAULT_SIZE = { width: 860, height: 780 };
const MIN_WIDTH = 460;
const MIN_HEIGHT = 340;
const EDGE = 8;
const MIN_VISIBLE = 80;
const Z_BASE = 26000;

let zTop = Z_BASE;
let win = null;
let head = null;
let body = null;
let headHost = null;
let collapsed = false;
// 收起时窗口高度是 auto，记一份展开时的矩形，拖位置 / 再展开都用它
let lastRect = null;

/* ------------------------------------------------------------------ 尺寸 / 位置 */

function viewport() {
  const width = Number(window.innerWidth) || 1280;
  const height = Number(window.innerHeight) || 800;
  return { width, height };
}

function defaultRect() {
  const vp = viewport();
  const width = Math.max(MIN_WIDTH, Math.min(DEFAULT_SIZE.width, vp.width - 2 * EDGE));
  const height = Math.max(MIN_HEIGHT, Math.min(DEFAULT_SIZE.height, vp.height - 2 * EDGE));
  return {
    width,
    height,
    left: Math.max(EDGE, (vp.width - width) / 2),
    top: Math.max(EDGE, (vp.height - height) / 2.4),
  };
}

/** 保证窗口至少有一小块留在视口里，不会被拖丢 */
function clampPosition(left, top, width, height) {
  const vp = viewport();
  const maxLeft = Math.max(0, vp.width - MIN_VISIBLE);
  const maxTop = Math.max(0, vp.height - MIN_VISIBLE);
  const x = Math.min(Math.max(Number(left) || 0, MIN_VISIBLE - width), maxLeft);
  const y = Math.min(Math.max(Number(top) || 0, 0), maxTop);
  return { width, height, left: x, top: y };
}

function readRect() {
  const fallback = defaultRect();
  let saved = null;
  try {
    saved = JSON.parse(window.localStorage.getItem(RECT_KEY) || "null");
  } catch (err) {
    saved = null;
  }
  if (!saved || typeof saved !== "object") return fallback;
  const vp = viewport();
  const width = Math.max(
    MIN_WIDTH,
    Math.min(Number(saved.width) || fallback.width, Math.max(MIN_WIDTH, vp.width - 2 * EDGE))
  );
  const height = Math.max(
    MIN_HEIGHT,
    Math.min(Number(saved.height) || fallback.height, Math.max(MIN_HEIGHT, vp.height - 2 * EDGE))
  );
  const left = Number.isFinite(Number(saved.left)) ? Number(saved.left) : fallback.left;
  const top = Number.isFinite(Number(saved.top)) ? Number(saved.top) : fallback.top;
  return clampPosition(left, top, width, height);
}

function applyRect(rect) {
  if (!win) return;
  lastRect = { ...rect };
  win.style.width = `${Math.round(rect.width)}px`;
  win.style.height = `${Math.round(rect.height)}px`;
  win.style.left = `${Math.round(rect.left)}px`;
  win.style.top = `${Math.round(rect.top)}px`;
}

function saveRect() {
  if (!win) return;
  const live = win.getBoundingClientRect();
  if (!live.width || !live.height) return;
  if (!collapsed) {
    lastRect = { width: live.width, height: live.height, left: live.left, top: live.top };
  } else if (lastRect) {
    // 收起状态：高度是 auto，只更新位置
    lastRect = { ...lastRect, left: live.left, top: live.top };
  } else {
    lastRect = { width: live.width, height: live.height, left: live.left, top: live.top };
  }
  try {
    window.localStorage.setItem(
      RECT_KEY,
      JSON.stringify({
        width: Math.round(lastRect.width),
        height: Math.round(lastRect.height),
        left: Math.round(lastRect.left),
        top: Math.round(lastRect.top),
      })
    );
  } catch (err) {
    /* 隐私模式 / 存储写满：位置记不住不影响使用 */
  }
}

function bringToFront() {
  if (!win) return;
  zTop += 1;
  win.style.zIndex = String(zTop);
}

/* ------------------------------------------------------------------ 拖动 / 缩放 */

function makeDraggable(handle) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("button, a, input, select, textarea, [data-no-drag]")) {
      return;
    }
    const rect = win.getBoundingClientRect();
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    originLeft = rect.left;
    originTop = rect.top;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch (err) {
      /* ignore */
    }
    document.body.style.userSelect = "none";
    win.classList.add("is-dragging");
    event.preventDefault();
  });

  handle.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const next = clampPosition(
      originLeft + (event.clientX - startX),
      originTop + (event.clientY - startY),
      win.offsetWidth,
      win.offsetHeight
    );
    win.style.left = `${Math.round(next.left)}px`;
    win.style.top = `${Math.round(next.top)}px`;
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = "";
    win.classList.remove("is-dragging");
    saveRect();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function startResize(event, grip, direction) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  bringToFront();

  const rect = win.getBoundingClientRect();
  const vp = viewport();
  const startX = event.clientX;
  const startY = event.clientY;
  const startWidth = rect.width;
  const startHeight = rect.height;
  let resizing = true;

  try {
    grip.setPointerCapture(event.pointerId);
  } catch (err) {
    /* ignore */
  }
  document.body.style.userSelect = "none";
  win.classList.add("is-resizing");

  const move = (ev) => {
    if (!resizing) return;
    let width = startWidth;
    let height = startHeight;
    if (direction.includes("e")) width = startWidth + (ev.clientX - startX);
    if (direction.includes("s")) height = startHeight + (ev.clientY - startY);
    width = Math.max(MIN_WIDTH, Math.min(width, vp.width - rect.left - EDGE));
    height = Math.max(MIN_HEIGHT, Math.min(height, vp.height - rect.top - EDGE));
    win.style.width = `${Math.round(width)}px`;
    win.style.height = `${Math.round(height)}px`;
  };

  const end = () => {
    if (!resizing) return;
    resizing = false;
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", end);
    grip.removeEventListener("pointercancel", end);
    document.body.style.userSelect = "";
    win.classList.remove("is-resizing");
    saveRect();
  };

  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
}

function makeResizers() {
  for (const direction of ["e", "s", "se"]) {
    const grip = el("div", `ph-win-resize ph-win-resize-${direction}`);
    grip.title = "拖动调整窗口大小";
    grip.addEventListener("pointerdown", (event) => startResize(event, grip, direction));
    win.appendChild(grip);
  }
}

/* ------------------------------------------------------------------ 折叠 / 开关 */

function updateCollapseButton() {
  if (!head) return;
  const button = head.querySelector(".ph-win-collapse");
  if (!button) return;
  button.textContent = collapsed ? "▢" : "–";
  button.title = collapsed ? "展开窗口" : "收起窗口（只留标题栏）";
  button.setAttribute("aria-label", button.title);
}

function setCollapsed(next) {
  if (!win) return;
  const wasCollapsed = collapsed;
  collapsed = !!next;
  win.classList.toggle("is-collapsed", collapsed);
  updateCollapseButton();
  if (wasCollapsed && !collapsed) {
    // 展开后把高度还回来（优先用内存里的矩形，存储不可用时也不会跳回默认位置）
    applyRect(lastRect || readRect());
  }
}

/* ------------------------------------------------------------------ 构建窗口 */

function buildWindow() {
  win = el("div", "ph-window");
  win.setAttribute("role", "dialog");
  win.setAttribute("aria-label", "提示词历史");
  win.dataset.phWindow = "1";

  head = el("div", "ph-win-head");
  headHost = el("div", "ph-win-headhost");
  head.appendChild(headHost);

  const actions = el("div", "ph-win-actions");
  const collapseBtn = iconButton("–", "收起窗口（只留标题栏）", () => setCollapsed(!collapsed), "ph-win-collapse");
  actions.appendChild(collapseBtn);
  actions.appendChild(
    iconButton("✕", "关闭窗口（记录不会丢，随时可以再打开）", () => closeHistoryWindow(), "ph-win-close")
  );
  head.appendChild(actions);

  body = el("div", "ph-win-body");
  win.appendChild(head);
  win.appendChild(body);
  document.body.appendChild(win);

  // 面板自带的标题行（标题 / 条数 / 导入导出 / 刷新）搬进窗口标题栏，避免出现两行标题
  mountPanel(body, { headHost });

  makeDraggable(head);
  makeResizers();
  win.addEventListener("pointerdown", () => bringToFront(), true);
}

/* ------------------------------------------------------------------ 对外接口 */

export function isHistoryWindowOpen() {
  return !!win && win.style.display !== "none";
}

export function openHistoryWindow() {
  if (!win) buildWindow();
  win.style.display = "flex";
  applyRect(readRect());
  if (collapsed) setCollapsed(false);
  bringToFront();
  refresh(false);
  return win;
}

export function closeHistoryWindow() {
  if (!win) return;
  saveRect();
  win.style.display = "none";
}

export function toggleHistoryWindow() {
  if (isHistoryWindowOpen()) closeHistoryWindow();
  else openHistoryWindow();
}

if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    if (!win || win.style.display === "none" || collapsed) return;
    const rect = win.getBoundingClientRect();
    const next = clampPosition(rect.left, rect.top, rect.width, rect.height);
    if (Math.round(next.left) !== Math.round(rect.left) || Math.round(next.top) !== Math.round(rect.top)) {
      win.style.left = `${Math.round(next.left)}px`;
      win.style.top = `${Math.round(next.top)}px`;
    }
  });
}
