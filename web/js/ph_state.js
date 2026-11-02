/** 面板共享状态（服务端是唯一真源，这里只做渲染用的副本）。 */

export const DEFAULT_SETTINGS = {
  inject_enabled: true,
  mode: "text",
  // desc = 最新在上 / asc = 最早在上 / manual = 手动拖拽顺序
  sort: "desc",
  max_entries: 300,
  save_images: true,
};

const SORT_MODES = ["desc", "asc", "manual"];

export const PAGE_SIZES = [20, 50, 100];

export const state = {
  entries: [],
  settings: { ...DEFAULT_SETTINGS },
  selectedId: null,
  checked: new Set(),
  expanded: new Set(),
  query: "",
  // 收藏夹视图：只看已收藏的记录（本地视图状态，不写回服务端）
  favoritesOnly: false,
  // 图文模式下是否显示提示词正文；默认只看图片，可手动打开
  galleryText: false,
  // 分页：当前页从 0 开始
  page: 0,
  pageSize: PAGE_SIZES[0],
  // 正在就地编辑的记录：{ id, value }
  editing: null,
  stats: { total: 0, images: 0 },
  dataDir: "",
  loaded: false,
  error: "",
};

/** 用服务端返回的 state 覆盖本地副本 */
export function applyState(payload) {
  if (!payload || typeof payload !== "object") return;
  if (Array.isArray(payload.entries)) {
    state.entries = payload.entries.filter((entry) => entry && entry.id);
  }
  if (payload.settings && typeof payload.settings === "object") {
    state.settings = { ...state.settings, ...payload.settings };
    if (state.settings.mode !== "gallery") state.settings.mode = "text";
    if (!SORT_MODES.includes(state.settings.sort)) state.settings.sort = "desc";
  }
  state.selectedId = payload.selected || null;
  if (payload.stats && typeof payload.stats === "object") {
    state.stats = {
      total: Number(payload.stats.total) || state.entries.length,
      images: Number(payload.stats.images) || 0,
    };
  } else {
    state.stats = { total: state.entries.length, images: 0 };
  }
  if (typeof payload.data_dir === "string") state.dataDir = payload.data_dir;
  state.loaded = true;

  // 清掉已经不存在的勾选 / 展开 / 编辑状态
  const ids = new Set(state.entries.map((entry) => entry.id));
  for (const id of Array.from(state.checked)) if (!ids.has(id)) state.checked.delete(id);
  for (const id of Array.from(state.expanded)) if (!ids.has(id)) state.expanded.delete(id);
  if (state.editing && !ids.has(state.editing.id)) state.editing = null;
}

export function getEntry(id) {
  if (!id) return null;
  return state.entries.find((entry) => entry.id === id) || null;
}

function compareBySeq(a, b) {
  return (a.seq || 0) - (b.seq || 0);
}

function compareByOrder(a, b) {
  const left = typeof a.order === "number" ? a.order : -(a.seq || 0);
  const right = typeof b.order === "number" ? b.order : -(b.seq || 0);
  if (left === right) return compareBySeq(a, b);
  return left - right;
}

/** 当前排序用的比较器 */
export function comparator() {
  if (state.settings.sort === "asc") return compareBySeq;
  if (state.settings.sort === "manual") return compareByOrder;
  return (a, b) => compareBySeq(b, a);
}

/** 按排序设置 + 搜索词得到要渲染的列表（收藏的永远在最上面） */
/** 按排序设置 + 搜索 / 收藏夹过滤得到全部可见记录（不分页） */
export function filteredEntries() {
  const query = state.query.trim().toLowerCase();
  let list = state.entries;
  if (state.favoritesOnly) {
    list = list.filter((entry) => entry.pinned);
  }
  if (query) {
    list = list.filter((entry) => `${entry.positive || ""}`.toLowerCase().includes(query));
  }
  return list.slice().sort(comparator());
}

/** 当前每页大小（至少 1 条，避免异常值导致空页） */
function pageSize() {
  const size = Number(state.pageSize);
  return Number.isFinite(size) && size > 0 ? Math.floor(size) : PAGE_SIZES[0];
}

/** 总页数（没有记录时也返回 1，方便显示第 1 / 1 页） */
export function pageCount() {
  return Math.max(1, Math.ceil(filteredEntries().length / pageSize()));
}

/** 当前页记录；页码越界时返回最后一页，不改状态。 */
export function visibleEntries() {
  const list = filteredEntries();
  const size = pageSize();
  const maxPage = Math.max(0, Math.ceil(list.length / size) - 1);
  const page = Math.max(0, Math.min(Math.floor(state.page) || 0, maxPage));
  return list.slice(page * size, page * size + size);
}

/** 把页码收进有效范围；返回是否发生修正 */
export function clampPage() {
  const max = pageCount() - 1;
  const page = Math.max(0, Math.min(Math.floor(state.page) || 0, max));
  if (page !== state.page) {
    state.page = page;
    return true;
  }
  return false;
}

/** 图片总数 */
export function imageCount() {
  return state.entries.reduce((sum, entry) => sum + (Array.isArray(entry.images) ? entry.images.length : 0), 0);
}
