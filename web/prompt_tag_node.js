/**
 * ComfyUI Prompt TAG Manager —— 节点与前端交互入口
 *
 * 节点上的隐藏控件 tag_config 保存「词库名 + 已选/随机池」的 JSON 配置，
 * 面板（浮动窗口）负责可视化编辑这份配置。
 */

import { app } from "../../scripts/app.js";
import { openTagWindow, closeTagWindow, getTagWindow, closeAllTagWindows } from "./js/tag_window.js";
import * as ops from "./js/lib_ops.js";
import { toast } from "./js/tag_dialogs.js";

const NODE_TYPES = new Set(["PromptTagSelector"]);
const CONFIG_WIDGET = "tag_config";
const PREVIEW_WIDGET = "prompt_preview";
const PROP_KEY = "prompt_tag_config";
const PROP_LAST_KEY = "prompt_tag_last";
const OPTION_WIDGETS = [
  "separator",
  "dedupe",
  "underscore_to_space",
  "weight_style",
  "manual_prompt",
  "manual_mode",
  "manual_space_as_sep",
  "natural_prompt",
  "natural_append",
];
// 工作流会把这些字符串整段存进文件/浏览器存档，太大就会拖垮保存
const MAX_PREVIEW_CHARS = 1200;
const MAX_LAST_CHARS = 400;
const MAX_CONFIG_CHARS = 64 * 1024;

/* --------------------------------------------------------------- 样式注入 */

function injectStyles() {
  const href = new URL("./css/prompt_tag.css", import.meta.url).href;
  const existing = document.querySelector('link[data-ptm-style="1"]');
  if (existing) {
    if (existing.href !== href) existing.href = href;
    return;
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.ptmStyle = "1";
  document.head.appendChild(link);
}

/* --------------------------------------------------------------- 小工具 */

function findWidget(node, name) {
  if (!node || !node.widgets) return null;
  return node.widgets.find((w) => w && w.name === name) || null;
}

function hideWidget(widget) {
  if (!widget || widget.__ptmHidden) return;
  widget.__ptmHidden = true;
  widget.origType = widget.type;
  widget.origComputeSize = widget.computeSize;
  widget.computeSize = () => [0, -4];
  widget.type = "hidden";
  widget.hidden = true;
  widget.serializeValue = () => widget.value;
}

function readConfig(node) {
  const widget = findWidget(node, CONFIG_WIDGET);
  let raw = widget ? widget.value : null;
  if ((raw === null || raw === undefined || raw === "") && node.properties) {
    raw = node.properties[PROP_KEY];
  }
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const cfg = JSON.parse(raw);
      if (cfg && typeof cfg === "object") return cfg;
    } catch (err) {
      /* 忽略坏配置 */
    }
  }
  return { v: 1, library: "", items: [] };
}

function writeConfig(node, config) {
  let text = JSON.stringify(config);

  // 兜底：万一还残留着「内嵌上千条候选」的老随机池，这里就地清掉，
  // 避免把工作流/浏览器存档撑爆（ComfyUI 会保存失败）。
  if (text.length > MAX_CONFIG_CHARS && Array.isArray(config.items)) {
    let stripped = 0;
    for (const it of config.items) {
      if (it && it.kind === "pool" && Array.isArray(it.tags) && it.tags.length) {
        if (!it.size) it.size = it.tags.length;
        it.tags = [];
        stripped += 1;
      }
    }
    if (stripped) {
      text = JSON.stringify(config);
      console.warn("[PromptTag] 已清掉 %d 个随机池里内嵌的候选列表（改为执行时按引用读取）", stripped);
    }
  }

  const widget = findWidget(node, CONFIG_WIDGET);
  if (widget) widget.value = text;
  if (!node.properties) node.properties = {};
  node.properties[PROP_KEY] = text;
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
  if (text.length > 32 * 1024) {
    console.warn(
      `[PromptTag] 节点配置有 ${(text.length / 1024).toFixed(1)} KB，偏大，可能拖慢/影响 ComfyUI 的工作流保存。` +
        "随机池已只存引用，若仍这么大通常是选了非常多的 tag。"
    );
  }
  return text.length;
}

function getOptions(node) {
  const get = (name, fallback) => {
    const w = findWidget(node, name);
    return w ? w.value : fallback;
  };
  const separatorRaw = get("separator", ", ");
  const separator = separatorRaw === null || separatorRaw === undefined ? ", " : String(separatorRaw);
  return {
    separator: separator.replace(/\\n/g, "\n").replace(/\\t/g, "\t"),
    dedupe: get("dedupe", true) !== false,
    underscoreToSpace: get("underscore_to_space", true) !== false,
    weightStyle: get("weight_style", ops.DEFAULT_WEIGHT_STYLE) || ops.DEFAULT_WEIGHT_STYLE,
  };
}

function getSeed(node) {
  const w = findWidget(node, "seed");
  return w ? Number(w.value) || 0 : 0;
}

function setSeed(node, value) {
  const w = findWidget(node, "seed");
  if (!w) return;
  w.value = value;
  node.setDirtyCanvas?.(true, true);
}

/* ------------------------------------------------------- 手动提示词框 */

function getManualPrompt(node) {
  const w = findWidget(node, "manual_prompt");
  return w && typeof w.value === "string" ? w.value : "";
}

function setManualPrompt(node, text) {
  const w = findWidget(node, "manual_prompt");
  if (!w) return;
  w.value = text || "";
  node.setDirtyCanvas?.(true, true);
  refreshPreview(node);
}

function getManualMode(node) {
  const w = findWidget(node, "manual_mode");
  const value = w ? w.value : null;
  return ops.MANUAL_MODES.includes(value) ? value : ops.DEFAULT_MANUAL_MODE;
}

function setManualMode(node, mode) {
  const w = findWidget(node, "manual_mode");
  if (!w) return;
  w.value = ops.MANUAL_MODES.includes(mode) ? mode : ops.DEFAULT_MANUAL_MODE;
  node.setDirtyCanvas?.(true, true);
  refreshPreview(node);
}

function getSpaceAsSep(node) {
  const w = findWidget(node, "manual_space_as_sep");
  return w ? w.value !== false : false;
}

function setSpaceAsSep(node, value) {
  const w = findWidget(node, "manual_space_as_sep");
  if (!w) return;
  w.value = Boolean(value);
  node.setDirtyCanvas?.(true, true);
  refreshPreview(node);
}

function getNaturalPrompt(node) {
  const w = findWidget(node, "natural_prompt");
  return w && typeof w.value === "string" ? w.value : "";
}

function setNaturalPrompt(node, text) {
  const w = findWidget(node, "natural_prompt");
  if (!w) return;
  w.value = text || "";
  node.setDirtyCanvas?.(true, true);
  refreshPreview(node);
}

function getNaturalAppend(node) {
  const w = findWidget(node, "natural_append");
  return w ? w.value !== false : false;
}

function setNaturalAppend(node, value) {
  const w = findWidget(node, "natural_append");
  if (!w) return;
  w.value = Boolean(value);
  node.setDirtyCanvas?.(true, true);
  refreshPreview(node);
}

/* ------------------------------------------------------- 控件值自愈 */

const STRING_WIDGETS = {
  separator: ", ",
  manual_prompt: "",
  natural_prompt: "",
  tag_config: "",
};
const BOOL_WIDGETS = {
  dedupe: true,
  underscore_to_space: true,
  manual_space_as_sep: false,
  natural_append: false,
};

// 旧版节点的 widgets_values 顺序，用于无缝迁移到「无 seed_mode / 无前后缀」的新布局
const LEGACY_SEED_MODE_VALUES = {
  固定: "fixed",
  每次随机: "randomize",
  递增: "increment",
  fixed: "fixed",
  randomize: "randomize",
  random: "randomize",
  increment: "increment",
  decrement: "decrement",
};

// 「选项值」不是用户写的内容：老工作流控件错位时，separator / natural_prompt
// 槽位可能拿到 control_after_generate、manual_mode 或 weight_style 的值。
const CONTROL_VALUES = new Set([
  "fixed",
  "randomize",
  "increment",
  "decrement",
  "固定",
  "每次随机",
  "递增",
  "递减",
  "随机",
]);

function looksLikeOptionValue(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return (
    CONTROL_VALUES.has(text) ||
    ops.MANUAL_MODES.includes(text) ||
    ops.WEIGHT_STYLES.includes(text)
  );
}

function migrateLegacyWidgets(node, info) {
  const values = info && Array.isArray(info.widgets_values) ? info.widgets_values : null;
  if (!values || values.length !== 15) return false;
  const legacyMode = values[2];
  if (typeof legacyMode !== "string") return false;
  const control = LEGACY_SEED_MODE_VALUES[legacyMode.trim()];
  if (!control) return false;

  const prefix = typeof values[7] === "string" ? values[7] : "";
  const suffix = typeof values[8] === "string" ? values[8] : "";
  const oldManual = typeof values[10] === "string" ? values[10] : "";
  const mapping = {
    tag_config: values[0],
    seed: values[1],
    control_after_generate: control,
    separator: values[3],
    dedupe: values[4],
    underscore_to_space: values[5],
    weight_style: values[6],
    manual_mode: values[9],
    // 被删掉的前后缀内容合并进手动提示词框，避免老工作流丢词
    manual_prompt: prefix || suffix ? prefix + oldManual + suffix : oldManual,
    manual_space_as_sep: values[11],
    natural_prompt: values[12],
    natural_append: values[13],
    prompt_preview: values[14],
  };
  for (const widget of node.widgets || []) {
    if (widget && Object.prototype.hasOwnProperty.call(mapping, widget.name)) {
      widget.value = mapping[widget.name];
    }
  }
  node.properties = node.properties || {};
  node.properties.__ptmLegacyMigrated = true;
  console.warn("[PromptTag] 已迁移旧版节点参数（移除 seed_mode / 前后缀控件）。");
  return true;
}

/**
 * 修复错位的控件值。
 * ComfyUI 加载工作流是按位置把 widgets_values 填进控件的，如果节点后来在中间加过参数，
 * 老工作流的值就会整体串位（例如 separator 变成 True）。这里按类型纠回来。
 */
function sanitizeWidgets(node) {
  let fixed = 0;
  for (const [name, fallback] of Object.entries(STRING_WIDGETS)) {
    const w = findWidget(node, name);
    if (!w) continue;
    if (typeof w.value !== "string") {
      w.value = fallback;
      fixed += 1;
    }
  }
  for (const [name, fallback] of Object.entries(BOOL_WIDGETS)) {
    const w = findWidget(node, name);
    if (!w) continue;
    if (typeof w.value !== "boolean") {
      w.value = fallback;
      fixed += 1;
    }
  }
  // separator 里不该出现 "每次随机 / randomize" 这类控件选项值（老工作流串位），
  // 自然语言框也不该出现 "两者结合（…）" 这种模式名，见到就改回默认值。
  const separatorWidget = findWidget(node, "separator");
  if (separatorWidget && looksLikeOptionValue(separatorWidget.value)) {
    separatorWidget.value = ", ";
    fixed += 1;
  }
  const naturalWidget = findWidget(node, "natural_prompt");
  if (naturalWidget && looksLikeOptionValue(naturalWidget.value)) {
    naturalWidget.value = "";
    fixed += 1;
  }
  const seedWidget = findWidget(node, "seed");
  if (seedWidget && typeof seedWidget.value !== "number") {
    const raw = seedWidget.value;
    let n = 0;
    if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
      n = Number(raw);
    }
    seedWidget.value = Math.max(0, Math.trunc(n));
    fixed += 1;
  }
  const weightWidget = findWidget(node, "weight_style");
  if (weightWidget && !ops.WEIGHT_STYLES.includes(weightWidget.value)) {
    weightWidget.value = ops.DEFAULT_WEIGHT_STYLE;
    fixed += 1;
  }
  const modeWidget = findWidget(node, "manual_mode");
  if (modeWidget && !ops.MANUAL_MODES.includes(modeWidget.value)) {
    modeWidget.value = ops.DEFAULT_MANUAL_MODE;
    fixed += 1;
  }
  if (fixed) {
    console.warn(
      "[PromptTag] 已修复 %d 个错位的控件值（多半是旧版本保存的工作流，参数顺序变了）。" +
        "建议确认一下节点参数后重新保存工作流。",
      fixed
    );
    node.setDirtyCanvas?.(true, true);
  }
  return fixed;
}

/** 刷新节点上的只读预览控件 */
function refreshPreview(node) {
  const widget = findWidget(node, PREVIEW_WIDGET);
  if (!widget) return;
  const cfg = readConfig(node);
  const opts = getOptions(node);
  const mode = getManualMode(node);
  let tagText = "";
  try {
    const out = ops.previewPrompt(cfg.items || [], opts);
    tagText = out.text;
    if (out.poolCount) tagText = `🎲 含 ${out.poolCount} 个随机池（执行时按 seed 抽取）\n` + tagText;
  } catch (err) {
    tagText = "";
  }
  let text = ops.combinePrompt({
    manual: getManualPrompt(node),
    tagPrompt: tagText,
    mode,
    separator: opts.separator,
    spaceAsSeparator: getSpaceAsSep(node),
    natural: getNaturalPrompt(node),
    naturalAppend: getNaturalAppend(node),
  });
  // 预览只是给人看的，限制长度避免它把工作流撑大（真实输出不受影响）
  if (text.length > MAX_PREVIEW_CHARS) {
    text = text.slice(0, MAX_PREVIEW_CHARS) + `\n…（预览已截断，共 ${text.length} 字）`;
  }
  widget.value = text || "";
  node.setDirtyCanvas?.(true, true);
}

function makeHost(node, nodeLabel) {
  return {
    onConfigChange: (config) => {
      writeConfig(node, config);
      refreshPreview(node);
    },
    getOptions: () => getOptions(node),
    getSeed: () => getSeed(node),
    setSeed: (v) => setSeed(node, v),
    getManualPrompt: () => getManualPrompt(node),
    setManualPrompt: (text) => setManualPrompt(node, text),
    getManualMode: () => getManualMode(node),
    setManualMode: (mode) => setManualMode(node, mode),
    getSpaceAsSep: () => getSpaceAsSep(node),
    setSpaceAsSep: (value) => setSpaceAsSep(node, value),
    getNaturalPrompt: () => getNaturalPrompt(node),
    setNaturalPrompt: (text) => setNaturalPrompt(node, text),
    getNaturalAppend: () => getNaturalAppend(node),
    setNaturalAppend: (value) => setNaturalAppend(node, value),
    label: nodeLabel,
  };
}

function nodeTitle(node) {
  return (node.title || "随机 TAG 提示词").replace(/^🏷\s*/, "");
}

function openPanel(node) {
  const config = readConfig(node);
  openTagWindow({
    nodeId: node.id,
    title: nodeTitle(node) + `　#${node.id}`,
    config,
    host: makeHost(node, nodeTitle(node)),
    onClose: () => {},
  });
}

/* --------------------------------------------------------------- 扩展 */

injectStyles();

app.registerExtension({
  name: "PromptTagManager.Node",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_TYPES.has(nodeData.name)) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      const node = this;

      // 隐藏配置控件
      hideWidget(findWidget(node, CONFIG_WIDGET));

      // 预览控件只读化
      const previewWidget = findWidget(node, PREVIEW_WIDGET);
      if (previewWidget) {
        previewWidget.disabled = true;
        previewWidget.options = Object.assign({}, previewWidget.options, { readOnly: true });
      }

      // 按钮
      node.addWidget(
        "button",
        "🏷 打开Tag词库面板",
        null,
        () => openPanel(node),
        { serialize: false }
      );
      node.addWidget(
        "button",
        "🎲 换一个随机种子",
        null,
        () => {
          const next = Math.floor(Math.random() * 0xffffffff);
          setSeed(node, next);
          refreshPreview(node);
          const win = getTagWindow(node.id);
          if (win) win.editor.renderPreview();
          toast("随机种子 → " + next);
        },
        { serialize: false }
      );
      node.addWidget(
        "button",
        "🧹 清空已选 tag",
        null,
        () => {
          const cfg = readConfig(node);
          cfg.items = [];
          writeConfig(node, cfg);
          refreshPreview(node);
          const win = getTagWindow(node.id);
          if (win) win.editor.setConfig(cfg);
          toast("已清空节点上的已选 tag");
        },
        { serialize: false }
      );

      // 选项变化时刷新预览
      for (const name of OPTION_WIDGETS) {
        const widget = findWidget(node, name);
        if (!widget) continue;
        const orig = widget.callback;
        widget.callback = function (...args) {
          const r = orig ? orig.apply(this, args) : undefined;
          refreshPreview(node);
          const win = getTagWindow(node.id);
          if (win && win.editor) {
            // 控件可能被别的插件（例如「提示词历史」）直接写入，
            // 打开的面板里也要显示同一份内容，避免两边不一致。
            if (typeof win.editor.refreshManualFromHost === "function") {
              win.editor.refreshManualFromHost();
            }
            if (typeof win.editor.renderManualSegments === "function") {
              win.editor.renderManualSegments();
            }
            win.editor.renderPreview();
          }
          return r;
        };
      }

      // 初始尺寸
      if (node.size && node.size[0] < 320) node.size[0] = 340;
      node.color = node.color || "#243447";
      node.bgcolor = node.bgcolor || "#1c2733";

      writeConfig(node, readConfig(node));
      refreshPreview(node);

      const onConfigure = node.onConfigure;
      node.onConfigure = function (info) {
        const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
        const self = this;
        // 控件值可能在 onConfigure 之后才写入，稍后再同步一次
        setTimeout(() => {
          hideWidget(findWidget(self, CONFIG_WIDGET));
          migrateLegacyWidgets(self, info);
          sanitizeWidgets(self); // 老工作流参数错位时自愈
          writeConfig(self, readConfig(self));
          refreshPreview(self);
          const win = getTagWindow(self.id);
          if (win) win.editor.setConfig(readConfig(self));
        }, 0);
        return r;
      };

      const onExecuted = node.onExecuted;
      node.onExecuted = function (message) {
        const r = onExecuted ? onExecuted.apply(this, arguments) : undefined;
        try {
          const text = message && message.text && message.text[0];
          if (typeof text === "string") {
            this.properties = this.properties || {};
            // 只留一小段做记录，避免把执行结果整段写进工作流
            this.properties[PROP_LAST_KEY] =
              text.length > MAX_LAST_CHARS ? text.slice(0, MAX_LAST_CHARS) + "…" : text;
            const widget = findWidget(this, PREVIEW_WIDGET);
            if (widget) {
              widget.value =
                text.length > MAX_PREVIEW_CHARS
                  ? text.slice(0, MAX_PREVIEW_CHARS) + `\n…（预览已截断，共 ${text.length} 字，完整内容见节点输出）`
                  : text;
              this.setDirtyCanvas?.(true, true);
            }
          }
        } catch (err) {
          console.warn("[PromptTag] onExecuted 处理失败", err);
        }
        return r;
      };

      const onRemoved = node.onRemoved;
      node.onRemoved = function () {
        closeTagWindow(this.id);
        return onRemoved ? onRemoved.apply(this, arguments) : undefined;
      };

      return result;
    };
  },

  async setup() {
    // 页面卸载时关掉所有面板，避免热重载后残留窗口
    window.addEventListener("beforeunload", () => {
      try {
        closeAllTagWindows();
      } catch (err) {
        /* ignore */
      }
    });
  },
});

console.log("[PromptTag] 前端扩展已加载");
