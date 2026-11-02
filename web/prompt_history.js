/**
 * ComfyUI Prompt History —— 前端入口
 *
 * 职责：
 * 1. 提供「提示词历史」独立窗口（不再占用 ComfyUI 侧边栏），入口挂在顶部菜单 /
 *    「提示词选择器」节点的按钮上；
 * 2. 监听执行事件，自动刷新列表（新提交的提示词、刚生成的图片）；
 * 3. 在工作流加载时回填当前选中项。
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

import { initPanel, refresh, syncNodesFromSelection } from "./js/ph_panel.js";
import { NODE_TYPE, applySelectionToNodes } from "./js/ph_inject.js";
import { MERGE_NODE_TYPE, nodeTypeOf, setupMergeNode } from "./js/ph_merge.js";
import { state } from "./js/ph_state.js";
import { makeScheduler } from "./js/ph_util.js";
import { openHistoryWindow, toggleHistoryWindow } from "./js/ph_window.js";

/* ------------------------------------------------------------------ 样式 */

function injectStyles() {
  const href = new URL("./css/prompt_history.css", import.meta.url).href;
  const existing = document.querySelector('link[data-ph-style="1"]');
  if (existing) {
    if (existing.href !== href) existing.href = href;
    return;
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.phStyle = "1";
  document.head.appendChild(link);
}

/* ------------------------------------------------------------------ 入口：顶栏按钮 + 菜单命令 */

const TOPBAR_BTN_CLASS = "ph-topbar-btn";
const MENU_BTN_CLASS = "ph-menubar-btn";
const LEGACY_MENU_CLASS = "ph-menu-item";
const COMMAND_ID = "PromptHistory.OpenWindow";

function makeEntryButton(className, text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.title = "打开提示词历史窗口（独立窗口，可拖动 / 缩放）";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleHistoryWindow();
  });
  return button;
}

/** 新版前端（1.5x）：顶栏右侧动作区（新建工作流 / 运行 / 队列 那一排） */
function installTopBarButton() {
  if (document.querySelector(`.${TOPBAR_BTN_CLASS}`)) return true;
  const host = document.querySelector('[data-testid="integrated-tab-bar-actions"]');
  if (!host) return false;
  host.insertBefore(makeEntryButton(TOPBAR_BTN_CLASS, "提示词历史"), host.firstChild);
  return true;
}

/** 中间版本新前端：.comfyui-menu 顶栏 */
function installMenuBarButton() {
  if (document.querySelector(`.${MENU_BTN_CLASS}`)) return true;
  const nav = document.querySelector(".comfyui-menu");
  if (!nav) return false;
  const rightSide = nav.querySelector(".comfyui-menu-right");
  const button = makeEntryButton(MENU_BTN_CLASS, "提示词历史");
  if (rightSide) rightSide.insertBefore(button, rightSide.firstChild);
  else nav.appendChild(button);
  return true;
}

/** 老前端：主菜单里加一项 */
function installLegacyMenuItem() {
  const menu = app && app.ui && app.ui.menuContainer;
  if (!menu) return false;
  if (menu.querySelector(`.${LEGACY_MENU_CLASS}`)) return true;
  menu.appendChild(makeEntryButton(LEGACY_MENU_CLASS, "提示词历史"));
  return true;
}

function ensureEntries() {
  return installTopBarButton() || installMenuBarButton() || installLegacyMenuItem();
}

function installEntries() {
  let tries = 0;
  const attempt = () => {
    if (ensureEntries()) {
      // 顶栏会随工作流重绘，按钮被冲掉时补回来（每秒查两次，开销可以忽略）
      window.setInterval(ensureEntries, 2000);
      return;
    }
    tries += 1;
    // 顶栏可能比扩展晚渲染，最多重试 10 秒
    if (tries < 40) setTimeout(attempt, 250);
  };
  attempt();
}

/* ------------------------------------------------------------------ 事件驱动的刷新 */

const scheduleRefresh = makeScheduler(() => refresh(false), 400);

const EVENT_DELAYS = {
  execution_start: 500,
  executed: 350,
  execution_success: 500,
  execution_error: 500,
  execution_interrupted: 500,
  status: 900,
};

/* ------------------------------------------------------------------ 注册扩展 */

app.registerExtension({
  name: "PromptTagManager.HistoryPanel",

  commands: [
    {
      id: COMMAND_ID,
      label: "提示词历史：打开窗口",
      icon: "pi pi-history",
      function: () => openHistoryWindow(),
    },
  ],

  // 新版前端的菜单栏 / 命令面板（Ctrl+K）也能找到
  menuCommands: [{ path: ["提示词历史"], commands: [COMMAND_ID] }],

  async setup() {
    initPanel(app);
    injectStyles();
    installEntries();

    for (const [eventName, delay] of Object.entries(EVENT_DELAYS)) {
      api.addEventListener(eventName, () => {
        scheduleRefresh(delay);
        if (eventName === "executed" || eventName === "execution_success") {
          // 后端是异步复制出图的，稍后再拉一次，保证图文模式下能看到图
          setTimeout(() => refresh(false), 1500);
        }
      });
    }

    refresh(false).then(() => syncNodesFromSelection());
  },

  nodeCreated(node) {
    if (!node) return;
    const type = nodeTypeOf(node);
    if (type === MERGE_NODE_TYPE) setupMergeNode(node);
    if (type !== NODE_TYPE) return;
    addPanelButton(node);
  },

  loadedGraphNode(node) {
    if (!node) return;
    const type = nodeTypeOf(node);
    if (type === MERGE_NODE_TYPE) {
      setupMergeNode(node);
      return;
    }
    if (type !== NODE_TYPE) return;
    addPanelButton(node);
    if (!state.settings.inject_enabled) return;
    const entry = state.selectedId
      ? state.entries.find((item) => item.id === state.selectedId) || null
      : null;
    // 载入工作流时只回填自己的选择器，不覆盖 PromptTagManager 里手写的提示词框
    if (entry) applySelectionToNodes(app, entry, { tagNodes: false });
  },
});

/* ------------------------------------------------------------------ 节点：打开窗口 */

function addPanelButton(node) {
  if (!node || node.__phPanelButton) return;
  node.__phPanelButton = true;
  try {
    const widget = node.addWidget("button", "📋 打开历史Tag生成面板", null, () => {
      openHistoryWindow();
    });
    if (widget) {
      widget.serialize = false;
      widget.options = { ...(widget.options || {}), serialize: false };
    }
    if (typeof node.computeSize === "function" && Array.isArray(node.size)) {
      const size = node.computeSize();
      if (Array.isArray(size) && Number.isFinite(size[1]) && typeof node.setSize === "function") {
        node.setSize([node.size[0], Math.max(size[1], node.size[1])]);
      }
    }
    if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
  } catch (err) {
    console.warn("[PromptHistory] 给节点加按钮失败：", err);
  }
}
