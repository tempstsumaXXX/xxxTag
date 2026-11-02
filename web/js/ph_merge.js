/**
 * 「提示词整合（多路 → 历史）」节点的前端行为：
 * 自动维护 prompt_1、prompt_2 … 输入口，末尾始终保留一个空口。
 *
 * 这里只操作 LiteGraph 的 inputs，不碰节点值；真正的拼接在后端
 * prompt_merge.py 里完成，保证提交期抽取与执行期输出一致。
 */

export const MERGE_NODE_TYPE = "PromptHistoryMerge";

const PREFIX = "prompt_";
const MIN_SLOTS = 2;
const MAX_SLOTS = 64;

/**
 * 取节点类型。
 * ComfyUI 在节点构造函数里就会触发扩展的 nodeCreated，此时 node.type 还没赋值，
 * 但 constructor.comfyClass 已经设置好了；两处都认一下，用户新建节点时才能立即生效。
 */
export function nodeTypeOf(node) {
  if (!node) return "";
  return String(node.type || node.constructor?.comfyClass || "");
}

/** prompt_1 -> 1，prompt_2 -> 2；不是提示词口时返回 null。 */
export function promptSlotIndex(name) {
  if (typeof name !== "string") return null;
  if (name === "prompt") return 0;
  const match = /^prompt_(\d+)$/.exec(name);
  return match ? Number(match[1]) : null;
}

function promptInputs(node) {
  if (!node || !Array.isArray(node.inputs)) return [];
  return node.inputs
    .map((input, position) => ({ input, position, index: promptSlotIndex(input && input.name) }))
    .filter((entry) => entry.index !== null && entry.index !== undefined);
}

function addPromptInput(node, index) {
  if (!node || typeof node.addInput !== "function") return null;
  if (promptInputs(node).some((entry) => entry.index === index)) return null;
  try {
    return node.addInput(`${PREFIX}${index}`, "STRING", { shape: 7 });
  } catch (err) {
    console.warn("[PromptHistory] 添加提示词输入失败：", err);
    return null;
  }
}

function refreshSize(node) {
  if (!node || !Array.isArray(node.size)) return;
  try {
    if (typeof node.computeSize !== "function" || typeof node.setSize !== "function") return;
    const size = node.computeSize();
    if (!Array.isArray(size) || !Number.isFinite(size[1])) return;
    const height = Math.max(60, size[1]);
    if (Math.abs(height - node.size[1]) > 1) {
      node.setSize([node.size[0], height]);
    }
  } catch (err) {
    /* 尺寸算不出来不影响连线 */
  }
}

/**
 * 手动增加一路提示词输入口。
 * 返回新增的 LiteGraph input；已经到上限或没有 addInput 时返回 null。
 */
export function addMergeInput(node) {
  if (!node || !Array.isArray(node.inputs) || typeof node.addInput !== "function") return null;
  const slots = promptInputs(node);
  const nextIndex = slots.reduce((max, entry) => Math.max(max, entry.index), 0) + 1;
  if (nextIndex > MAX_SLOTS) {
    console.warn("[PromptHistory] 提示词输入口最多 %d 路", MAX_SLOTS);
    return null;
  }
  const input = addPromptInput(node, nextIndex);
  if (!input) return null;
  refreshSize(node);
  try {
    if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
  } catch (err) {
    /* ignore */
  }
  return input;
}

/**
 * 补齐输入口：至少两个；最后一个已连接的口后面始终留一个空口。
 * 只会增加，不会自动删除用户手动加的空口。
 */
export function ensureMergeInputs(node) {
  if (!node || !Array.isArray(node.inputs) || typeof node.addInput !== "function") return 0;

  let changed = 0;

  // 1) 至少保留 prompt_1 / prompt_2 两个口。
  for (let index = 1; index <= MIN_SLOTS; index += 1) {
    if (!promptInputs(node).some((entry) => entry.index === index)) {
      if (addPromptInput(node, index)) changed += 1;
    }
  }

  // 2) 最后一个已连接的口后面没有空口时，自动补一个。
  const after = promptInputs(node);
  const connected = after.filter((entry) => entry.input && entry.input.link != null);
  const highestConnected = connected.reduce((max, entry) => Math.max(max, entry.index), 0);
  const hasSpare = after.some((entry) => entry.index > highestConnected && entry.input.link == null);
  if (!hasSpare && after.length < MAX_SLOTS) {
    const nextIndex = after.reduce((max, entry) => Math.max(max, entry.index), 0) + 1;
    if (nextIndex <= MAX_SLOTS && addPromptInput(node, nextIndex)) changed += 1;
  }

  if (changed) {
    refreshSize(node);
    try {
      if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
    } catch (err) {
      /* ignore */
    }
  }
  return changed;
}

function installAddButton(node) {
  if (!node || node.__phMergeButton || typeof node.addWidget !== "function") return;
  if (!Array.isArray(node.widgets)) return;
  node.__phMergeButton = true;
  try {
    const widget = node.addWidget(
      "button",
      "＋ 增加输入端",
      null,
      () => addMergeInput(node),
      { serialize: false }
    );
    if (widget) {
      widget.serialize = false;
      widget.tooltip = "增加一路提示词输入口，接更多文本节点。";
    }
    refreshSize(node);
    if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
  } catch (err) {
    console.warn("[PromptHistory] 添加「增加输入端」按钮失败：", err);
  }
}

function scheduleEnsure(node) {
  if (!node) return;
  if (node.__phMergeTimer) return;
  node.__phMergeTimer = setTimeout(() => {
    node.__phMergeTimer = null;
    ensureMergeInputs(node);
  }, 0);
}

/** 给新节点 / 载入节点装上自动扩容逻辑（重复调用安全）。 */
export function setupMergeNode(node) {
  if (!node || nodeTypeOf(node) !== MERGE_NODE_TYPE) return;
  if (node.__phMergeSetup) {
    ensureMergeInputs(node);
    return;
  }
  node.__phMergeSetup = true;

  installAddButton(node);
  if (typeof node.addInput === "function" && Array.isArray(node.inputs)) {
    ensureMergeInputs(node);
  } else {
    scheduleEnsure(node);
  }

  const previousChange = node.onConnectionsChange;
  node.onConnectionsChange = function onConnectionsChange() {
    const result =
      typeof previousChange === "function" ? previousChange.apply(this, arguments) : undefined;
    try {
      if (arguments[0] === 1) scheduleEnsure(this);
    } catch (err) {
      /* ignore */
    }
    return result;
  };

  const previousConfigure = node.onConfigure;
  node.onConfigure = function onConfigure() {
    const result =
      typeof previousConfigure === "function" ? previousConfigure.apply(this, arguments) : undefined;
    scheduleEnsure(this);
    return result;
  };
}
