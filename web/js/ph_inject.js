/**
 * 把「面板选中项」写进图里的提示词节点：
 * 1. 本插件的「汐皮笑脸的tag历史板」；
 * 2. 「汐皮笑脸的随机tag」的提示词框（manual_prompt）。
 */

export const NODE_TYPE = "PromptHistorySelector";

/** ComfyUI-PromptTagManager 的节点类型与手动提示词框控件名 */
export const TAG_NODE_TYPE = "PromptTagSelector";
export const TAG_WIDGET_PROMPT = "manual_prompt";

const WIDGET_PROMPT = "prompt";
const WIDGET_FOLLOW = "follow_panel";

/**
 * 能接收面板选中项的节点。
 * honorFollow：节点上带「跟随面板」开关（只有本项目自己的选择器有）。
 * resize：写入后按内容重算高度。提示词框的高度是固定的，不动 TAG 节点的尺寸。
 */
const INJECT_TARGETS = [
  { type: NODE_TYPE, widget: WIDGET_PROMPT, honorFollow: true, resize: true },
  { type: TAG_NODE_TYPE, widget: TAG_WIDGET_PROMPT, honorFollow: false, resize: false },
];

function graphNodes(graph) {
  if (!graph) return [];
  if (Array.isArray(graph._nodes)) return graph._nodes;
  if (Array.isArray(graph.nodes)) return graph.nodes;
  return [];
}

export function getWidget(node, name) {
  const widgets = node && node.widgets;
  if (!Array.isArray(widgets)) return null;
  return widgets.find((widget) => widget && widget.name === name) || null;
}

/** 节点上的 follow_panel 被关掉时，不覆盖它的文本 */
export function followsPanel(node) {
  const widget = getWidget(node, WIDGET_FOLLOW);
  return !widget || widget.value !== false;
}

/** 取节点类型（新建节点时 node.type 可能还没赋值，用 comfyClass 兜底） */
function nodeTypeOf(node) {
  if (!node) return "";
  return String(node.type || (node.constructor && node.constructor.comfyClass) || "");
}

function findTargets(app) {
  const found = [];
  for (const node of graphNodes(app && app.graph)) {
    const target = INJECT_TARGETS.find((item) => item.type === nodeTypeOf(node));
    if (target) found.push({ node, target });
  }
  return found;
}

export function findSelectorNodes(app) {
  return findTargets(app)
    .filter((entry) => entry.target.type === NODE_TYPE)
    .map((entry) => entry.node);
}

/** PromptTagManager（汐皮笑脸的随机tag）的节点 */
export function findTagNodes(app) {
  return findTargets(app)
    .filter((entry) => entry.target.type === TAG_NODE_TYPE)
    .map((entry) => entry.node);
}

/**
 * 所有能接收选中项的节点：{ node, widgetName, honorFollow, resize }
 * 面板用它统计「已注入 N 个节点」（图里只有 TAG 节点时也不算「没有节点」）。
 */
export function findInjectTargets(app) {
  return findTargets(app).map((entry) => ({
    node: entry.node,
    widgetName: entry.target.widget,
    honorFollow: entry.target.honorFollow,
    resize: entry.target.resize,
  }));
}

function setWidgetValue(node, name, value) {
  const widget = getWidget(node, name);
  if (!widget) return false;
  if (widget.value === value) return false;
  widget.value = value;
  // 新版前端的 DOM 文本控件：元素里的值也一起换掉
  try {
    const input = widget.inputEl || widget.element;
    if (input && typeof input.value === "string") input.value = value;
  } catch (err) {
    /* 没有 DOM 元素也无所谓 */
  }
  try {
    if (typeof widget.callback === "function") widget.callback(value);
  } catch (err) {
    /* 回调出错不影响写入 */
  }
  return true;
}

function markDirty(node) {
  try {
    if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
  } catch (err) {
    /* ignore */
  }
}

function refreshNodeSize(app, node) {
  try {
    if (typeof node.computeSize === "function" && Array.isArray(node.size)) {
      const size = node.computeSize();
      if (Array.isArray(size) && Number.isFinite(size[1])) {
        const height = Math.max(120, size[1]);
        if (Math.abs(height - node.size[1]) > 1) {
          if (typeof node.setSize === "function") node.setSize([node.size[0], height]);
        }
      }
    }
  } catch (err) {
    /* 尺寸算不出来就算了，至少文字是对的 */
  }
  try {
    if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
  } catch (err) {
    /* ignore */
  }
}

/**
 * 记住「这个节点上我们最后注入进去的原文」。
 * TAG 节点（PromptTagManager）的提示词框是用户手写的，清空时只清我们自己写进去的那份，
 * 没注入过、或者用户后来改过的内容都不碰。
 */
const injectedText = new WeakMap();

/**
 * 把选中项写进所有能接收的节点（提示词选择器 + PromptTagManager 的提示词框）。
 * entry 为 null 时表示清空节点里的文本。
 * options.tagNodes === false 时只写自己的选择器（页面加载回填用，不动用户手写的内容）。
 */
export function applySelectionToNodes(app, entry, options = {}) {
  const targets = findInjectTargets(app);
  const positive = entry ? entry.positive || "" : "";
  const includeTagNodes = !options || options.tagNodes !== false;
  let updated = 0;
  let total = 0;

  for (const { node, widgetName, honorFollow, resize } of targets) {
    if (!honorFollow && !includeTagNodes) continue;
    total += 1;
    if (honorFollow && !followsPanel(node)) continue;

    // 清空时：只清掉上次注入、且之后没被用户改过的 TAG 提示词框
    if (!entry && !honorFollow) {
      const widget = getWidget(node, widgetName);
      if (!widget || !injectedText.has(node) || widget.value !== injectedText.get(node)) {
        injectedText.delete(node);
        continue;
      }
    }

    if (!setWidgetValue(node, widgetName, positive)) continue;
    if (entry) injectedText.set(node, positive);
    else injectedText.delete(node);
    if (resize) refreshNodeSize(app, node);
    else markDirty(node);
    updated += 1;
  }

  if (updated) {
    try {
      if (app && app.graph && typeof app.graph.setDirtyCanvas === "function") {
        app.graph.setDirtyCanvas(true, true);
      }
    } catch (err) {
      /* ignore */
    }
  }

  return { total, updated };
}

/** 在画布中央新建一个节点（按类型）；类型没注册或画布不可用时返回 null */
function createNodeAtCenter(app, type) {
  const liteGraph = typeof window !== "undefined" ? window.LiteGraph : null;
  if (!liteGraph || typeof liteGraph.createNode !== "function") return null;
  if (!app || !app.graph || typeof app.graph.add !== "function") return null;

  const node = liteGraph.createNode(type);
  if (!node) {
    console.warn("[PromptHistory] 节点类型未注册：%s", type);
    return null;
  }

  let pos = [160, 160];
  try {
    const ds = app.canvas && app.canvas.ds;
    const canvasEl = app.canvas && app.canvas.canvas;
    if (ds && canvasEl) {
      const scale = ds.scale || 1;
      const offset = ds.offset || [0, 0];
      const width = canvasEl.clientWidth || canvasEl.width || 900;
      const height = canvasEl.clientHeight || canvasEl.height || 700;
      pos = [width / 2 / scale - offset[0] - 150, height / 2 / scale - offset[1] - 120];
    }
  } catch (err) {
    pos = [160, 160];
  }

  node.pos = pos;
  app.graph.add(node);
  try {
    if (typeof app.graph.setDirtyCanvas === "function") app.graph.setDirtyCanvas(true, true);
  } catch (err) {
    /* ignore */
  }
  return node;
}

/** 在画布中央新建一个「提示词选择器」节点 */
export function ensureSelectorNode(app) {
  return createNodeAtCenter(app, NODE_TYPE);
}
