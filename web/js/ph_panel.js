/** 提示词历史面板：文字 / 图文两种模式，删除、批量删除、复制、手动添加、选中注入。 */

import { phApi, mediaURL } from "./ph_api.js";
import { state, applyState, getEntry, filteredEntries, pageCount, visibleEntries, clampPage, PAGE_SIZES } from "./ph_state.js";
import { el, clearNode, iconButton, button, linkButton, toast, copyText } from "./ph_util.js";
import {
  applySelectionToNodes,
  ensureSelectorNode,
  findInjectTargets,
  followsPanel,
  getWidget,
} from "./ph_inject.js";
import { openLibraryImportDialog } from "./ph_library_import.js";

const MODE_TEXT = "text";
const MODE_GALLERY = "gallery";
const CLAMP_CHARS = 220;
const SORT_MODES = ["desc", "asc", "manual"];
const SORT_LABELS = { desc: "最新在上", asc: "最早在上", manual: "手动顺序" };

let appRef = null;
let root = null;
let refs = {};
let previewLayer = null;
let refreshing = false;
let refreshQueued = false;
// 单击文字 / 缩略图时延迟选中，给双击编辑 / 看大图留出时间
let pendingSelectTimer = null;
let pendingSelectId = null;
const DOUBLE_CLICK_WINDOW = 400;

/* ------------------------------------------------------------------ 对外接口 */

export function initPanel(app) {
  appRef = app;
}

/**
 * 把面板挂到容器里。
 * 独立窗口模式下传 `{ headHost }`：标题行（标题 / 条数 / 导入导出 / 刷新）会被搬进窗口标题栏。
 */
export function mountPanel(container, options = {}) {
  if (!root) {
    buildShell(options || {});
    bindEvents();
    refresh(false);
  }
  if (container && root.parentElement !== container) container.appendChild(root);
  return root;
}

export async function refresh(showToast = false) {
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  try {
    const response = await phApi.list();
    if (response && response.state) {
      applyState(response.state);
      state.error = "";
      renderAll();
    }
    if (showToast) toast("已刷新", "success");
  } catch (err) {
    state.error = (err && err.message) || String(err);
    renderAll();
    if (!state.loaded) console.warn("[PromptHistory] 读取历史失败：", err);
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      setTimeout(() => refresh(false), 180);
    }
  }
}

/** 图加载 / 首次拿到数据后，把当前选中项回填到节点上 */
export function syncNodesFromSelection() {
  if (!state.settings.inject_enabled) return;
  const entry = getEntry(state.selectedId);
  if (!entry) return;
  // 只回填本插件的「提示词选择器」；PromptTagManager 里手写的提示词框不在加载时覆盖
  applySelectionToNodes(appRef, entry, { tagNodes: false });
  renderStatus();
}

/* ------------------------------------------------------------------ 骨架 */

function buildShell(options = {}) {
  root = el("div", "ph-root");
  const headHost = options.headHost || null;

  // 标题行
  const head = el("div", "ph-head");
  const title = el("div", "ph-title");
  title.appendChild(el("span", "ph-title-text", "提示词历史"));
  refs.count = el("span", "ph-count", "0");
  title.appendChild(refs.count);
  head.appendChild(title);

  const headActions = el("div", "ph-head-actions");
  refs.importInput = document.createElement("input");
  refs.importInput.type = "file";
  refs.importInput.accept = "application/json,.json";
  refs.importInput.className = "ph-file-input";
  refs.importInput.addEventListener("change", () => {
    const file = refs.importInput.files && refs.importInput.files[0];
    refs.importInput.value = "";
    if (file) importFile(file);
  });
  root.appendChild(refs.importInput);
  headActions.appendChild(iconButton("⤒", "导入 JSON 记录", () => refs.importInput.click()));
  headActions.appendChild(iconButton("⤓", "导出全部记录（JSON）", () => exportAll()));
  headActions.appendChild(iconButton("⟳", "刷新列表", () => refresh(true)));
  head.appendChild(headActions);
  if (headHost) headHost.appendChild(head);
  else root.appendChild(head);

  // 开关 + 展示模式
  const switchRow = el("div", "ph-switchrow");

  const switchLabel = el("label", "ph-switch");
  switchLabel.title =
    "打开后：单击面板里的文字或图片，会把它的提示词写进工作流的「汐皮笑脸的tag历史板」节点" +
    "和「汐皮笑脸的随机tag」节点的提示词框";
  refs.inject = document.createElement("input");
  refs.inject.type = "checkbox";
  refs.inject.className = "ph-switch-input";
  switchLabel.appendChild(refs.inject);
  const track = el("span", "ph-switch-track");
  track.appendChild(el("span", "ph-switch-dot"));
  switchLabel.appendChild(track);
  switchLabel.appendChild(el("span", "ph-switch-text", "选中即注入工作流"));
  switchRow.appendChild(switchLabel);

  const modes = el("div", "ph-modes");
  refs.modeText = el("button", "ph-mode-btn", "文字");
  refs.modeText.type = "button";
  refs.modeText.title = "纯文字，从上到下排列";
  refs.modeText.addEventListener("click", () => setMode(MODE_TEXT));
  refs.modeGallery = el("button", "ph-mode-btn", "图文");
  refs.modeGallery.type = "button";
  refs.modeGallery.title = "默认只看图片；可手动打开图和文";
  refs.modeGallery.addEventListener("click", () => setMode(MODE_GALLERY));
  refs.modeGalleryText = el("button", "ph-mode-btn ph-gallery-text-btn", "显示文字");
  refs.modeGalleryText.type = "button";
  refs.modeGalleryText.hidden = true;
  refs.modeGalleryText.title = "显示 / 隐藏每条记录下面的提示词正文";
  refs.modeGalleryText.addEventListener("click", () => toggleGalleryText());
  modes.appendChild(refs.modeText);
  modes.appendChild(refs.modeGallery);
  modes.appendChild(refs.modeGalleryText);
  switchRow.appendChild(modes);

  root.appendChild(switchRow);

  // 工具栏
  const toolbar = el("div", "ph-toolbar");
  refs.favoriteBtn = button("☆ 收藏夹", "ph-btn-ghost", () => toggleFavoritesView());
  refs.favoriteBtn.title = "只看已收藏的提示词（再次点击回到全部）";
  toolbar.appendChild(refs.favoriteBtn);

  const checkWrap = el("label", "ph-checkall");
  refs.checkAll = document.createElement("input");
  refs.checkAll.type = "checkbox";
  checkWrap.appendChild(refs.checkAll);
  refs.checkAllLabel = el("span", "", "全选");
  checkWrap.appendChild(refs.checkAllLabel);
  checkWrap.title = "全选 / 取消全选当前列表";
  toolbar.appendChild(checkWrap);

  refs.deleteBtn = button("删除选中", "ph-btn-danger", () => {
    const ids = filteredEntries()
      .filter((entry) => state.checked.has(entry.id))
      .map((entry) => entry.id);
    removeEntries(ids);
  });
  toolbar.appendChild(refs.deleteBtn);

  refs.copyBtn = button("复制选中", "", () => copyChecked());
  toolbar.appendChild(refs.copyBtn);

  refs.exportBtn = button("导出选中", "ph-btn-ghost", () => exportChecked());
  refs.exportBtn.title = "把勾选的记录导出成 JSON 文件";
  toolbar.appendChild(refs.exportBtn);

  refs.sortBtn = button("最新在上", "ph-btn-ghost", () => toggleSort());
  refs.sortBtn.title = "切换排序：最新在上 / 最早在上 / 手动拖拽顺序";
  toolbar.appendChild(refs.sortBtn);

  refs.clearBtn = button("清空", "ph-btn-ghost ph-btn-danger ph-clear-btn", () => clearAll());
  refs.clearBtn.title = "清空全部记录（不可撤销）";
  toolbar.appendChild(refs.clearBtn);

  root.appendChild(toolbar);

  // 搜索
  const searchRow = el("div", "ph-searchrow");
  refs.search = document.createElement("input");
  refs.search.type = "search";
  refs.search.className = "ph-search";
  refs.search.placeholder = "搜索提示词…";
  refs.search.addEventListener("input", () => {
    state.query = refs.search.value || "";
    state.page = 0;
    renderAll();
  });
  searchRow.appendChild(refs.search);
  root.appendChild(searchRow);

  // 手动添加
  refs.addToggle = button("＋ 手动添加提示词", "ph-btn-ghost ph-add-toggle", () => toggleAddBox());
  root.appendChild(refs.addToggle);

  const addBox = el("div", "ph-add");
  addBox.hidden = true;
  refs.addPos = document.createElement("textarea");
  refs.addPos.className = "ph-textarea";
  refs.addPos.rows = 4;
  refs.addPos.placeholder = "提示词（必填，Ctrl+Enter 直接添加）";
  refs.addPos.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitAdd();
    }
  });
  addBox.appendChild(refs.addPos);
  const addActions = el("div", "ph-add-actions");
  refs.addSubmit = button("添加到列表", "ph-btn-primary", () => submitAdd());
  addActions.appendChild(refs.addSubmit);
  addActions.appendChild(button("取消", "ph-btn-ghost", () => toggleAddBox(false)));
  addBox.appendChild(addActions);
  refs.addBox = addBox;
  root.appendChild(addBox);

  // 列表
  refs.list = el("div", "ph-list");
  root.appendChild(refs.list);

  // 分页：记录多时只渲染当前页，避免一次铺出几百张卡片
  refs.pager = el("div", "ph-pager");
  refs.pageInfo = el("span", "ph-page-info");
  refs.pager.appendChild(refs.pageInfo);

  refs.pageFirst = iconButton("«", "第一页", () => setPage(0), "ph-page-btn");
  refs.pagePrev = iconButton("‹", "上一页", () => setPage(state.page - 1), "ph-page-btn");
  refs.pageInput = document.createElement("input");
  refs.pageInput.type = "number";
  refs.pageInput.min = "1";
  refs.pageInput.className = "ph-page-input";
  refs.pageInput.title = "输入页码后按 Enter 跳转";
  refs.pageInput.addEventListener("change", () => jumpToPageInput());
  refs.pageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      jumpToPageInput();
    }
  });
  refs.pageTotal = el("span", "ph-page-total", "/ 1");
  refs.pageNext = iconButton("›", "下一页", () => setPage(state.page + 1), "ph-page-btn");
  refs.pageLast = iconButton("»", "最后一页", () => setPage(pageCount() - 1), "ph-page-btn");
  refs.pager.appendChild(refs.pageFirst);
  refs.pager.appendChild(refs.pagePrev);
  refs.pager.appendChild(refs.pageInput);
  refs.pager.appendChild(refs.pageTotal);
  refs.pager.appendChild(refs.pageNext);
  refs.pager.appendChild(refs.pageLast);

  refs.pageSize = document.createElement("select");
  refs.pageSize.className = "ph-page-size";
  refs.pageSize.title = "每页显示多少条";
  for (const size of PAGE_SIZES) {
    const option = document.createElement("option");
    option.value = String(size);
    option.textContent = `每页 ${size} 条`;
    refs.pageSize.appendChild(option);
  }
  refs.pageSize.addEventListener("change", () => {
    const size = Number(refs.pageSize.value);
    if (Number.isFinite(size) && size > 0) state.pageSize = Math.floor(size);
    state.page = 0;
    renderAll();
  });
  refs.pager.appendChild(refs.pageSize);
  root.appendChild(refs.pager);

  // 底部状态
  refs.status = el("div", "ph-status");
  root.appendChild(refs.status);

  renderAll();
}

/* ------------------------------------------------------------------ 交互绑定 */

function cancelPendingSelect() {
  if (pendingSelectTimer !== null) {
    clearTimeout(pendingSelectTimer);
    pendingSelectTimer = null;
  }
  pendingSelectId = null;
}

function scheduleSelect(id) {
  cancelPendingSelect();
  pendingSelectId = id;
  pendingSelectTimer = setTimeout(() => {
    const target = pendingSelectId;
    pendingSelectTimer = null;
    pendingSelectId = null;
    if (target) selectEntry(target);
  }, DOUBLE_CLICK_WINDOW);
}

function bindEvents() {
  const list = refs.list;

  list.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const card = target.closest(".ph-card");
    if (!card) return;
    const id = card.dataset.id;

    const actionEl = target.closest("[data-act]");
    if (actionEl) {
      event.preventDefault();
      event.stopPropagation();
      cancelPendingSelect();
      const action = actionEl.dataset.act;
      if (action === "copy") copyEntry(getEntry(id));
      else if (action === "delete") removeEntries([id]);
      else if (action === "expand") toggleExpand(id);
      else if (action === "pin") togglePin(id);
      else if (action === "edit") startEdit(id);
      else if (action === "import-lib") {
        openLibraryImportDialog(getEntry(id)).catch((err) => {
          toast("导入失败：" + (err && err.message ? err.message : err), "error");
        });
      } else if (action === "save-edit") saveEdit();
      else if (action === "cancel-edit") cancelEdit();
      return;
    }

    if (target.closest(".ph-check")) return; // 勾选框走 change 事件
    if (target.closest(".ph-edit")) return; // 编辑框里的点击不算选中
    if (Date.now() - lastDragEnd < 250) return; // 刚落完拖拽，别顺手选中

    // 单击文字 / 图片时先等一下：双击要用来编辑 / 看大图，
    // 如果立刻 selectEntry() 会重绘列表，浏览器就拿不到第二次单击了。
    if (target.closest(".ph-text") || target.closest(".ph-thumb")) {
      if (event.detail > 1) return;
      scheduleSelect(id);
      return;
    }
    cancelPendingSelect();
    selectEntry(id);
  });

  list.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.classList.contains("ph-check")) return;
    const card = target.closest(".ph-card");
    const id = card && card.dataset.id;
    if (!id) return;
    if (target.checked) state.checked.add(id);
    else state.checked.delete(id);
    if (card) card.classList.toggle("is-checked", target.checked);
    renderToolbar();
    renderStatus();
  });

  list.addEventListener("dblclick", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const card = target.closest(".ph-card");
    if (!card) return;
    const entry = getEntry(card.dataset.id);
    if (!entry) return;
    cancelPendingSelect();
    const thumb = target.closest(".ph-thumb");
    if (thumb) {
      event.preventDefault();
      openPreview(entry, Number(thumb.dataset.index || 0));
      return;
    }
    if (target.closest(".ph-text")) {
      event.preventDefault();
      startEdit(entry.id);
    }
  });

  refs.inject.addEventListener("change", () => setInject(refs.inject.checked));
  refs.checkAll.addEventListener("change", () => checkAllVisible(refs.checkAll.checked));

  bindDragAndDrop();
}

/* ------------------------------------------------------------------ 拖拽排序 */

let dragId = null;
let lastDragEnd = 0;

function clearDragClasses() {
  if (!refs.list) return;
  for (const card of refs.list.querySelectorAll(".ph-card")) {
    card.classList.remove("is-dragging", "is-drop-target");
  }
}

function bindDragAndDrop() {
  const list = refs.list;

  list.addEventListener("dragstart", (event) => {
    cancelPendingSelect();
    const target = event.target;
    if (!(target instanceof Element)) return;
    const card = target.closest(".ph-card");
    if (!card) return;
    dragId = card.dataset.id || null;
    card.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      try {
        event.dataTransfer.setData("text/plain", dragId || "");
      } catch (err) {
        /* 少数环境不支持，无所谓 */
      }
    }
  });

  list.addEventListener("dragover", (event) => {
    if (!dragId) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const card = target.closest(".ph-card");
    if (!card) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    for (const other of list.querySelectorAll(".ph-card")) {
      other.classList.toggle(
        "is-drop-target",
        other === card && other.dataset.id !== dragId
      );
    }
  });

  list.addEventListener("dragleave", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const card = target.closest(".ph-card");
    if (card) card.classList.remove("is-drop-target");
  });

  list.addEventListener("drop", (event) => {
    if (!dragId) return;
    const target = event.target;
    const card = target instanceof Element ? target.closest(".ph-card") : null;
    if (card) event.preventDefault();
    const draggedId = dragId;
    const targetId = card ? card.dataset.id : null;
    dragId = null;
    lastDragEnd = Date.now();
    clearDragClasses();
    if (!targetId || targetId === draggedId) return;
    applyReorder(draggedId, targetId);
  });

  list.addEventListener("dragend", () => {
    dragId = null;
    lastDragEnd = Date.now();
    clearDragClasses();
  });
}

async function applyReorder(draggedId, targetId) {
  const current = filteredEntries().map((entry) => entry.id);
  const from = current.indexOf(draggedId);
  const to = current.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return;

  const next = current.slice();
  next.splice(from, 1);
  next.splice(to, 0, draggedId);

  // 先把本地顺序改掉，界面立刻响应
  state.settings.sort = "manual";
  next.forEach((id, index) => {
    const entry = getEntry(id);
    if (entry) entry.order = index + 1;
  });
  renderAll();

  try {
    const response = await phApi.reorder(next);
    if (response && response.state) applyState(response.state);
    renderAll();
    toast("顺序已调整（已切换为手动顺序）", "success");
  } catch (err) {
    toast("调整顺序失败：" + err.message, "error");
    refresh(false);
  }
}

/* ------------------------------------------------------------------ 渲染 */

function renderAll() {
  if (!root) return;
  clampPage();
  renderCount();
  renderSwitch();
  renderModeButtons();
  renderToolbar();
  renderList();
  renderPager();
  renderStatus();
}

function setPage(index) {
  const max = pageCount() - 1;
  const next = Math.max(0, Math.min(Number(index) || 0, max));
  if (next === state.page) return;
  state.page = next;
  renderToolbar();
  renderList();
  renderPager();
  renderStatus();
}

function jumpToPageInput() {
  const value = Number(refs.pageInput && refs.pageInput.value);
  if (!Number.isFinite(value)) {
    renderPager();
    return;
  }
  setPage(Math.max(0, Math.trunc(value) - 1));
}

function renderPager() {
  if (!refs.pager) return;
  clampPage();
  const total = filteredEntries().length;
  const pages = pageCount();
  const shown = visibleEntries();
  const size = Math.max(1, Number(state.pageSize) || PAGE_SIZES[0]);
  const start = total && shown.length ? state.page * size + 1 : 0;
  const end = start && shown.length ? start + shown.length - 1 : 0;
  refs.pager.hidden = total === 0;
  if (refs.pageInfo) {
    refs.pageInfo.textContent = total
      ? `第 ${state.page + 1} / ${pages} 页 · ${start}–${end} / 共 ${total} 条`
      : "共 0 条";
  }
  if (refs.pageInput) {
    refs.pageInput.value = String(state.page + 1);
    refs.pageInput.max = String(pages);
  }
  if (refs.pageTotal) refs.pageTotal.textContent = `/ ${pages}`;
  if (refs.pageSize) refs.pageSize.value = String(size);
  const atStart = state.page <= 0;
  const atEnd = state.page >= pages - 1;
  for (const button of [refs.pageFirst, refs.pagePrev]) {
    if (button) button.disabled = atStart;
  }
  for (const button of [refs.pageNext, refs.pageLast]) {
    if (button) button.disabled = atEnd;
  }
}

function renderCount() {
  if (!refs.count) return;
  const total = state.stats.total || state.entries.length;
  const images = state.stats.images || 0;
  refs.count.textContent = total ? `${total} 条${images ? ` · ${images} 图` : ""}` : "";
}

function renderSwitch() {
  if (!refs.inject) return;
  refs.inject.checked = !!state.settings.inject_enabled;
  root.classList.toggle("is-inject-off", !state.settings.inject_enabled);
}

function renderModeButtons() {
  const mode = state.settings.mode === MODE_GALLERY ? MODE_GALLERY : MODE_TEXT;
  const gallery = mode === MODE_GALLERY;
  const showText = gallery && !!state.galleryText;
  root.classList.toggle("is-gallery", gallery);
  root.classList.toggle("is-gallery-images-only", gallery && !showText);
  root.classList.toggle("is-gallery-with-text", showText);
  if (refs.modeText) refs.modeText.classList.toggle("is-active", mode === MODE_TEXT);
  if (refs.modeGallery) refs.modeGallery.classList.toggle("is-active", gallery);
  if (refs.modeGalleryText) {
    refs.modeGalleryText.hidden = !gallery;
    refs.modeGalleryText.textContent = showText ? "隐藏文字" : "显示文字";
    refs.modeGalleryText.classList.toggle("is-active", showText);
  }
}

function renderToolbar() {
  const all = filteredEntries();
  const page = visibleEntries();
  const checkedCount = all.filter((entry) => state.checked.has(entry.id)).length;
  // 全部记录里的「全选」不包含收藏；收藏夹里的「全选」才选收藏
  const selectable = state.favoritesOnly ? page : page.filter((entry) => !entry.pinned);
  const selectableChecked = selectable.filter((entry) => state.checked.has(entry.id)).length;
  const allChecked = selectable.length > 0 && selectableChecked === selectable.length;
  const multiPage = pageCount() > 1;
  if (refs.favoriteBtn) {
    const favoriteCount = state.entries.filter((entry) => entry.pinned).length;
    refs.favoriteBtn.textContent = `${state.favoritesOnly ? "★" : "☆"} 收藏夹${favoriteCount ? ` (${favoriteCount})` : ""}`;
    refs.favoriteBtn.classList.toggle("is-active", state.favoritesOnly);
    refs.favoriteBtn.title = state.favoritesOnly
      ? "正在看收藏夹，点击回到全部记录"
      : "只看已收藏的提示词";
  }
  if (refs.checkAll) {
    refs.checkAll.checked = allChecked;
    refs.checkAll.indeterminate = selectableChecked > 0 && !allChecked;
    refs.checkAll.disabled = selectable.length === 0;
    refs.checkAll.title = state.favoritesOnly
      ? "全选 / 取消全选收藏夹当前页"
      : "全选 / 取消全选当前页（不包含已收藏的记录）";
  }
  if (refs.checkAllLabel) {
    refs.checkAllLabel.textContent = multiPage ? "全选本页" : "全选";
  }
  if (refs.deleteBtn) {
    refs.deleteBtn.textContent = checkedCount ? `删除选中 (${checkedCount})` : "删除选中";
    refs.deleteBtn.disabled = checkedCount === 0;
  }
  if (refs.copyBtn) {
    refs.copyBtn.textContent = checkedCount ? `复制选中 (${checkedCount})` : "复制选中";
    refs.copyBtn.disabled = checkedCount === 0;
  }
  if (refs.exportBtn) {
    refs.exportBtn.textContent = checkedCount ? `导出选中 (${checkedCount})` : "导出选中";
    refs.exportBtn.disabled = checkedCount === 0;
  }
  if (refs.sortBtn) {
    refs.sortBtn.textContent = SORT_LABELS[state.settings.sort] || SORT_LABELS.desc;
  }
  if (refs.clearBtn) refs.clearBtn.disabled = state.entries.length === 0;
}

function renderList() {
  if (!refs.list) return;
  clearNode(refs.list);

  const entries = visibleEntries();
  if (!entries.length) {
    refs.list.appendChild(emptyView());
    return;
  }

  const gallery = state.settings.mode === MODE_GALLERY;
  const fragment = document.createDocumentFragment();
  for (const entry of entries) fragment.appendChild(renderCard(entry, gallery));
  refs.list.appendChild(fragment);
  const editor = refs.list.querySelector(".ph-edit-input");
  if (editor) requestAnimationFrame(() => autoGrowEditor(editor));
}

function emptyView() {
  const box = el("div", "ph-empty");
  if (state.error) {
    box.appendChild(el("div", "ph-empty-title", "读取失败"));
    box.appendChild(el("div", "ph-empty-text", state.error));
    box.appendChild(button("重试", "ph-btn-primary", () => refresh(false)));
    return box;
  }
  if (!state.loaded) {
    box.appendChild(el("div", "ph-empty-text", "正在读取…"));
    return box;
  }
  if (state.query.trim()) {
    box.appendChild(el("div", "ph-empty-text", "没有匹配的提示词"));
    return box;
  }
  if (state.favoritesOnly) {
    box.appendChild(el("div", "ph-empty-title", "收藏夹还是空的"));
    box.appendChild(
      el(
        "div",
        "ph-empty-text",
        "在任意记录右上角点 ☆ 收藏，它就会出现在这里，不占用全部列表的位置。"
      )
    );
    return box;
  }
  box.appendChild(el("div", "ph-empty-title", "还没有历史记录"));
  box.appendChild(
    el(
      "div",
      "ph-empty-text",
      "在上方点「运行 / 排队」提交一次工作流，这里会自动保存一份提示词；也可以点「手动添加提示词」。"
    )
  );
  return box;
}

function renderCard(entry, gallery) {
  const card = el("div", "ph-card");
  card.dataset.id = entry.id;
  if (entry.id === state.selectedId) card.classList.add("is-selected");
  if (state.checked.has(entry.id)) card.classList.add("is-checked");
  if (entry.pinned) card.classList.add("is-pinned");
  const hasImages = Array.isArray(entry.images) && entry.images.length > 0;
  if (hasImages) card.classList.add("has-images");
  if (entry.id === state.selectedId) card.title = "再次单击可取消选中";
  // 拖着换顺序；搜索 / 收藏夹过滤时禁用（不然隐藏的记录顺序会乱）
  card.draggable =
    !state.query.trim() &&
    !state.favoritesOnly &&
    !(state.editing && state.editing.id === entry.id);
  if (card.draggable) card.title = [card.title, "拖动可以调整顺序"].filter(Boolean).join(" · ");

  // 头部
  const head = el("div", "ph-card-head");
  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "ph-check";
  check.dataset.id = entry.id;
  check.checked = state.checked.has(entry.id);
  check.title = "勾选以批量删除 / 复制";
  head.appendChild(check);

  head.appendChild(el("span", "ph-seq", `#${entry.seq || "?"}`));
  if (entry.time) head.appendChild(el("span", "ph-time", entry.time));
  head.appendChild(
    el(
      "span",
      "ph-badge " + (entry.source === "manual" ? "ph-badge-manual" : "ph-badge-workflow"),
      entry.source === "manual" ? "手动" : "工作流"
    )
  );
  if (hasImages) head.appendChild(el("span", "ph-badge ph-badge-img", `图 ${entry.images.length}`));
  const origin = entry.origin || (entry.exact ? "node" : "");
  if (origin === "merge") {
    const badge = el("span", "ph-badge ph-badge-exact", "合并");
    badge.title = "文本由工作流里的「合并提示词」节点按它自己的分隔符算出，是完整提示词";
    head.appendChild(badge);
  } else if (entry.exact || origin === "node" || origin === "runtime") {
    const badge = el("span", "ph-badge ph-badge-exact", "原文");
    badge.title = "文本来自执行期实际使用的完整提示词（已展开随机池 / 通配符）";
    head.appendChild(badge);
  }
  if (entry.pinned) {
    const pinBadge = el("span", "ph-badge ph-badge-pin", "收藏");
    pinBadge.title = "已加入收藏夹";
    head.appendChild(pinBadge);
  }
  const actions = el("div", "ph-card-actions");
  const textVisible = !gallery || !!state.galleryText;
  const searching = Boolean(state.query.trim());

  const importBtn = iconButton(
    "导入词库",
    "把这条提示词导入到 TAG 词库（可拆成 tag 或整条，存进指定分类）",
    null,
    "ph-icon-btn-wide ph-import-btn"
  );
  importBtn.dataset.act = "import-lib";
  actions.appendChild(importBtn);

  const isLong = (entry.positive || "").length > CLAMP_CHARS || (entry.positive || "").split("\n").length > 6;
  // 只看图片时正文没渲染、「展开 / 收起」没有意义；搜索时正文一律全展开，也不显示
  if (isLong && textVisible && !searching) {
    const expanded = state.expanded.has(entry.id);
    const expandBtn = iconButton(
      expanded ? "收起" : "展开",
      expanded ? "收起全文" : "展开全文",
      null,
      "ph-icon-btn-wide"
    );
    expandBtn.dataset.act = "expand";
    actions.appendChild(expandBtn);
  }

  const pinBtn = iconButton(entry.pinned ? "★" : "☆", entry.pinned ? "取消收藏（移出收藏夹）" : "收藏（加入收藏夹）", null, entry.pinned ? "ph-pin-on" : "");
  pinBtn.dataset.act = "pin";
  actions.appendChild(pinBtn);

  const editBtn = iconButton("✎", "编辑这条提示词", null, "");
  editBtn.dataset.act = "edit";
  if (textVisible) actions.appendChild(editBtn);

  const copyBtn = iconButton("⧉", "复制提示词", null, "");
  copyBtn.dataset.act = "copy";
  actions.appendChild(copyBtn);

  const deleteBtn = iconButton("✕", "删除这条", null, "ph-btn-danger");
  deleteBtn.dataset.act = "delete";
  actions.appendChild(deleteBtn);

  head.appendChild(actions);
  card.appendChild(head);

  // 图文模式：图片 + 文字放进同一个横向容器，文字用右侧空白区域
  const content = gallery ? el("div", "ph-gallery-content") : card;
  if (gallery && hasImages) content.appendChild(renderThumbs(entry));

  // 正在编辑：换成文本框
  if (state.editing && state.editing.id === entry.id) {
    content.classList.add("is-editing");
    content.appendChild(renderEditor(entry));
    if (gallery) card.appendChild(content);
    return card;
  }

  // 图文模式默认只看图；点「显示文字」后才渲染提示词正文
  if (gallery && !state.galleryText) {
    if (!hasImages) {
      content.appendChild(
        el("div", "ph-gallery-no-image", "无图片 · 点「显示文字」查看提示词")
      );
    }
    card.appendChild(content);
    return card;
  }

  // 提示词正文：搜索时把命中的词标出来，并且不折叠，保证一定看得到
  const expanded = state.expanded.has(entry.id);
  const body = entry.positive || "（空）";
  const text = el("div", "ph-text");
  text.appendChild(highlightText(body, searching ? state.query : ""));
  if (!searching && !expanded && (entry.positive || "").length > CLAMP_CHARS) {
    text.classList.add("is-clamped");
  }
  text.title = "双击就地编辑";
  content.appendChild(text);
  if (gallery) card.appendChild(content);

  return card;
}

/**
 * 把搜索词在正文里标成 <mark>：不区分大小写，保留原文大小写；
 * 匹配按子串算（和后端 / 现有过滤逻辑一致），不用正则，避免特殊字符出问题。
 */
function highlightText(value, query) {
  const text = String(value ?? "");
  const needle = String(query ?? "").trim();
  const fragment = document.createDocumentFragment();
  if (!needle || !text) {
    fragment.appendChild(document.createTextNode(text));
    return fragment;
  }
  const haystack = text.toLowerCase();
  const lower = needle.toLowerCase();
  let from = 0;
  while (from < text.length) {
    const hit = haystack.indexOf(lower, from);
    if (hit < 0) break;
    if (hit > from) fragment.appendChild(document.createTextNode(text.slice(from, hit)));
    const mark = document.createElement("mark");
    mark.className = "ph-hit";
    mark.textContent = text.slice(hit, hit + needle.length);
    fragment.appendChild(mark);
    from = hit + needle.length;
  }
  if (from < text.length) fragment.appendChild(document.createTextNode(text.slice(from)));
  return fragment;
}

/** 就地编辑的文本框 + 保存 / 取消 */
function autoGrowEditor(area) {
  if (!area || !area.style) return;
  const viewport =
    typeof window !== "undefined" && Number(window.innerHeight) ? Number(window.innerHeight) : 800;
  // 自适应到内容高度，但给一个上限；长提示词在框内滚动，避免把整张卡片拉得过长
  const maxHeight = Math.min(260, Math.max(150, Math.floor(viewport * 0.36)));
  area.style.height = "auto";
  const scrollHeight = Number(area.scrollHeight) || 0;
  const height = Math.min(Math.max(scrollHeight, 120), maxHeight);
  area.style.height = `${height}px`;
  area.style.overflowY = scrollHeight > maxHeight ? "auto" : "hidden";
}

function renderEditor(entry) {
  const box = el("div", "ph-edit");
  const area = document.createElement("textarea");
  area.className = "ph-textarea ph-edit-input";
  area.rows = 1;
  area.value = state.editing.value ?? entry.positive ?? "";
  area.addEventListener("input", () => {
    if (state.editing) state.editing.value = area.value;
    autoGrowEditor(area);
  });
  area.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      saveEdit();
    }
  });
  box.appendChild(area);
  requestAnimationFrame(() => autoGrowEditor(area));

  const actions = el("div", "ph-add-actions");
  const saveBtn = button("保存", "ph-btn-primary", () => saveEdit());
  saveBtn.dataset.act = "save-edit";
  actions.appendChild(saveBtn);
  const cancelBtn = button("取消", "ph-btn-ghost", () => cancelEdit());
  cancelBtn.dataset.act = "cancel-edit";
  actions.appendChild(cancelBtn);
  box.appendChild(actions);
  return box;
}

function renderThumbs(entry) {
  const wrap = el("div", "ph-thumbs");
  if (entry.images.length > 1) wrap.classList.add("is-multi");
  entry.images.forEach((image, index) => {
    const box = el("div", "ph-thumb");
    box.dataset.index = String(index);
    box.title = "单击选中 · 双击查看大图";
    if (image.width && image.height) {
      // 用真实比例撑住图片框，避免加载前后跳高度（只防极端值，不裁切）
      const ratio = Math.min(4, Math.max(0.25, image.width / image.height));
      box.style.setProperty("--ph-ratio", String(ratio));
    }
    if (image.kind === "video") {
      const video = document.createElement("video");
      video.className = "ph-thumb-media";
      video.src = mediaURL(image.url);
      video.muted = true;
      video.preload = "metadata";
      video.playsInline = true;
      box.appendChild(video);
      box.appendChild(el("span", "ph-thumb-badge", "视频"));
    } else {
      const img = document.createElement("img");
      img.className = "ph-thumb-media";
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "";
      const original = image.url || image.thumb_url;
      const fallback = image.thumb_url && image.thumb_url !== original ? image.thumb_url : "";
      img.src = mediaURL(original);
      img.addEventListener("error", () => {
        if (fallback && !img.dataset.retried) {
          img.dataset.retried = "1";
          img.src = mediaURL(fallback);
        }
      });
      box.appendChild(img);
    }
    wrap.appendChild(box);
  });
  return wrap;
}

function renderStatus() {
  const box = refs.status;
  if (!box) return;
  clearNode(box);

  const total = state.stats.total || state.entries.length;
  const bits = [`共 ${total} 条`];
  if (state.checked.size) bits.push(`已勾选 ${state.checked.size} 条`);
  box.appendChild(el("span", "ph-status-text", bits.join(" · ")));

  if (!state.settings.inject_enabled) {
    box.appendChild(el("span", "ph-status-warn", "注入已关闭：单击只选中，不写入节点"));
    return;
  }

  const targets = findInjectTargets(appRef);
  const entry = state.selectedId ? getEntry(state.selectedId) : null;

  if (!targets.length) {
    if (entry) box.appendChild(el("span", "ph-status-selected", `已选中 #${entry.seq || "?"}`));
    box.appendChild(el("span", "ph-status-hint", "图中还没有可注入的提示词节点"));
    box.appendChild(linkButton("创建tag历史板", () => addSelectorNode()));
    return;
  }

  if (!entry) {
    box.appendChild(el("span", "ph-status-hint", "单击记录即可注入提示词"));
    return;
  }

  box.appendChild(el("span", "ph-status-selected", `已选中 #${entry.seq || "?"}`));
  const positive = entry.positive || "";
  const active = targets.filter((target) => {
    if (target.honorFollow && !followsPanel(target.node)) return false;
    const widget = getWidget(target.node, target.widgetName);
    return Boolean(widget) && widget.value === positive;
  }).length;
  box.appendChild(el("span", "ph-status-ok", `已注入 ${active} 个节点`));
  box.appendChild(linkButton("取消选中", () => applySelection(null, null)));
}

/* ------------------------------------------------------------------ 操作 */

async function setMode(mode) {
  if (state.settings.mode === mode) return;
  // 每次从别的模式进入图文，先回到「只看图片」；进入后可手动打开文字
  const enteringGallery = mode === MODE_GALLERY && state.settings.mode !== MODE_GALLERY;
  state.settings.mode = mode;
  if (enteringGallery) state.galleryText = false;
  renderModeButtons();
  renderList();
  try {
    await phApi.settings({ mode });
  } catch (err) {
    toast("保存展示模式失败：" + err.message, "error");
  }
}

function toggleGalleryText() {
  if (state.settings.mode !== MODE_GALLERY) return;
  state.galleryText = !state.galleryText;
  renderModeButtons();
  renderList();
}

async function toggleSort() {
  const index = SORT_MODES.indexOf(state.settings.sort);
  const next = SORT_MODES[(index + 1) % SORT_MODES.length];
  state.settings.sort = next;
  state.page = 0;
  renderAll();
  toast(`排序：${SORT_LABELS[next]}${next === "manual" ? "（可以直接拖动卡片调整）" : ""}`);
  try {
    await phApi.settings({ sort: next });
  } catch (err) {
    toast("保存排序失败：" + err.message, "error");
  }
}

/* ------------------------------------------------------------------ 收藏 / 编辑 */

function toggleFavoritesView() {
  state.favoritesOnly = !state.favoritesOnly;
  state.page = 0;
  state.checked.clear();
  renderAll();
  toast(state.favoritesOnly ? "已打开收藏夹" : "已回到全部记录");
}

async function togglePin(id) {
  const entry = getEntry(id);
  if (!entry) return;
  const pinned = !entry.pinned;
  entry.pinned = pinned;
  renderAll();
  try {
    const response = await phApi.pin(id, pinned);
    if (response && response.state) applyState(response.state);
    renderAll();
    toast(pinned ? "已收藏，已放入收藏夹" : "已取消收藏，已移出收藏夹", "success");
  } catch (err) {
    entry.pinned = !pinned;
    renderAll();
    toast("操作失败：" + err.message, "error");
  }
}

function startEdit(id) {
  const entry = getEntry(id);
  if (!entry) return;
  cancelPendingSelect();
  // 进入编辑时直接把这条展开，编辑框再按全文自适应高度
  state.expanded.add(id);
  state.editing = { id, value: entry.positive || "" };
  renderList();
  const area = refs.list.querySelector(".ph-edit-input");
  if (area) {
    autoGrowEditor(area);
    if (typeof area.focus === "function") area.focus();
    if (typeof area.setSelectionRange === "function") {
      const end = String(area.value || "").length;
      area.setSelectionRange(end, end);
    }
  }
}

function cancelEdit() {
  if (!state.editing) return;
  state.editing = null;
  renderList();
}

async function saveEdit() {
  const editing = state.editing;
  if (!editing) return;
  const value = (editing.value || "").trim();
  if (!value) {
    toast("提示词不能为空", "warn");
    return;
  }
  try {
    const response = await phApi.update(editing.id, value);
    state.editing = null;
    if (response && response.state) applyState(response.state);
    renderAll();
    toast("已保存", "success");
    // 如果正在注入的就是这一条，把节点里的文本也刷新一下
    if (state.settings.inject_enabled && state.selectedId === editing.id) {
      applySelectionToNodes(appRef, getEntry(editing.id));
    }
  } catch (err) {
    toast("保存失败：" + err.message, "error");
  }
}

async function setInject(enabled) {
  state.settings.inject_enabled = !!enabled;
  renderSwitch();
  if (enabled) {
    const entry = getEntry(state.selectedId);
    if (entry) applySelectionToNodes(appRef, entry);
    toast("已开启：单击记录即注入提示词");
  } else {
    toast("已关闭：单击只选中，不写入节点");
  }
  renderStatus();
  try {
    await phApi.settings({ inject_enabled: !!enabled });
  } catch (err) {
    toast("保存开关失败：" + err.message, "error");
  }
}

async function selectEntry(id) {
  const entry = getEntry(id);
  if (!entry) return;
  const next = state.selectedId === id ? null : id;
  await applySelection(next, next ? entry : null);
}

async function applySelection(id, entry) {
  state.selectedId = id || null;
  if (state.settings.inject_enabled) {
    applySelectionToNodes(appRef, entry || null);
  }
  // 高亮立刻更新，网络请求随后
  renderList();
  renderStatus();
  try {
    const response = await phApi.select(state.selectedId);
    if (response && response.state) {
      // 保留本地勾选 / 展开状态，只同步服务端字段
      applyState(response.state);
      renderCount();
      renderToolbar();
      renderList();
      renderStatus();
    }
  } catch (err) {
    toast("保存选中项失败：" + err.message, "error");
  }
}

function addSelectorNode() {
  const node = ensureSelectorNode(appRef);
  if (!node) {
    toast("创建失败：当前画布不可用", "error");
    return;
  }
  if (state.settings.inject_enabled) {
    const entry = getEntry(state.selectedId);
    if (entry) applySelectionToNodes(appRef, entry);
  }
  toast("已添加「汐皮笑脸的tag历史板」节点");
  renderStatus();
}

function toggleExpand(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  renderList();
}

function toggleAddBox(force) {
  const next = typeof force === "boolean" ? force : refs.addBox.hidden;
  refs.addBox.hidden = !next;
  refs.addToggle.classList.toggle("is-open", next);
  refs.addToggle.textContent = next ? "－ 收起手动添加" : "＋ 手动添加提示词";
  if (next) refs.addPos.focus();
}

async function submitAdd() {
  const positive = (refs.addPos.value || "").trim();
  if (!positive) {
    toast("请先填写提示词", "warn");
    refs.addPos.focus();
    return;
  }
  refs.addSubmit.disabled = true;
  try {
    const response = await phApi.add(positive);
    refs.addPos.value = "";
    if (response && response.state) applyState(response.state);
    renderAll();
    toast("已添加到列表", "success");
  } catch (err) {
    toast("添加失败：" + err.message, "error");
  } finally {
    refs.addSubmit.disabled = false;
  }
}

async function copyEntry(entry) {
  if (!entry) return;
  const text = entry.positive;
  if (!text) {
    toast("这条没有提示词", "warn");
    return;
  }
  const ok = await copyText(text);
  toast(ok ? "已复制到剪贴板" : "复制失败，请手动选中复制", ok ? "success" : "error");
}

async function copyChecked() {
  const picked = filteredEntries().filter((entry) => state.checked.has(entry.id));
  if (!picked.length) return;
  const text = picked
    .map((entry) => entry.positive || "")
    .filter((value) => value.trim())
    .join("\n\n");
  if (!text) {
    toast("勾选的记录里没有提示词", "warn");
    return;
  }
  const ok = await copyText(text);
  toast(ok ? `已复制 ${picked.length} 条提示词` : "复制失败，请手动选中复制", ok ? "success" : "error");
}

async function removeEntries(ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return;
  const label = list.length === 1 ? "这条记录" : `选中的 ${list.length} 条记录`;
  if (!window.confirm(`确定删除${label}吗？对应的图片副本也会一起删掉。`)) return;
  try {
    const response = await phApi.remove(list);
    for (const id of list) state.checked.delete(id);
    const hadSelection = list.includes(state.selectedId);
    if (response && response.state) applyState(response.state);
    if (hadSelection && state.settings.inject_enabled) applySelectionToNodes(appRef, null);
    renderAll();
    toast(`已删除 ${response && response.removed ? response.removed : list.length} 条`, "success");
  } catch (err) {
    toast("删除失败：" + err.message, "error");
  }
}

async function clearAll() {
  if (!state.entries.length) return;
  if (!window.confirm(`确定清空全部 ${state.entries.length} 条记录吗？此操作不可撤销。`)) return;
  try {
    const response = await phApi.clear();
    state.checked.clear();
    state.expanded.clear();
    if (response && response.state) applyState(response.state);
    if (state.settings.inject_enabled) applySelectionToNodes(appRef, null);
    renderAll();
    toast("已清空", "success");
  } catch (err) {
    toast("清空失败：" + err.message, "error");
  }
}

function checkAllVisible(checked) {
  const visible = visibleEntries();
  // 收藏夹之外全选时跳过收藏记录；收藏记录只能在收藏夹里全选
  const targets = checked && !state.favoritesOnly
    ? visible.filter((entry) => !entry.pinned)
    : visible;
  for (const entry of targets) {
    if (checked) state.checked.add(entry.id);
    else state.checked.delete(entry.id);
  }
  renderToolbar();
  renderList();
  renderStatus();
}

async function exportAll() {
  try {
    const response = await phApi.exportAll();
    downloadJSON((response && response.data) || response || {}, "prompt-history");
    toast("已导出全部记录", "success");
  } catch (err) {
    toast("导出失败：" + err.message, "error");
  }
}

async function exportChecked() {
  const picked = filteredEntries().filter((entry) => state.checked.has(entry.id));
  if (!picked.length) {
    toast("先勾选要导出的记录", "warn");
    return;
  }
  try {
    const response = await phApi.exportSelected(picked.map((entry) => entry.id));
    downloadJSON((response && response.data) || response || {}, "prompt-history-selected");
    toast(`已导出 ${picked.length} 条`, "success");
  } catch (err) {
    toast("导出失败：" + err.message, "error");
  }
}

function downloadJSON(payload, prefix) {
  const text = JSON.stringify(payload, null, 2);
  if (typeof Blob !== "function" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    // 老浏览器 / 测试环境：退化成复制到剪贴板
    copyText(text);
    return;
  }
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${prefix}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function importFile(file) {
  let payload;
  try {
    const text = typeof file.text === "function" ? await file.text() : String(file);
    payload = JSON.parse(text);
  } catch (err) {
    toast("不是有效的 JSON 文件", "error");
    return;
  }
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.entries)
    ? payload.entries
    : Array.isArray(payload?.data?.entries)
    ? payload.data.entries
    : [];
  if (!entries.length) {
    toast("文件里没有可导入的记录", "warn");
    return;
  }
  try {
    const response = await phApi.importEntries(entries);
    if (response && response.state) applyState(response.state);
    renderAll();
    toast(`已导入 ${response && response.added ? response.added : entries.length} 条`, "success");
  } catch (err) {
    toast("导入失败：" + err.message, "error");
  }
}

/* ------------------------------------------------------------------ 大图预览 */

function openPreview(entry, index) {
  closePreview();
  const layer = el("div", "ph-preview");
  const panel = el("div", "ph-preview-panel");

  const bar = el("div", "ph-preview-bar");
  bar.appendChild(el("span", "ph-preview-title", `#${entry.seq || "?"} · ${entry.date || ""} ${entry.time || ""}`));
  bar.appendChild(el("span", "ph-grow"));
  bar.appendChild(button("复制提示词", "ph-btn-mini", () => copyEntry(entry)));
  bar.appendChild(iconButton("✕", "关闭", () => closePreview()));
  panel.appendChild(bar);

  const images = Array.isArray(entry.images) ? entry.images : [];
  const image = images[index] || images[0];
  if (image) {
    if (image.kind === "video") {
      const video = document.createElement("video");
      video.className = "ph-preview-media";
      video.src = mediaURL(image.url);
      video.controls = true;
      video.autoplay = true;
      video.loop = true;
      panel.appendChild(video);
    } else {
      const img = document.createElement("img");
      img.className = "ph-preview-media";
      img.src = mediaURL(image.url);
      img.alt = "";
      panel.appendChild(img);
    }
  }

  const previewText = el("div", "ph-preview-text");
  previewText.appendChild(highlightText(entry.positive || "（空）", state.query));
  panel.appendChild(previewText);

  layer.appendChild(panel);
  layer.addEventListener("click", (event) => {
    if (event.target === layer) closePreview();
  });
  document.body.appendChild(layer);
  previewLayer = layer;
  document.addEventListener("keydown", onPreviewKeydown);
}

function closePreview() {
  document.removeEventListener("keydown", onPreviewKeydown);
  if (previewLayer) {
    previewLayer.remove();
    previewLayer = null;
  }
}

function onPreviewKeydown(event) {
  if (event.key === "Escape") closePreview();
}
