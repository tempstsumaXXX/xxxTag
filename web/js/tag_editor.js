/**
 * 三级分类 TAG 编辑器（一级分类 / 二级分类 / 子项）。
 * 纯 DOM 实现，不依赖任何框架与构建步骤。
 */

import { h, clear, makeSortable, debounce } from "./dom.js";
import * as ops from "./lib_ops.js";
import * as api from "./tag_api.js";
import {
  toast,
  confirmDialog,
  promptDialog,
  importDialog,
  exportDialog,
  batchTagsDialog,
  nameDialog,
  translateSettingsDialog,
} from "./tag_dialogs.js";

const MIN_WEIGHT = 0.05;
const MAX_WEIGHT = 10;
const CHIP_PAGE = 400;          // 一次最多渲染多少个 tag 胶囊
const MAX_SEARCH_HITS = 2000;   // 搜索结果上限，防止超大词库卡死
const LS_SHOW_DESC = "ptm.show.desc.v1";

function readFlag(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "1";
  } catch (err) {
    return fallback;
  }
}

function writeFlag(key, value) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch (err) {
    /* ignore */
  }
}

function key(text) {
  return String(text || "").toLowerCase();
}

function iconBtn(glyph, title, onClick, cls = "") {
  return h(
    "button",
    {
      class: `ptm-mini ${cls}`,
      title,
      onclick: (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        onClick(ev);
      },
    },
    glyph
  );
}

export class TagEditor {
  /**
   * @param {{onConfigChange?:Function, getOptions?:Function, getSeed?:Function, setSeed?:Function, onRequestClose?:Function}} host
   */
  constructor(host = {}) {
    this.host = host;
    this.state = {
      status: "loading",
      mode: "unknown",
      libraryName: "",
      kind: "user",
      library: ops.emptyLibrary(),
      items: [],
      ui: { group: null, sub: null, search: "" },
      error: "",
    };
    this.libraries = [];
    this.dataDir = "";
    this.els = {};
    this.mounted = false;
    this.randomPreviewText = "";
    this.randomPreviewSeed = null;
    this.libDirty = false;
    this._dirtySeq = 0;
    this._saveChain = Promise.resolve();
    this.showDesc = readFlag(LS_SHOW_DESC, true);
    this.chipLimit = CHIP_PAGE;
    this._descVersion = 0;     // 词库里的翻译改动时 +1，用来失效「分段翻译」索引
    this._descIndexCache = null;
    this.apiDescs = new Map(); // 翻译接口返回的译文（tag小写 → 译文），只用于显示
    this.customDescs = new Map(); // 本地自定义译文（.custom_descs.json，tag小写 → 译文）
    this.saveTimer = debounce(() => this.saveLibraryNow(), 900);
    this.searchTimer = debounce((value) => this.setSearch(value), 220);
    this.pendingConfig = null;
  }

  /* ------------------------------------------------------------- 生命周期 */

  async mount(container) {
    this.container = container;
    this.buildSkeleton();
    this.mounted = true;
    this.renderAll();
    try {
      const st = await api.getState();
      this.state.mode = st.mode;
      this.dataDir = st.dataDir || "";
      this.libraries = st.libraries || [];
      const wanted =
        (this.pendingConfig && this.pendingConfig.library) ||
        api.getRememberedLibrary() ||
        st.default ||
        (this.libraries[0] && this.libraries[0].name) ||
        "";
      let loaded = false;
      if (wanted) {
        loaded = await this.switchLibrary(wanted, { silent: true });
        if (!loaded) {
          // 记住的词库可能已经被删除/改名，退回默认词库，别让面板空着
          const fallback = st.default || (this.libraries[0] && this.libraries[0].name) || "";
          if (fallback && fallback !== wanted) {
            loaded = await this.switchLibrary(fallback, { silent: true });
            if (loaded) toast(`词库「${wanted}」不存在，已切换到「${fallback}」`, "err");
          }
          if (!loaded) {
            this.state.status = "ready";
            this.state.libraryName = "默认词库";
            this.state.library = ops.emptyLibrary("默认词库");
            this.renderAll();
          }
        }
      } else {
        // 一份词库都没有：给一个空词库，至少能用
        this.state.status = "ready";
        this.state.libraryName = "默认词库";
        this.state.library = ops.emptyLibrary("默认词库");
        this.renderAll();
      }
      if (this.pendingConfig) {
        const cfg = this.pendingConfig;
        this.pendingConfig = null;
        this.applyItems(cfg.items || []);
      }
      // 本地自定义译文（只有服务端模式才有地方存）
      if (this.state.mode === "server") {
        await this.loadCustomDescs();
        this.renderManualSegments();
        this.renderSelected();
      }
    } catch (err) {
      this.state.status = "error";
      this.state.error = err && err.message ? err.message : String(err);
      this.renderAll();
    }
    // 顺手清理历史遗留的浏览器本地词库（它可能占满 localStorage 导致 ComfyUI 存不了工作流）
    if (api.apiState && api.apiState.freedBytes > 0) {
      toast(
        `已清理 ${(api.apiState.freedBytes / 1024).toFixed(0)} KB 旧的浏览器词库缓存（之前可能占满存储导致 ComfyUI 保存失败）`,
        "ok"
      );
    }
    return this;
  }

  unmount() {
    this.saveTimer.cancel();
    this.mounted = false;
    if (this.libDirty) this.saveLibraryNow();
    if (this.root && this.root.parentElement) this.root.parentElement.removeChild(this.root);
  }

  /** 从节点配置恢复（载入工作流 / 打开窗口时调用） */
  setConfig(config) {
    if (!config) return;
    const cfg = typeof config === "string" ? safeJson(config) : config;
    if (!cfg) return;
    if (!this.mounted) {
      this.pendingConfig = cfg;
      return;
    }
    if (cfg.library && cfg.library !== this.state.libraryName) {
      // 词库可能还没加载好，交给 switchLibrary 后再应用 items
      this.pendingConfig = cfg;
      this.switchLibrary(cfg.library, { silent: true }).then(() => {
        const pending = this.pendingConfig;
        this.pendingConfig = null;
        if (pending) this.applyItems(pending.items || []);
      });
      return;
    }
    this.applyItems(cfg.items || []);
  }

  applyItems(items) {
    this.state.items = (items || []).map((it, idx) => ({
      id: `it_${Date.now()}_${idx}`,
      kind: it.kind === "pool" ? "pool" : "tag",
      text: it.text || "",
      label: it.label || "",
      library: it.library || "",
      group: it.group || "",
      sub: it.sub || "",
      count: Number(it.count) || 1,
      weight: Number(it.weight) > 0 ? Number(it.weight) : 1,
      enabled: it.enabled !== false,
      tags: Array.isArray(it.tags) ? it.tags.slice() : [],
      size: Number(it.size) || (Array.isArray(it.tags) ? it.tags.length : 0),
    }));
    // 先把老工作流里「内嵌了上千条候选」的随机池换成引用，再补全候选用于预览
    this.migratePoolsToRefs();
    this.hydratePools();
    this.renderAll();
  }

  /** 找出候选 tag 完全一致的那个二级分类（用来给老随机池补上引用） */
  findSubByTags(tags) {
    const lib = this.state.library;
    if (!lib || !tags || !tags.length) return null;
    const probe = tags.slice(0, 5);
    for (const g of lib.groups || []) {
      for (const s of g.subs || []) {
        const st = s.tags || [];
        if (st.length !== tags.length) continue;
        const set = new Set(st);
        if (probe.every((t) => set.has(t))) return { group: g.name, sub: s.name };
      }
    }
    return null;
  }

  /**
   * 老格式随机池（自带上千条候选）→ 引用格式。
   * 这能把已有工作流从几百 KB~几 MB 直接降到几百字节，解决 ComfyUI 保存失败。
   */
  migratePoolsToRefs() {
    let changed = 0;
    for (const item of this.state.items) {
      if (item.kind !== "pool") continue;
      const embedded = Array.isArray(item.tags) ? item.tags : [];
      if (!embedded.length) continue;
      // 已经有库引用：直接丢掉内嵌候选
      if (item.library && item.group) {
        item.size = embedded.length;
        item.tags = [];
        changed += 1;
        continue;
      }
      let gname = item.group;
      let sname = item.sub;
      if ((!gname || !sname) && this.state.library) {
        const hit = this.findSubByTags(embedded);
        if (hit) {
          gname = hit.group;
          sname = hit.sub;
        }
      }
      if (gname && sname && this.state.libraryName) {
        item.library = item.library || this.state.libraryName;
        item.group = gname;
        item.sub = sname;
        item.size = embedded.length;
        item.tags = [];
        changed += 1;
      }
    }
    if (changed) {
      console.info("[PromptTag] 已把 %d 个随机池改为「只存引用」，节点体积会明显变小", changed);
    }
    return changed;
  }

  getConfig() {
    return {
      v: 1,
      library: this.state.libraryName,
      items: this.state.items.map((it) => {
        if (it.kind !== "pool") {
          return { kind: "tag", text: it.text, group: it.group, sub: it.sub, weight: it.weight, enabled: it.enabled };
        }
        // 随机池只存引用（库/一级/二级）：候选动辄上千条提示词，
        // 内嵌进节点会把工作流撑到几百 KB ~ 几 MB，进而写满 localStorage，
        // 导致 ComfyUI 自动保存工作流失败。
        const out = {
          kind: "pool",
          label: it.label,
          group: it.group,
          sub: it.sub,
          count: it.count,
          weight: it.weight,
          enabled: it.enabled,
        };
        out.library = it.library || this.state.libraryName;
        const size = (it.tags || []).length || it.size || 0;
        if (size) out.size = size;
        // 没有库引用的历史数据才带上候选，否则执行时无从解析
        if (!out.library || !it.group) out.tags = it.tags || [];
        return out;
      }),
    };
  }

  /** 把「只存引用」的随机池候选按当前词库补全（用于预览/导出），不写回节点 */
  hydratePools() {
    for (const item of this.state.items) {
      if (item.kind !== "pool") continue;
      if (item.tags && item.tags.length) {
        item.size = item.tags.length;
        continue;
      }
      const sameLib = !item.library || item.library === this.state.libraryName;
      const tags = [];
      if (sameLib && this.state.library) {
        for (const g of this.state.library.groups || []) {
          if (item.group && g.name !== item.group) continue;
          for (const s of g.subs || []) {
            if (item.sub && item.sub !== "*" && s.name !== item.sub) continue;
            tags.push(...(s.tags || []));
          }
        }
      }
      item.tags = tags;
      item.size = tags.length || item.size || 0;
    }
  }

  /** 导出当前已选 tag 组成的小词库（导出弹窗用） */
  buildSelectedLibrary() {
    const lib = ops.emptyLibrary(this.state.libraryName || "已选 tag");
    for (const item of this.state.items) {
      if (item.enabled === false) continue;
      const gname = item.group || "已选 tag";
      const sname = item.sub || "默认";
      let group = lib.groups.find((g) => g.name === gname);
      if (!group) {
        group = { name: gname, subs: [] };
        lib.groups.push(group);
      }
      let sub = group.subs.find((s) => s.name === sname);
      if (!sub) {
        sub = { name: sname, tags: [] };
        group.subs.push(sub);
      }
      if (item.kind === "pool") sub.tags.push(...(item.tags || []));
      else sub.tags.push(item.text);
    }
    lib.groups.forEach((g) => g.subs.forEach((s) => (s.tags = ops.dedupeTags(s.tags))));
    return lib;
  }

  /* --------------------------------------------------------------- 骨架 */

  buildSkeleton() {
    const root = h("div", { class: "ptm-root" });
    this.root = root;

    /* --- 工具条 --- */
    const libSelect = h("select", { class: "ptm-select", title: "切换词库" });
    libSelect.addEventListener("change", () => this.switchLibrary(libSelect.value));

    const searchInput = h("input", {
      class: "ptm-input",
      placeholder: "搜索 tag / 分类（支持回车定位）",
      spellcheck: "false",
    });
    const searchWrap = h(
      "div",
      { class: "ptm-search-wrap" },
      h("span", { class: "ptm-search-icon" }, "🔍"),
      searchInput,
      h(
        "button",
        {
          class: "ptm-search-clear",
          title: "清空搜索",
          onclick: () => {
            searchInput.value = "";
            this.setSearch("");
          },
        },
        "✕"
      )
    );
    searchInput.addEventListener("input", () => {
      // 输入时只做即时视觉反馈，真正的过滤延迟 220ms，避免超大词库每次按键全表扫描
      searchWrap.classList.toggle("has-value", Boolean(searchInput.value));
      this.searchTimer(searchInput.value);
    });
    searchInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        searchInput.value = "";
        this.searchTimer.cancel();
        this.setSearch("");
      }
    });

    const matchInfo = h("span", { class: "ptm-badge" }, "0");
    const saveState = h("span", { class: "ptm-badge" }, "就绪");

    const descToggle = h(
      "button",
      {
        class: `ptm-btn small ${this.showDesc ? "primary" : ""}`,
        title: "在 tag 旁边显示中文翻译（也可以用中文搜索 tag）",
        onclick: () => {
          this.showDesc = !this.showDesc;
          writeFlag(LS_SHOW_DESC, this.showDesc);
          descToggle.className = `ptm-btn small ${this.showDesc ? "primary" : ""}`;
          descToggle.textContent = this.showDesc ? "中 已开" : "中 已关";
          this.renderTags();
        },
      },
      this.showDesc ? "中 已开" : "中 已关"
    );

    const row1 = h(
      "div",
      { class: "ptm-toolbar-row" },
      h("span", { class: "ptm-badge accent" }, "词库"),
      libSelect,
      h("button", { class: "ptm-btn small", title: "新建词库", onclick: () => this.createLibrary() }, "＋ 新建"),
      h("button", { class: "ptm-btn small", title: "重命名词库", onclick: () => this.renameLibraryNow() }, "✎ 重命名"),
      h("button", { class: "ptm-btn small danger", title: "删除词库", onclick: () => this.deleteLibraryNow() }, "🗑 删除"),
      h("span", { class: "ptm-sep" }),
      h("button", { class: "ptm-btn small", title: "批量导入 tag", onclick: () => this.doImport() }, "📥 导入"),
      h("button", { class: "ptm-btn small", title: "批量导出 tag", onclick: () => this.doExport() }, "📤 导出"),
      h("span", { class: "ptm-grow" }),
      saveState
    );

    const row2 = h(
      "div",
      { class: "ptm-toolbar-row" },
      searchWrap,
      matchInfo,
      h("span", { class: "ptm-grow" }),
      descToggle,
      h("button", { class: "ptm-btn small", title: "按当前种子抽取一次，仅预览", onclick: () => this.doRandomPreview() }, "🎲 预览抽取"),
      h("button", { class: "ptm-btn small danger", title: "清空已选 tag", onclick: () => this.clearItems() }, "🧹 清空已选")
    );

    const toolbar = h("div", { class: "ptm-toolbar" }, row1, row2);
    const banner = h("div", { class: "ptm-banner", style: { display: "none" } });

    /* --- 三栏 --- */
    const colG = h("div", { class: "ptm-col ptm-col-1" });
    const colS = h("div", { class: "ptm-col ptm-col-2" });
    const colT = h("div", { class: "ptm-col ptm-col-3" });
    const cols = h("div", { class: "ptm-cols" }, colG, colS, colT);

    /* --- 已选 --- */
    const selectedHead = h("div", { class: "ptm-selected-head" });
    const selectedBody = h("div", { class: "ptm-selected-body" });
    const selected = h("div", { class: "ptm-selected" }, selectedHead, selectedBody);

    // 拖拽排序只绑定一次（容器是常驻节点）
    makeSortable(selectedBody, (from, to) => {
      if (from === to) return;
      const [moved] = this.state.items.splice(from, 1);
      if (!moved) return;
      this.state.items.splice(Math.max(0, Math.min(to, this.state.items.length)), 0, moved);
      this.emitConfig();
      this.renderSelected();
      this.renderPreview();
    });

    /* --- 手动提示词框 --- */
    const manualArea = h("textarea", {
      class: "ptm-textarea ptm-manual-input",
      placeholder:
        "在这里手动写提示词，支持 (tag:1.2) 权重语法和换行。\n例如：masterpiece, best quality, (1girl:1.2), long hair",
    });
    const manualModeSelect = h("select", { class: "ptm-select", title: "提示词框与 TAG 词库怎么组合" });
    for (const mode of ops.MANUAL_MODES) {
      manualModeSelect.appendChild(h("option", { value: mode }, mode));
    }
    manualModeSelect.value = ops.DEFAULT_MANUAL_MODE;
    const manualMeta = h("span", { class: "ptm-badge" }, "0 字");
    const spaceCheck = h("input", { type: "checkbox" });
    const spaceLabel = h(
      "label",
      { class: "ptm-check", title: "把提示词框里 tag 之间的空格/换行换成连接符（注意会把 best quality 这类多词 tag 拆开）" },
      spaceCheck,
      "空格转连接符"
    );
    const manualHead = h(
      "div",
      { class: "ptm-manual-head" },
      h("span", { class: "ptm-badge accent" }, "提示词框"),
      h("span", { class: "ptm-grow" }),
      manualMeta,
      spaceLabel,
      manualModeSelect,
      h(
        "button",
        { class: "ptm-btn small", title: "统一连接符、去掉多余空格与空项", onclick: () => this.editManualText("tidy") },
        "整理"
      ),
      h(
        "button",
        { class: "ptm-btn small", title: "删掉重复的段（忽略大小写）", onclick: () => this.editManualText("dedupe") },
        "去重"
      ),
      h(
        "button",
        { class: "ptm-btn small", title: "删掉最后一段", onclick: () => this.editManualText("pop") },
        "删末尾"
      ),
      h(
        "button",
        {
          class: "ptm-btn small danger",
          title: "清空提示词框",
          onclick: () => {
            manualArea.value = "";
            manualMeta.textContent = "0 字";
            this.setManualPrompt("");
          },
        },
        "清空"
      )
    );
    const manualBox = h("div", { class: "ptm-manual" }, manualHead, manualArea);

    /* --- 自然语言描述框 --- */
    const naturalArea = h("textarea", {
      class: "ptm-textarea ptm-natural-input",
      placeholder:
        "自然语言描述（不会被空格拆分/去重）\n例如：a girl standing in the rain, cinematic lighting, film grain",
    });
    const naturalCheck = h("input", { type: "checkbox" });
    const naturalLabel = h(
      "label",
      { class: "ptm-check", title: "是否把这段自然语言描述接到 tag 末尾" },
      naturalCheck,
      "组合在末尾"
    );
    const naturalMeta = h("span", { class: "ptm-badge" }, "0 字");
    const naturalHead = h(
      "div",
      { class: "ptm-manual-head" },
      h("span", { class: "ptm-badge accent" }, "自然语言"),
      h("span", { class: "ptm-grow" }),
      naturalMeta,
      naturalLabel,
      h(
        "button",
        {
          class: "ptm-btn small",
          title: "清空自然语言描述",
          onclick: () => {
            naturalArea.value = "";
            naturalMeta.textContent = "0 字";
            this.setNaturalPrompt("");
          },
        },
        "清空"
      )
    );
    manualBox.appendChild(naturalHead);
    manualBox.appendChild(naturalArea);

    /* --- 提示词框分段条（逐段看翻译 / 逐段删除） --- */
    const segsBar = h("div", { class: "ptm-manual-segs" });
    manualBox.insertBefore(segsBar, naturalHead);

    const naturalInputDebounced = debounce(() => this.setNaturalPrompt(naturalArea.value), 260);
    naturalArea.addEventListener("input", () => {
      naturalMeta.textContent = `${(naturalArea.value || "").length} 字`;
      naturalInputDebounced();
    });
    naturalCheck.addEventListener("change", () => this.setNaturalAppend(naturalCheck.checked));
    const manualInputDebounced = debounce(() => this.setManualPrompt(manualArea.value), 260);
    manualArea.addEventListener("input", () => {
      manualMeta.textContent = `${(manualArea.value || "").length} 字`;
      manualInputDebounced();
    });
    manualModeSelect.addEventListener("change", () => this.setManualMode(manualModeSelect.value));
    spaceCheck.addEventListener("change", () => this.setSpaceAsSep(spaceCheck.checked));

    /* --- 预览 --- */
    const previewHead = h("div", { class: "ptm-preview-head" });
    const previewBody = h("div", { class: "ptm-preview-body" });
    const preview = h("div", { class: "ptm-preview" }, previewHead, previewBody);

    root.appendChild(toolbar);
    root.appendChild(banner);
    root.appendChild(cols);
    root.appendChild(selected);
    root.appendChild(manualBox);
    root.appendChild(preview);

    this.els = {
      root,
      libSelect,
      searchInput,
      searchWrap,
      matchInfo,
      saveState,
      banner,
      manualArea,
      manualModeSelect,
      manualMeta,
      spaceCheck,
      segsBar,
      naturalArea,
      naturalCheck,
      naturalMeta,
      colG,
      colS,
      colT,
      selectedHead,
      selectedBody,
      previewHead,
      previewBody,
    };

    if (this.container) {
      clear(this.container);
      this.container.appendChild(root);
    }
  }

  /* ------------------------------------------------------------ 数据帮助 */

  get groups() {
    return this.state.library.groups || [];
  }

  findGroup(name) {
    return this.groups.find((g) => g.name === name) || null;
  }

  findSub(groupName, subName) {
    const g = this.findGroup(groupName);
    if (!g) return null;
    return g.subs.find((s) => s.name === subName) || null;
  }

  allTagEntries() {
    const out = [];
    for (const g of this.groups) {
      for (const s of g.subs || []) {
        for (const t of s.tags || []) out.push({ text: t, group: g.name, sub: s.name });
      }
    }
    return out;
  }

  searchMatches() {
    const q = this.state.ui.search.trim().toLowerCase();
    if (!q) return null;
    const hits = [];
    let truncated = false;
    for (const g of this.groups) {
      const groupHit = String(g.name).toLowerCase().includes(q);
      for (const s of g.subs || []) {
        const subHit = groupHit || String(s.name).toLowerCase().includes(q);
        const descs = s.descs && typeof s.descs === "object" ? s.descs : null;
        for (const t of s.tags || []) {
          const descHit = descs ? String(descs[t] || "").toLowerCase().includes(q) : false;
          if (subHit || descHit || String(t).toLowerCase().includes(q)) {
            if (hits.length >= MAX_SEARCH_HITS) {
              truncated = true;
              break;
            }
            hits.push({ text: t, group: g.name, sub: s.name });
          }
        }
        if (truncated) break;
      }
      if (truncated) break;
    }
    hits.truncated = truncated;
    return hits;
  }

  /* ------------------------------------------------------------- 渲染 */

  renderAll() {
    if (!this.mounted) return;
    this.renderToolbar();
    this.renderBanner();
    this.refreshManualFromHost();
    this.renderColumns();
    this.renderSelected();
    this.renderManualSegments();
    this.renderPreview();
  }

  /** HTTP 接口关闭 / 连不上后端时的提示条 */
  renderBanner() {
    const el = this.els.banner;
    if (!el) return;
    clear(el);
    if (this.state.mode === "disabled") {
      el.style.display = "flex";
      el.className = "ptm-banner warn";
      el.appendChild(
        h(
          "span",
          { class: "ptm-banner-text" },
          "HTTP 接口已关闭（默认关闭）。现在只能用浏览器本地词库——插件自带的 14 个词库（人物 1612、一键模式 20 万条等）都在磁盘上，开启接口后就能用；节点执行不受影响。"
        )
      );
      el.appendChild(h("span", { class: "ptm-grow" }));
      el.appendChild(
        h(
          "button",
          { class: "ptm-btn small primary", title: "开启后即可读写磁盘上的词库", onclick: () => this.enableHttp() },
          "开启 HTTP 接口"
        )
      );
    } else if (this.state.mode === "offline") {
      el.style.display = "flex";
      el.className = "ptm-banner";
      el.appendChild(
        h(
          "span",
          { class: "ptm-banner-text" },
          "连不上插件后端，已切换到浏览器本地词库（localStorage）。功能照常，只是词库存在浏览器里。"
        )
      );
      el.appendChild(h("span", { class: "ptm-grow" }));
      el.appendChild(
        h("button", { class: "ptm-btn small", onclick: () => this.retryConnect() }, "重试连接")
      );
    } else {
      el.style.display = "none";
    }
  }

  /** 开启 HTTP 接口并切回磁盘词库 */
  async enableHttp() {
    try {
      const ok = await api.switchHttp(true);
      if (!ok) {
        toast("开启失败", "err");
        return;
      }
      await this.reloadFromBackend("HTTP 接口已开启，已切到磁盘词库");
    } catch (err) {
      toast("开启失败：" + err.message, "err");
    }
  }

  /** 重新连接后端（接口已开但之前连不上时用） */
  async retryConnect() {
    await api.probe(true);
    if (!api.isOffline()) {
      await this.reloadFromBackend("已连接插件后端");
    } else {
      this.state.mode = api.apiState.mode;
      this.renderBanner();
      toast("还是连不上，请确认 ComfyUI 正在运行", "err");
    }
  }

  async reloadFromBackend(message) {
    await api.probe(true);
    const st = await api.getState();
    this.state.mode = st.mode;
    this.libraries = st.libraries || [];
    this.dataDir = st.dataDir || "";
    const wanted =
      api.getRememberedLibrary() || st.default || (this.libraries[0] && this.libraries[0].name) || "";
    if (wanted && st.mode === "server") {
      await this.switchLibrary(wanted, { silent: true });
    }
    this.renderAll();
    if (message) toast(message, "ok");
  }

  renderToolbar() {
    const { libSelect, matchInfo, saveState, searchWrap, searchInput } = this.els;
    if (!libSelect) return;

    clear(libSelect);
    for (const lib of this.libraries) {
      const c = lib.counts || { tags: 0 };
      const opt = h(
        "option",
        { value: lib.name },
        `${lib.display_name || lib.name}（${c.tags} tag）`
      );
      libSelect.appendChild(opt);
    }
    if (this.state.libraryName && !this.libraries.some((l) => l.name === this.state.libraryName)) {
      libSelect.appendChild(h("option", { value: this.state.libraryName }, this.state.libraryName));
    }
    libSelect.value = this.state.libraryName || "";

    const searching = Boolean(this.state.ui.search && this.state.ui.search.trim());
    searchWrap.classList.toggle("has-value", searching);
    if (searchInput.value !== this.state.ui.search) searchInput.value = this.state.ui.search;

    if (searching) {
      const hits = this.searchMatches() || [];
      matchInfo.textContent = hits.truncated ? `命中 ${MAX_SEARCH_HITS}+` : `命中 ${hits.length}`;
      matchInfo.className = "ptm-badge accent";
    } else {
      const c = ops.libraryCounts(this.state.library);
      matchInfo.textContent = `${c.tags} tag`;
      matchInfo.className = "ptm-badge";
    }

    if (this.state.status === "loading") {
      saveState.textContent = "加载中…";
      saveState.className = "ptm-badge";
    } else if (this.state.mode === "disabled") {
      saveState.textContent = "接口已关闭";
      saveState.className = "ptm-badge warn";
      saveState.title = "HTTP 接口默认关闭，点上面提示条里的「开启 HTTP 接口」即可使用磁盘词库";
    } else if (this.state.mode === "offline") {
      saveState.textContent = "本地模式";
      saveState.className = "ptm-badge warn";
      saveState.title = "连不上后端，词库保存在浏览器 localStorage：" + (api.apiState.error || "");
    } else if (this.libDirty) {
      saveState.textContent = "待保存…";
      saveState.className = "ptm-badge warn";
    } else {
      saveState.textContent = "已保存";
      saveState.className = "ptm-badge";
      saveState.title = this.dataDir || "";
    }
  }

  colHead(title, extraNodes) {
    return h(
      "div",
      { class: "ptm-col-head" },
      h("span", null, title),
      h("span", { class: "ptm-grow" }),
      ...(extraNodes || [])
    );
  }

  renderColumns() {
    const { colG, colS, colT } = this.els;
    if (!colG) return;

    if (this.state.status === "loading") {
      for (const col of [colG, colS, colT]) {
        clear(col);
        col.appendChild(h("div", { class: "ptm-empty" }, "加载中…"));
      }
      return;
    }
    if (this.state.status === "error") {
      for (const col of [colG, colS, colT]) {
        clear(col);
        col.appendChild(h("div", { class: "ptm-empty" }, "加载失败：" + this.state.error));
      }
      return;
    }

    this.renderGroups();
    this.renderSubs();
    this.renderTags();
  }

  renderGroups() {
    const col = this.els.colG;
    clear(col);

    const searching = Boolean(this.state.ui.search.trim());
    const matches = searching ? this.searchMatches() || [] : null;

    col.appendChild(
      this.colHead(
        "一级分类",
        [iconBtn("＋", "新建一级分类", () => this.addGroup())]
      )
    );

    const list = h("div", { class: "ptm-list" });

    const totalRow = this.makeRow({
      label: searching ? "全部（搜索结果）" : "全部",
      count: searching ? matches.length : this.allTagEntries().length,
      active: !this.state.ui.group,
      onClick: () => {
        this.state.ui.group = null;
        this.state.ui.sub = null;
        this.renderColumns();
      },
    });
    list.appendChild(totalRow);

    for (const g of this.groups) {
      let count = 0;
      for (const s of g.subs || []) count += (s.tags || []).length;
      if (searching) {
        count = matches.filter((m) => m.group === g.name).length;
        if (!count) continue;
      }
      list.appendChild(
        this.makeRow({
          label: g.name,
          count,
          active: this.state.ui.group === g.name,
          onClick: () => {
            this.state.ui.group = g.name;
            this.state.ui.sub = null;
            this.renderColumns();
          },
          actions: [
            iconBtn("🎲", "按一级分类随机抽取", () => this.addPoolFromGroup(g)),
            iconBtn("＋", "在此分类下新建二级分类", () => this.addSub(g)),
            iconBtn("✎", "重命名一级分类", () => this.renameGroup(g)),
            iconBtn("🗑", "删除一级分类", () => this.deleteGroup(g), "danger"),
          ],
        })
      );
    }

    if (!this.groups.length) {
      list.appendChild(
        h("div", { class: "ptm-empty" }, "词库是空的", h("br"), "点右上角 ＋ 新建分类，或点「📥 导入」批量导入 tag")
      );
    }

    col.appendChild(list);
  }

  renderSubs() {
    const col = this.els.colS;
    clear(col);

    const group = this.findGroup(this.state.ui.group);
    const searching = Boolean(this.state.ui.search.trim());

    col.appendChild(
      this.colHead(
        group ? "二级分类 · " + group.name : "二级分类",
        group && !searching ? [iconBtn("＋", "新建二级分类", () => this.addSub(group))] : []
      )
    );

    const list = h("div", { class: "ptm-list" });

    if (!group) {
      list.appendChild(h("div", { class: "ptm-empty" }, "先在左侧选择一个一级分类"));
      col.appendChild(list);
      return;
    }

    const totalRow = this.makeRow({
      label: "全部",
      count: (group.subs || []).reduce((n, s) => n + (s.tags || []).length, 0),
      active: !this.state.ui.sub,
      onClick: () => {
        this.state.ui.sub = null;
        this.renderColumns();
      },
      actions: [iconBtn("🎲", "按此一级分类全部 tag 随机抽取", () => this.addPoolFromGroup(group))],
    });
    list.appendChild(totalRow);

    for (const s of group.subs || []) {
      list.appendChild(
        this.makeRow({
          label: s.name,
          count: (s.tags || []).length,
          active: this.state.ui.sub === s.name,
          onClick: () => {
            this.state.ui.sub = s.name;
            this.renderColumns();
          },
          actions: [
            iconBtn("🎲", "把此二级分类设为随机池", () => this.addPool(group, s)),
            iconBtn("≡", "批量编辑此二级分类的 tag", () => this.batchEditSub(group, s)),
            iconBtn("✎", "重命名二级分类", () => this.renameSub(group, s)),
            iconBtn("🗑", "删除二级分类", () => this.deleteSub(group, s), "danger"),
          ],
        })
      );
    }

    if (!(group.subs || []).length) {
      list.appendChild(h("div", { class: "ptm-empty" }, "这个一级分类下还没有二级分类"));
    }

    col.appendChild(list);
  }

  renderTags() {
    const col = this.els.colT;
    clear(col);

    const searching = Boolean(this.state.ui.search.trim());
    const group = this.findGroup(this.state.ui.group);
    const sub = group && this.state.ui.sub ? this.findSub(group.name, this.state.ui.sub) : null;

    // 切换分类/搜索时重置分页，避免残留上一个大列表的展开状态
    const ctxKey = [searching ? this.state.ui.search : "", this.state.ui.group || "", this.state.ui.sub || ""].join("\u0000");
    if (this._chipCtx !== ctxKey) {
      this.chipLimit = CHIP_PAGE;
      this._chipCtx = ctxKey;
    }

    let entries = [];
    if (searching) {
      entries = this.searchMatches() || [];
    } else if (sub) {
      entries = (sub.tags || []).map((t) => ({ text: t, group: group.name, sub: sub.name }));
    } else if (group) {
      entries = this.allTagEntries().filter((e) => e.group === group.name);
    } else {
      entries = this.allTagEntries();
    }

    const showWhere = Boolean(searching) || !sub;

    const headActions = [];
    if (!searching && sub) {
      headActions.push(
        h("button", { class: "ptm-btn small", title: "全选当前二级分类", onclick: () => this.selectAll(entries, true) }, "全选"),
        h("button", { class: "ptm-btn small", title: "反选", onclick: () => this.selectAll(entries, "invert") }, "反选"),
        h("button", { class: "ptm-btn small", title: "批量添加 tag", onclick: () => this.addTags(group, sub) }, "＋ 批量添加")
      );
    }

    col.appendChild(
      this.colHead(
        searching ? `搜索结果（${entries.length}）` : sub ? `子项 · ${sub.name}` : group ? `子项 · ${group.name}` : "子项 · 全部",
        headActions
      )
    );

    const wrap = h("div", { class: "ptm-tags" });
    if (!entries.length) {
      wrap.appendChild(h("div", { class: "ptm-empty" }, searching ? "没有匹配到 tag" : "这里还没有 tag"));
      col.appendChild(wrap);
      return;
    }

    // 巨型词库保护：一次最多渲染 CHIP_PAGE 个，避免创建几十万个 DOM 节点
    const shown = entries.slice(0, this.chipLimit);
    for (const entry of shown) {
      wrap.appendChild(this.makeTagChip(entry, showWhere, group, sub));
    }
    if (entries.length > shown.length) {
      wrap.appendChild(
        h(
          "button",
          {
            class: "ptm-btn small",
            style: { margin: "4px" },
            onclick: () => {
              this.chipLimit += CHIP_PAGE;
              this.renderTags();
            },
          },
          `还有 ${entries.length - shown.length} 个未显示（点这里再多显示 ${Math.min(
            CHIP_PAGE,
            entries.length - shown.length
          )} 个，或用搜索/选二级分类缩小范围）`
        )
      );
    }
    col.appendChild(wrap);
  }

  makeRow({ label, count, active, onClick, actions, muted }) {
    const actionsBox = actions && actions.length ? h("span", { class: "ptm-row-actions" }, ...actions) : null;
    return h(
      "div",
      { class: `ptm-row ${active ? "active" : ""} ${muted ? "muted" : ""}`, title: label, onclick: onClick },
      h("span", { class: "ptm-row-label" }, label),
      actionsBox,
      h("span", { class: `ptm-row-count ${actionsBox ? "has-actions" : ""}` }, String(count))
    );
  }

  makeTagChip(entry, showWhere, group, sub) {
    const on = this.isSelected(entry.text);
    const ownerGroup = this.findGroup(entry.group);
    const ownerSub = ownerGroup ? this.findSub(ownerGroup.name, entry.sub) : null;
    const descs = ownerSub && ownerSub.descs && typeof ownerSub.descs === "object" ? ownerSub.descs : null;
    const desc = descs ? descs[entry.text] || "" : "";
    const editable = Boolean(ownerGroup && ownerSub);
    const canDelete = editable && !this.state.ui.search.trim();

    const tip = [
      desc || "（还没有中文翻译）",
      entry.text.length > 120 ? entry.text.slice(0, 120) + "…" : entry.text,
      showWhere ? `${entry.group} / ${entry.sub}` : "",
      "单击选中/取消　双击改 tag 名　✎ 改翻译",
    ]
      .filter(Boolean)
      .join("\n");

    const actions = h("span", { class: "ptm-tag-actions" });
    if (editable) {
      actions.appendChild(
        h(
          "button",
          {
            class: "ptm-tag-act",
            title: desc ? "修改中文翻译（点这里）" : "添加中文翻译（点这里）",
            onclick: (ev) => {
              ev.stopPropagation();
              this.editDesc(ownerGroup, ownerSub, entry.text);
            },
          },
          "✎"
        )
      );
    }
    if (canDelete) {
      actions.appendChild(
        h(
          "button",
          {
            class: "ptm-tag-act danger",
            title: "从词库删除此 tag",
            onclick: (ev) => {
              ev.stopPropagation();
              this.deleteTag(ownerGroup, ownerSub, entry.text);
            },
          },
          "✕"
        )
      );
    }

    const chip = h(
      "div",
      {
        class: `ptm-tag ${on ? "on" : ""} ${this.showDesc && desc ? "with-desc" : ""}`,
        title: tip,
        onclick: () => this.toggleTag(entry),
        ondblclick: (ev) => {
          ev.stopPropagation();
          if (editable) this.renameTag(ownerGroup, ownerSub, entry.text);
        },
      },
      h("span", { class: "ptm-tag-text" }, entry.text),
      this.showDesc
        ? h(
            "span",
            {
              class: `ptm-tag-desc ${desc ? "" : "empty"}`,
              title: desc ? "双击可修改翻译" : "点 ✎ 添加翻译",
              ondblclick: (ev) => {
                ev.stopPropagation();
                if (editable) this.editDesc(ownerGroup, ownerSub, entry.text);
              },
            },
            desc || (editable ? "无翻译" : "")
          )
        : null,
      showWhere ? h("span", { class: "ptm-tag-where" }, `${entry.group}/${entry.sub}`) : null,
      actions
    );

    return chip;
  }

  renderSelected() {
    const { selectedHead, selectedBody } = this.els;
    if (!selectedHead) return;

    clear(selectedHead);
    const total = this.state.items.length;
    const activeCount = this.state.items.filter((i) => i.enabled !== false).length;

    selectedHead.appendChild(h("span", { class: "ptm-badge accent" }, `已选 ${activeCount}`));
    if (total !== activeCount) selectedHead.appendChild(h("span", { class: "ptm-badge" }, `共 ${total}（含停用）`));
    selectedHead.appendChild(h("span", { class: "ptm-grow" }));
    selectedHead.appendChild(
      h("button", { class: "ptm-btn small", title: "把已选 tag 复制到剪贴板", onclick: () => this.copySelected() }, "📋 复制")
    );
    selectedHead.appendChild(
      h("button", { class: "ptm-btn small", title: "反转顺序", onclick: () => this.reverseItems() }, "⇅ 反转")
    );

    clear(selectedBody);
    if (!this.state.items.length) {
      selectedBody.appendChild(
        h("div", { class: "ptm-empty" }, "还没有选中任何 tag —— 点上面任意 tag 加入，或点二级分类上的 🎲 建一个随机池")
      );
      return;
    }

    this.state.items.forEach((item, idx) => {
      selectedBody.appendChild(this.makeSelectedChip(item, idx));
    });
  }

  makeSelectedChip(item, idx) {
    const isPool = item.kind === "pool";
    const label = isPool ? item.label || "随机池" : item.text;
    const weightText = Number(item.weight).toFixed(2).replace(/\.00$/, "");

    let desc = "";
    if (!isPool) {
      const g = this.findGroup(item.group);
      const s = g ? this.findSub(g.name, item.sub) : null;
      if (s && s.descs && typeof s.descs === "object") desc = s.descs[item.text] || "";
      // 词库里没有就试本地自定义译文 / 当前机翻
      if (!desc) desc = this.getCustomDesc(item.text) || this.getApiDesc(item.text);
    }

    const chip = h("div", {
      class: `ptm-chip ${isPool ? "pool" : ""} ${item.enabled === false ? "off" : ""}`,
      draggable: "true",
      dataset: { idx: String(idx) },
      title: isPool
        ? `${label}：从 ${(item.tags || []).length || item.size || 0} 个候选 tag 中随机抽 ${item.count} 个\n拖拽可调整顺序`
        : `${desc ? desc + "\n" : ""}${label}\n单击停用/启用，拖拽调整顺序`,
    });

    if (isPool) {
      chip.appendChild(h("span", { class: "ptm-chip-text", style: { color: "#c3b1ff" } }, "🎲 " + label));
      chip.appendChild(
        h(
          "span",
          { class: "ptm-chip-count" },
          h(
            "button",
            {
              class: "ptm-chip-btn",
              title: "减少抽取数量",
              onclick: (ev) => {
                ev.stopPropagation();
                item.count = Math.max(1, item.count - 1);
                this.emitConfig();
                this.renderSelected();
                this.renderPreview();
              },
            },
            "−"
          ),
          `×${item.count}`,
          h(
            "button",
            {
              class: "ptm-chip-btn",
              title: "增加抽取数量",
              onclick: (ev) => {
                ev.stopPropagation();
                item.count += 1;
                this.emitConfig();
                this.renderSelected();
                this.renderPreview();
              },
            },
            "＋"
          )
        )
      );
    } else {
      const textSpan = h(
        "span",
        {
          class: "ptm-chip-text",
          onclick: (ev) => {
            ev.stopPropagation();
            item.enabled = item.enabled === false;
            this.emitConfig();
            this.renderSelected();
            this.renderPreview();
          },
        },
        label
      );
      chip.appendChild(textSpan);
    }

    // 权重
    const weightEl = h("span", { class: "ptm-chip-weight", title: "点击修改权重" }, weightText);
    weightEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.editWeight(weightEl, item, () => {
        this.emitConfig();
        this.renderSelected();
        this.renderPreview();
      });
    });
    chip.appendChild(weightEl);

    chip.appendChild(
      h(
        "button",
        {
          class: "ptm-chip-btn",
          title: item.enabled === false ? "启用" : "停用",
          onclick: (ev) => {
            ev.stopPropagation();
            item.enabled = item.enabled === false;
            this.emitConfig();
            this.renderSelected();
            this.renderPreview();
          },
        },
        item.enabled === false ? "○" : "◉"
      )
    );

    chip.appendChild(
      h(
        "button",
        {
          class: "ptm-chip-btn danger",
          title: "从已选中移除",
          onclick: (ev) => {
            ev.stopPropagation();
            this.state.items.splice(idx, 1);
            this.emitConfig();
            this.renderSelected();
            this.renderColumns();
            this.renderPreview();
          },
        },
        "✕"
      )
    );

    return chip;
  }

  editWeight(weightEl, item, done) {
    if (weightEl.classList.contains("editing")) return;
    weightEl.classList.add("editing");
    const input = h("input", { value: String(item.weight) });
    clear(weightEl);
    weightEl.appendChild(input);
    input.focus();
    input.select();

    const commit = (cancel) => {
      if (!weightEl.isConnected) return;
      if (!cancel) {
        const v = Number(input.value);
        if (Number.isFinite(v) && v > 0) item.weight = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, v));
      }
      done();
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") commit(false);
      else if (ev.key === "Escape") commit(true);
      ev.stopPropagation();
    });
    input.addEventListener("blur", () => commit(false));
    input.addEventListener("click", (ev) => ev.stopPropagation());
  }

  renderPreview() {
    const { previewHead, previewBody } = this.els;
    if (!previewHead) return;

    const opts = this.getOptions();
    const mode = this.getManualMode();
    const local = ops.previewPrompt(this.state.items, opts);
    let manual = "";
    try {
      manual = (this.host.getManualPrompt && this.host.getManualPrompt()) || "";
    } catch (err) {
      manual = "";
    }
    const tagPart = this.randomPreviewText || local.text;
    let natural = "";
    try {
      natural = (this.host.getNaturalPrompt && this.host.getNaturalPrompt()) || "";
    } catch (err) {
      natural = "";
    }
    const combined = ops.combinePrompt({
      manual,
      tagPrompt: tagPart,
      mode,
      separator: opts.separator,
      spaceAsSeparator: this.getSpaceAsSep(),
      natural,
      naturalAppend: this.getNaturalAppend(),
    });

    clear(previewHead);
    previewHead.appendChild(h("span", { class: "ptm-badge" }, "提示词预览"));
    if (mode !== "仅使用提示词框" && local.poolCount) {
      previewHead.appendChild(
        h("span", { class: "ptm-badge warn", title: "执行节点时会按 seed 真正抽取" }, `含 ${local.poolCount} 个随机池`)
      );
    }
    if (this.randomPreviewText) {
      previewHead.appendChild(h("span", { class: "ptm-badge accent" }, `已按种子 ${this.randomPreviewSeed} 抽取`));
    }
    if (mode !== ops.DEFAULT_MANUAL_MODE) {
      previewHead.appendChild(h("span", { class: "ptm-badge accent" }, mode));
    }
    previewHead.appendChild(h("span", { class: "ptm-grow" }));
    previewHead.appendChild(
      h(
        "button",
        {
          class: "ptm-btn small",
          title: "复制预览文本",
          onclick: async () => {
            const text = this.previewText || "";
            try {
              await navigator.clipboard.writeText(text);
              toast("已复制预览文本", "ok");
            } catch (err) {
              toast("复制失败，请手动选择文本", "err");
            }
          },
        },
        "📋 复制"
      )
    );

    this.previewText = combined;
    clear(previewBody);
    previewBody.classList.toggle("empty", !combined);
    let hint = "（还没有内容）";
    if (mode === "仅使用提示词框") hint = "（提示词框是空的，或者切到「两者结合」用 TAG 词库）";
    else if (mode === "仅使用 TAG 词库") hint = "（还没有选中任何 tag）";
    else hint = "（提示词框和已选 tag 都是空的）";
    previewBody.textContent = combined || hint;
  }

  /* ------------------------------------------------------------- 交互 */

  getOptions() {
    const base = { separator: ", ", dedupe: true, underscoreToSpace: true, weightStyle: ops.DEFAULT_WEIGHT_STYLE };
    try {
      const custom = this.host.getOptions ? this.host.getOptions() : null;
      return Object.assign(base, custom || {});
    } catch (err) {
      return base;
    }
  }

  /* ------------------------------------------------- 手动提示词框（同步节点） */

  getManualMode() {
    try {
      return (this.host.getManualMode && this.host.getManualMode()) || ops.DEFAULT_MANUAL_MODE;
    } catch (err) {
      return ops.DEFAULT_MANUAL_MODE;
    }
  }

  refreshManualFromHost() {
    const { manualArea, manualModeSelect, manualMeta } = this.els;
    if (!manualArea) return;
    let text = "";
    try {
      text = (this.host.getManualPrompt && this.host.getManualPrompt()) || "";
    } catch (err) {
      text = "";
    }
    if (document.activeElement !== manualArea) manualArea.value = text;
    manualMeta.textContent = `${(manualArea.value || "").length} 字`;
    const mode = this.getManualMode();
    manualModeSelect.value = ops.MANUAL_MODES.includes(mode) ? mode : ops.DEFAULT_MANUAL_MODE;
    const check = this.els.spaceCheck;
    if (check) check.checked = this.getSpaceAsSep();

    const natArea = this.els.naturalArea;
    if (natArea) {
      let natText = "";
      try {
        natText = (this.host.getNaturalPrompt && this.host.getNaturalPrompt()) || "";
      } catch (err) {
        natText = "";
      }
      if (document.activeElement !== natArea) natArea.value = natText;
      this.els.naturalMeta.textContent = `${(natArea.value || "").length} 字`;
      if (this.els.naturalCheck) this.els.naturalCheck.checked = this.getNaturalAppend();
    }
  }

  getNaturalAppend() {
    try {
      return Boolean(this.host.getNaturalAppend && this.host.getNaturalAppend());
    } catch (err) {
      return false;
    }
  }

  setNaturalPrompt(text) {
    try {
      if (this.host.setNaturalPrompt) this.host.setNaturalPrompt(text || "");
    } catch (err) {
      console.warn("[PromptTag] 同步自然语言框失败", err);
    }
    this.renderPreview();
  }

  setNaturalAppend(value) {
    try {
      if (this.host.setNaturalAppend) this.host.setNaturalAppend(Boolean(value));
    } catch (err) {
      console.warn("[PromptTag] 同步自然语言组合开关失败", err);
    }
    this.renderPreview();
  }

  getSpaceAsSep() {
    try {
      return Boolean(this.host.getSpaceAsSep && this.host.getSpaceAsSep());
    } catch (err) {
      return false;
    }
  }

  setSpaceAsSep(value) {
    try {
      if (this.host.setSpaceAsSep) this.host.setSpaceAsSep(Boolean(value));
    } catch (err) {
      console.warn("[PromptTag] 同步空格转连接符失败", err);
    }
    this.renderPreview();
  }

  /**
   * 提示词框的便捷编辑：
   *   tidy   —— 统一连接符、去多余空格与空项、顺便去重
   *   dedupe —— 只去重
   *   pop    —— 删掉最后一段
   */
  editManualText(mode) {
    const el = this.els.manualArea;
    if (!el) return;
    const sep = this.getOptions().separator || ", ";
    let parts = this.splitManual(el.value);

    if (!parts.length) {
      this.renderPreview();
      return;
    }
    if (mode === "pop") {
      parts.pop();
    } else {
      const seen = new Set();
      parts = parts.filter((p) => {
        const key = p.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    const text = parts.join(sep);
    el.value = text;
    this.els.manualMeta.textContent = `${text.length} 字`;
    this.setManualPrompt(text);
    if (mode === "pop") toast("已删掉最后一段", "ok");
    else toast(`已整理：${parts.length} 段`, "ok");
  }

  /** 按连接符/逗号（或空格模式下的空白）把提示词框切成若干段 */
  splitManual(value) {
    const splitRe = this.getSpaceAsSep() ? /[,，\s]+/ : /[,，\n]+/;
    return String(value == null ? "" : value)
      .split(splitRe)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /* ------------------------------------------- 分段条：逐段翻译 / 删除 */

  /** 建立「tag → 中文翻译」「tag → 所在分类」两个索引（来自当前词库），按词库与改动版本缓存 */
  getDescIndex() {
    const key = `${this.state.libraryName}#${this._descVersion || 0}`;
    if (this._descIndexCache && this._descIndexCache.key === key) return this._descIndexCache;

    const descs = new Map();
    const locs = new Map();
    const lib = this.state.library;
    if (lib) {
      for (const g of lib.groups || []) {
        for (const s of g.subs || []) {
          for (const t of s.tags || []) {
            const k = String(t).toLowerCase();
            if (!locs.has(k)) locs.set(k, { group: g.name, sub: s.name, tag: t });
            const desc = s.descs && typeof s.descs === "object" ? s.descs[t] : "";
            if (desc && !descs.has(k)) descs.set(k, desc);
          }
        }
      }
    }
    this._descIndexCache = { key, descs, locs };
    return this._descIndexCache;
  }

  /** 把一段提示词归一成查表用的候选写法：(tag:1.2) → tag，空格→下划线等 */
  segmentKeys(segment) {
    const raw = String(segment || "").trim();
    if (!raw) return [];
    let core = raw;
    const weighted = raw.match(/^\(+\s*(.+?)\s*:\s*[\d.]+\s*\)+$/);
    if (weighted) core = weighted[1].replace(/\\\(/g, "(").replace(/\\\)/g, ")");
    const keys = [core.toLowerCase()];
    if (core.includes(" ")) keys.push(core.replace(/\s+/g, "_").toLowerCase());
    if (core.includes("_")) keys.push(core.replace(/_/g, " ").toLowerCase());
    return keys;
  }

  /** 查一段提示词在「当前词库」里的中文翻译 */
  lookupSegmentDesc(segment) {
    const { descs } = this.getDescIndex();
    for (const k of this.segmentKeys(segment)) {
      const hit = descs.get(k);
      if (hit) return hit;
    }
    return "";
  }

  /** 查一段提示词在本地「自定义翻译」里的译文 */
  getCustomDesc(segment) {
    if (!this.customDescs || !this.customDescs.size) return "";
    for (const k of this.segmentKeys(segment)) {
      const hit = this.customDescs.get(k);
      if (hit) return hit;
    }
    return "";
  }

  /** 这段文本是不是当前词库里的 tag（是的话译文就写进词库，否则写进自定义翻译） */
  findTagLocation(segment) {
    const { locs } = this.getDescIndex();
    for (const k of this.segmentKeys(segment)) {
      const hit = locs.get(k);
      if (hit) return hit;
    }
    return null;
  }

  async loadCustomDescs() {
    try {
      const data = await api.getCustomDescs();
      this.customDescs = new Map(
        Object.entries(data || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)])
      );
    } catch (err) {
      this.customDescs = this.customDescs || new Map();
    }
    return this.customDescs;
  }

  /**
   * 修改某一段的译文并保存到本地：
   *   * 这段是当前词库里的 tag → 写进词库 descs（跟着词库文件一起存盘）
   *   * 否则 → 写进本地自定义翻译 .custom_descs.json
   */
  async editSegmentDesc(segment) {
    const current = this.lookupSegmentDesc(segment) || this.getCustomDesc(segment) || this.getApiDesc(segment);
    const value = await promptDialog({
      title: "修改译文",
      label: segment,
      value: current,
      placeholder: "例如：长发　（留空 = 删除译文）",
      hint: "保存后写入本地：词库里有的 tag 写回词库，其余存到 .custom_descs.json。",
    });
    if (value === null) return;
    const text = String(value).replace(/\s+/g, " ").trim();
    const loc = this.findTagLocation(segment);
    const group = loc ? this.findGroup(loc.group) : null;
    const sub = group && loc ? this.findSub(group.name, loc.sub) : null;
    try {
      if (loc && sub) {
        if (text) {
          if (!sub.descs || typeof sub.descs !== "object") sub.descs = {};
          sub.descs[loc.tag] = text;
        } else if (sub.descs) {
          delete sub.descs[loc.tag];
          if (!Object.keys(sub.descs).length) delete sub.descs;
        }
        this.markLibDirty();
        toast(text ? `已写入词库：「${loc.tag}」→ ${text}` : `已删除词库译文：${loc.tag}`, "ok");
      } else {
        // 不在当前词库里的（手写词、别的词库的 tag）：存进本地自定义翻译
        const key = this.segmentKeys(segment)[0] || String(segment).trim();
        const saved = await api.saveCustomDesc(key, text);
        this.customDescs = new Map(
          Object.entries(saved || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)])
        );
        toast(text ? `已保存到本地自定义翻译：${text}` : "已删除本地译文", "ok");
      }
      this.apiDescs.delete(String(segment).toLowerCase());
    } catch (err) {
      toast("保存失败：" + err.message, "err");
    }
    this.renderManualSegments();
  }

  /** 把当前显示的机翻全部保存到本地（词库 or 自定义翻译） */
  async saveMachineDescs() {
    if (!this.apiDescs || !this.apiDescs.size) {
      toast("没有需要保存的机翻", "ok");
      return;
    }
    const parts = this.splitManual(this.els.manualArea ? this.els.manualArea.value : "");
    const seen = new Set();
    const forCustom = {};
    let toLibrary = 0;

    for (const segment of parts) {
      const seenKey = segment.toLowerCase();
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);
      const apiDesc = this.getApiDesc(segment);
      if (!apiDesc) continue;
      const loc = this.findTagLocation(segment);
      if (loc) {
        const group = this.findGroup(loc.group);
        const sub = group ? this.findSub(group.name, loc.sub) : null;
        if (sub) {
          if (!sub.descs || typeof sub.descs !== "object") sub.descs = {};
          sub.descs[loc.tag] = apiDesc;
          toLibrary += 1;
          continue;
        }
      }
      const storeKey = this.segmentKeys(segment)[0] || String(segment).trim();
      forCustom[storeKey] = apiDesc;
    }

    try {
      if (toLibrary) {
        this.markLibDirty();
        this._descVersion += 1;
        await this.flushSave();
      }
      const customCount = Object.keys(forCustom).length;
      if (customCount) {
        const saved = await api.saveCustomDescs(forCustom);
        this.customDescs = new Map(
          Object.entries(saved || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)])
        );
      }
      this.apiDescs.clear();
      this.renderManualSegments();
      this.renderSelected();
      toast(
        `已保存机翻：词库 ${toLibrary} 段${customCount ? `，本地自定义 ${customCount} 条` : ""}`,
        "ok"
      );
    } catch (err) {
      toast("保存机翻失败：" + err.message, "err");
    }
  }

  deleteManualSegment(index) {
    const el = this.els.manualArea;
    if (!el) return;
    const parts = this.splitManual(el.value);
    if (index < 0 || index >= parts.length) return;
    const removed = parts[index];
    parts.splice(index, 1);
    const sep = this.getOptions().separator || ", ";
    const text = parts.join(sep);
    el.value = text;
    this.els.manualMeta.textContent = `${text.length} 字`;
    this.setManualPrompt(text);
    toast(`已删除「${removed.length > 24 ? removed.slice(0, 24) + "…" : removed}」`, "ok");
  }

  renderManualSegments() {
    const bar = this.els.segsBar;
    if (!bar) return;
    const value = this.els.manualArea ? this.els.manualArea.value : "";
    const parts = this.splitManual(value);
    clear(bar);
    if (!parts.length) {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "flex";

    const sep = this.getOptions().separator || ", ";

    // 「翻译缺失段」只翻词库里查不到、也没机翻/自定义译文的段
    const missing = parts.filter((p) => !this.getSegmentDesc(p) && !this.getApiDesc(p));
    bar.appendChild(
      h(
        "button",
        {
          class: "ptm-btn small",
          title: "用翻译接口翻译没有译文的段（结果会缓存，可再点译文修改或保存到本地）",
          onclick: () => this.translateMissingSegments(),
        },
        "翻译缺失段" + (missing.length ? `（${missing.length}）` : "")
      )
    );
    bar.appendChild(
      h("button", { class: "ptm-btn small icon", title: "翻译设置（服务 / 语言 / Key）", onclick: () => this.openTranslateSettings() }, "⚙")
    );

    let libCount = 0;
    let customCount = 0;
    let apiCount = 0;
    parts.forEach((segment, index) => {
      const libDesc = this.lookupSegmentDesc(segment);
      const customDesc = libDesc ? "" : this.getCustomDesc(segment);
      const shown = libDesc || customDesc;
      const apiDesc = shown ? "" : this.getApiDesc(segment);
      if (libDesc) libCount += 1;
      else if (customDesc) customCount += 1;
      else if (apiDesc) apiCount += 1;

      const editable = (desc, cls, hint) =>
        h(
          "span",
          {
            class: `ptm-manual-seg-desc${cls ? " " + cls : ""}`,
            title: `${desc}\n点击修改译文并保存到本地`,
            onclick: (ev) => {
              ev.stopPropagation();
              this.editSegmentDesc(segment);
            },
          },
          desc
        );

      const chip = h(
        "span",
        {
          class: "ptm-manual-seg",
          title: `${segment}${shown ? "\n" + shown : apiDesc ? "\n机翻：" + apiDesc : ""}\n双击译文可修改，点 ✕ 删除这一段`,
          ondblclick: (ev) => {
            ev.stopPropagation();
            this.editSegmentDesc(segment);
          },
        },
        h("span", { class: "ptm-manual-seg-text" }, segment),
        libDesc ? editable(libDesc, "") : null,
        customDesc ? editable(customDesc, "custom") : null,
        apiDesc
          ? h(
              "span",
              {
                class: "ptm-manual-seg-desc api",
                title: "翻译接口返回（未保存）\n点这里可以直接改并保存，或点「保存译文」批量存到本地",
                onclick: (ev) => {
                  ev.stopPropagation();
                  this.editSegmentDesc(segment);
                },
              },
              apiDesc
            )
          : null,
        h(
          "button",
          {
            class: "ptm-manual-seg-del",
            title: "删除这一段",
            onclick: (ev) => {
              ev.stopPropagation();
              this.deleteManualSegment(index);
            },
          },
          "✕"
        )
      );
      bar.appendChild(chip);
    });

    bar.appendChild(
      h(
        "span",
        { class: "ptm-badge", title: `当前词库里能查到译文的分段数` },
        `翻译 ${libCount + customCount}/${parts.length}`
      )
    );
    if (customCount) {
      bar.appendChild(
        h("span", { class: "ptm-badge ok", title: "存在本地自定义翻译（.custom_descs.json）里，点译文可改" }, `本地 ${customCount}`)
      );
    }
    if (apiCount) {
      bar.appendChild(h("span", { class: "ptm-badge warn", title: "由翻译接口提供，仅用于显示" }, `机翻 ${apiCount}`));
      bar.appendChild(
        h(
          "button",
          {
            class: "ptm-btn small",
            title: "把这些机翻保存到本地（词库里有的 tag 写回词库，其余存到自定义翻译）",
            onclick: () => this.saveMachineDescs(),
          },
          "保存译文"
        )
      );
    }
    bar.title = `分段共 ${parts.length} 段，用「${sep === "\n" ? "换行" : sep}」连接；双击译文可修改并保存`;
  }

  /** 只要有一段译文（词库 / 本地自定义）就算有译文 */
  getSegmentDesc(segment) {
    return this.lookupSegmentDesc(segment) || this.getCustomDesc(segment);
  }

  /* -------------------------------------------------------- 翻译接口 */

  getApiDesc(segment) {
    if (!this.apiDescs) return "";
    return this.apiDescs.get(String(segment || "").toLowerCase()) || "";
  }

  async translateMissingSegments() {
    const parts = this.splitManual(this.els.manualArea ? this.els.manualArea.value : "");
    const missing = parts.filter((p) => !this.getSegmentDesc(p) && !this.getApiDesc(p));
    if (!missing.length) {
      toast("没有需要翻译的段（都已有译文）", "ok");
      return;
    }
    const tip = toast(`正在翻译 ${missing.length} 段…`);
    try {
      const res = await api.translateTexts(missing);
      let added = 0;
      for (const [src, out] of Object.entries(res.translations || {})) {
        if (out && String(out).trim()) {
          this.apiDescs.set(String(src).toLowerCase(), String(out).trim());
          added += 1;
        }
      }
      this.renderManualSegments();
      if (added) {
        const extra = res.cached ? `，其中 ${res.cached} 段来自缓存` : "";
        toast(`已翻译 ${added} 段（${res.provider || "接口"}${extra}）`, "ok");
      }
      if (res.failed) {
        toast(`${res.failed} 段翻译失败：${res.error || "接口返回异常"}`, "err");
      }
      if (res.truncated) toast("单次翻译数量较多，只翻了前 60 段", "err");
    } catch (err) {
      toast("翻译失败：" + err.message, "err");
    } finally {
      if (tip && tip.remove) tip.remove();
    }
  }

  async openTranslateSettings() {
    try {
      const settings = await api.getTranslateSettings();
      const saved = await translateSettingsDialog({ settings });
      if (saved) {
        // 换了服务/语言：之前的机翻结果作废
        this.apiDescs.clear();
        this.renderManualSegments();
      }
    } catch (err) {
      toast("打开翻译设置失败：" + err.message, "err");
    }
  }

  setManualPrompt(text) {
    try {
      if (this.host.setManualPrompt) this.host.setManualPrompt(text || "");
    } catch (err) {
      console.warn("[PromptTag] 同步提示词框失败", err);
    }
    const mode = this.getManualMode();
    if (ops.manualUsesTags(mode)) this.randomPreviewText = "";
    this.renderManualSegments();
    this.renderPreview();
  }

  setManualMode(mode) {
    try {
      if (this.host.setManualMode) this.host.setManualMode(mode);
    } catch (err) {
      console.warn("[PromptTag] 同步使用方式失败", err);
    }
    this.randomPreviewText = "";
    this.renderPreview();
  }

  setSearch(value) {
    this.state.ui.search = value || "";
    this.randomPreviewText = "";
    this.renderToolbar();
    this.renderColumns();
  }

  isSelected(text) {
    const k = key(text);
    return this.state.items.some((i) => i.kind === "tag" && key(i.text) === k);
  }

  toggleTag(entry) {
    const k = key(entry.text);
    const idx = this.state.items.findIndex((i) => i.kind === "tag" && key(i.text) === k);
    if (idx >= 0) this.state.items.splice(idx, 1);
    else
      this.state.items.push({
        id: `it_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        kind: "tag",
        text: entry.text,
        group: entry.group,
        sub: entry.sub,
        weight: 1,
        enabled: true,
        tags: [],
      });

    this.randomPreviewText = "";
    this.emitConfig();
    this.renderTags();
    this.renderSelected();
    this.renderPreview();
  }

  selectAll(entries, mode) {
    const list = entries || [];
    let changed = 0;
    if (mode === "invert") {
      for (const e of list) {
        const idx = this.state.items.findIndex((i) => i.kind === "tag" && key(i.text) === key(e.text));
        if (idx >= 0) {
          this.state.items.splice(idx, 1);
          changed += 1;
        } else {
          this.pushItem(e);
          changed += 1;
        }
      }
      if (changed) toast(`已切换 ${changed} 个 tag`, "ok");
    } else {
      for (const e of list) {
        if (!this.isSelected(e.text)) {
          this.pushItem(e);
          changed += 1;
        }
      }
      if (changed) toast(`已添加 ${changed} 个 tag`, "ok");
    }
    if (!changed) return;
    this.randomPreviewText = "";
    this.emitConfig();
    this.renderTags();
    this.renderSelected();
    this.renderPreview();
  }

  pushItem(entry) {
    this.state.items.push({
      id: `it_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      kind: "tag",
      text: entry.text,
      group: entry.group,
      sub: entry.sub,
      weight: 1,
      enabled: true,
      tags: [],
    });
  }

  addPoolFromGroup(group) {
    const tags = [];
    for (const s of group.subs || []) tags.push(...(s.tags || []));
    if (!tags.length) {
      toast("这个分类下还没有 tag", "err");
      return;
    }
    const existing = this.state.items.find(
      (i) => i.kind === "pool" && i.group === group.name && i.sub === "*"
    );
    if (existing) {
      existing.count += 1;
    } else {
      this.state.items.push({
        id: `pool_${Date.now()}`,
        kind: "pool",
        label: `${group.name}/*`,
        library: this.state.libraryName,
        group: group.name,
        sub: "*",
        count: 1,
        weight: 1,
        enabled: true,
        tags: tags.slice(),
        size: tags.length,
      });
    }
    this.randomPreviewText = "";
    this.emitConfig();
    this.renderSelected();
    this.renderColumns();
    this.renderPreview();
  }

  addPool(group, sub) {
    const tags = (sub.tags || []).slice();
    if (!tags.length) {
      toast("这个二级分类下还没有 tag", "err");
      return;
    }
    const existing = this.state.items.find(
      (i) => i.kind === "pool" && i.group === group.name && i.sub === sub.name
    );
    if (existing) {
      existing.count += 1;
      toast(`随机池「${sub.name}」数量改为 ${existing.count}`, "ok");
    } else {
      this.state.items.push({
        id: `pool_${Date.now()}`,
        kind: "pool",
        label: `${group.name}/${sub.name}`,
        library: this.state.libraryName,
        group: group.name,
        sub: sub.name,
        count: 1,
        weight: 1,
        enabled: true,
        tags,
        size: tags.length,
      });
      toast(`已添加随机池「${sub.name}」(${tags.length} 个候选)`, "ok");
    }
    this.randomPreviewText = "";
    this.emitConfig();
    this.renderSelected();
    this.renderColumns();
    this.renderPreview();
  }

  clearItems() {
    if (!this.state.items.length) return;
    this.state.items = [];
    this.randomPreviewText = "";
    this.emitConfig();
    this.renderSelected();
    this.renderColumns();
    this.renderPreview();
  }

  reverseItems() {
    this.state.items.reverse();
    this.emitConfig();
    this.renderSelected();
    this.renderPreview();
  }

  async copySelected() {
    const opts = this.getOptions();
    const { tags } = ops.previewPrompt(this.state.items, opts);
    const text = tags.join(opts.separator === undefined ? ", " : opts.separator);
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制 ${tags.length} 个 tag`, "ok");
    } catch (err) {
      toast("复制失败，请手动选择预览文本", "err");
    }
  }

  async doRandomPreview() {
    if (!this.state.items.length) {
      toast("还没有选中 tag", "err");
      return;
    }
    const opts = this.getOptions();
    let seed = 0;
    try {
      seed = this.host.getSeed ? Number(this.host.getSeed()) || 0 : 0;
    } catch (err) {
      seed = 0;
    }
    try {
      const res = await api.previewPrompt({
        config: this.getConfig(),
        seed,
        separator: opts.separator,
        dedupe: opts.dedupe,
        underscoreToSpace: opts.underscoreToSpace,
        weightStyle: opts.weightStyle,
      });
      this.randomPreviewText = res.prompt || "（空）";
      this.randomPreviewSeed = seed;
      this.renderPreview();
      toast(res.exact ? "已按当前种子预览（与执行结果一致）" : "已用本地算法预览（可能与执行略有差异）", res.exact ? "ok" : "");
    } catch (err) {
      toast("预览失败：" + err.message, "err");
    }
  }

  emitConfig() {
    if (this.host.onConfigChange) {
      try {
        this.host.onConfigChange(this.getConfig());
      } catch (err) {
        console.warn("[PromptTag] 同步配置失败", err);
      }
    }
  }

  /* --------------------------------------------------------- 词库操作 */

  async switchLibrary(name, opts = {}) {
    if (!name) return;
    // 切库前必须先把没落盘的修改写完，否则会被新库覆盖
    await this.flushSave();
    this.state.status = "loading";
    this.renderAll();
    try {
      const res = await api.loadLibrary(name);
      this.state.library = res.data;
      this.state.kind = res.kind || "user";
      this.state.libraryName = res.name || name;
      this.state.ui.group = null;
      this.state.ui.sub = null;
      this.state.status = "ready";
      this.state.error = "";
      this.libDirty = false;
      this.hydratePools();
      api.setDefaultName(this.state.libraryName);
      this.emitConfig();
    } catch (err) {
      this.state.status = "error";
      this.state.error = err && err.message ? err.message : String(err);
      if (!opts.silent) toast("加载词库失败：" + this.state.error, "err");
    }
    this.renderAll();
    return this.state.status === "ready";
  }

  markLibDirty() {
    this.libDirty = true;
    this._dirtySeq += 1;
    this._descVersion += 1; // 词库内容变了，分段翻译索引要重建
    this.renderToolbar();
    this.saveTimer();
  }

  /**
   * 把待保存的修改立刻写盘，并等所有在途保存结束。
   * 导入 / 重命名 / 删除 / 切库之前都必须先调用，否则会拿到磁盘上的旧数据。
   */
  async flushSave() {
    this.saveTimer.cancel();
    if (this.libDirty) {
      this.saveLibraryNow();
    }
    try {
      await this._saveChain;
    } catch (err) {
      /* 具体错误已在 saveLibraryNow 里提示过 */
    }
  }

  /** 保存排队执行，避免两次保存交错把数据写乱 */
  saveLibraryNow() {
    const name = this.state.libraryName;
    if (!name) return Promise.resolve();
    const seq = this._dirtySeq;
    // 立刻快照，防止排队期间状态被切换
    let snapshot;
    try {
      snapshot = JSON.parse(JSON.stringify(this.state.library));
    } catch (err) {
      snapshot = this.state.library;
    }
    const task = () => this._doSave(name, snapshot, seq);
    this._saveChain = this._saveChain.then(task, task);
    return this._saveChain;
  }

  async _doSave(name, snapshot, seq) {
    try {
      const res = await api.saveLibrary(name, snapshot);
      if (this.state.libraryName === name && seq === this._dirtySeq) {
        this.libDirty = false;
      }
      if (res.libraries && res.libraries.length) this.libraries = res.libraries;
      if (res.name && res.name !== name && this.state.libraryName === name) {
        // 兼容旧版后端（会另存为「xxx (用户)」）
        this.state.libraryName = res.name;
        this.state.kind = "user";
        this.emitConfig();
        toast(`内置词库的修改已另存为「${res.name}」`, "ok");
      }
      api.rememberLibrary(this.state.libraryName);
      this.renderToolbar();
      return res;
    } catch (err) {
      toast("保存词库失败：" + err.message, "err");
      this.renderToolbar();
      throw err;
    }
  }

  async createLibrary() {
    const name = await nameDialog({
      title: "新建词库",
      label: "词库名称",
      value: "",
      hint: "新词库是空的，创建后可以点「📥 导入」批量导入 tag。",
    });
    if (!name) return;
    try {
      await this.flushSave();
      this.state.library = ops.emptyLibrary(name);
      this.state.libraryName = name;
      this.state.kind = "user";
      this.state.items = [];
      this.state.ui.group = null;
      this.state.ui.sub = null;
      this.state.status = "ready";
      this.libDirty = false;
      this._dirtySeq = 0;
      const res = await api.saveLibrary(name, this.state.library);
      if (res.libraries) this.libraries = res.libraries;
      this.state.libraryName = res.name || name;
      this.emitConfig();
      api.setDefaultName(this.state.libraryName);
      api.rememberLibrary(this.state.libraryName);
      this.renderAll();
      toast("已创建词库「" + this.state.libraryName + "」", "ok");
    } catch (err) {
      toast("创建失败：" + err.message, "err");
    }
  }

  async renameLibraryNow() {
    const name = this.state.libraryName;
    if (!name) return;
    const newName = await nameDialog({
      title: "重命名词库",
      label: "新名称",
      value: name,
      hint: "重命名只改词库名，不影响里面的 tag。",
    });
    if (!newName || newName === name) return;
    try {
      // 重命名是「读磁盘 → 写新名」，未落盘的修改会丢，先保存
      await this.flushSave();
      const res = await api.renameLibrary(name, newName);
      this.state.libraryName = res.name || newName;
      this.state.kind = "user";
      this.state.library.name = this.state.libraryName;
      if (res.libraries) this.libraries = res.libraries;
      this.emitConfig();
      api.setDefaultName(this.state.libraryName);
      api.rememberLibrary(this.state.libraryName);
      this.renderAll();
      toast("已重命名为「" + this.state.libraryName + "」", "ok");
    } catch (err) {
      toast("重命名失败：" + err.message, "err");
    }
  }

  async deleteLibraryNow() {
    const name = this.state.libraryName;
    if (!name) return;
    const ok = await confirmDialog({
      title: "删除词库",
      message: `确定要删除词库「${name}」吗？此操作不可恢复（如果是内置词库的修改版，删掉后会恢复成内置原版）。`,
      okText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      this.saveTimer.cancel();
      this.libDirty = false;
      const res = await api.deleteLibrary(name);
      if (res.libraries) this.libraries = res.libraries;
      toast("已删除词库「" + name + "」", "ok");
      const next = (this.libraries[0] && this.libraries[0].name) || "";
      this.state.libraryName = "";
      await this.switchLibrary(next, { silent: true });
    } catch (err) {
      toast("删除失败：" + err.message, "err");
    }
  }

  async doImport() {
    const payload = await importDialog({ currentName: this.state.libraryName, mode: "merge" });
    if (!payload) return;

    if (payload.mode === "path") {
      await this.doImportFromPath(payload);
      return;
    }

    try {
      // 关键：导入是「读磁盘 → 合并 → 写回」，先把内存里没保存的改动落盘，
      // 否则导入结果会把它们盖掉，反之亦然。
      await this.flushSave();
      const res = await api.importContent({
        name: this.state.libraryName,
        text: payload.text,
        filename: payload.filename,
        mode: payload.mode,
        newName: payload.newName,
      });
      if (res.libraries) this.libraries = res.libraries;
      this.state.libraryName = res.name || this.state.libraryName;
      this.state.kind = res.kind || "user";
      this.state.library = res.data || this.state.library;
      this.state.status = "ready";
      this.state.ui.group = null;
      this.state.ui.sub = null;
      this.libDirty = false;
      this._dirtySeq = 0;
      this.emitConfig();
      api.setDefaultName(this.state.libraryName);
      api.rememberLibrary(this.state.libraryName);
      this.renderAll();
      const c = res.imported || res.counts || {};
      toast(`导入成功：+${c.tags || 0} 个 tag（当前共 ${(res.counts && res.counts.tags) || 0} 个）`, "ok");
    } catch (err) {
      toast("导入失败：" + err.message, "err");
    }
  }

  /** 从服务器本地路径导入（大文件走这条路，完全不经过浏览器上传） */
  async doImportFromPath(payload) {
    const path = payload.path || "";
    const split = Number(payload.split) || 0;
    const baseName = payload.newName || path.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
    if (!path) return;
    const t = toast("正在读取并解析文件，大文件可能需要几十秒…", "");
    try {
      const res = await api.importPath({
        path,
        name: baseName,
        mode: "new",
        newName: baseName,
        split,
      });
      this.libraries = res.libraryList && res.libraryList.length ? res.libraryList : this.libraries;
      if (res.split && res.libraries.length) {
        const names = res.libraries.map((x) => x.name);
        const totalTags = res.counts ? res.counts.tags : 0;
        toast(`已拆分为 ${names.length} 个词库（共 ${totalTags} 个 tag）：${names.slice(0, 3).join("、")}…`, "ok");
        await this.switchLibrary(names[0], { silent: true });
      } else {
        this.state.libraryName = res.name || this.state.libraryName;
        this.state.kind = res.kind || "user";
        if (res.data) this.state.library = res.data;
        this.state.status = "ready";
        this.state.ui.group = null;
        this.state.ui.sub = null;
        this.libDirty = false;
        this._dirtySeq = 0;
        this.emitConfig();
        api.setDefaultName(this.state.libraryName);
        api.rememberLibrary(this.state.libraryName);
        this.renderAll();
        const c = res.imported || res.counts || {};
        toast(`导入成功：${c.tags || 0} 个 tag`, "ok");
      }
    } catch (err) {
      toast("路径导入失败：" + err.message, "err");
    } finally {
      if (t && t.remove) t.remove();
    }
  }

  async doExport() {
    exportDialog({
      libraryName: this.state.libraryName,
      currentGroup: this.state.ui.group || "",
      currentSub: this.state.ui.sub || "",
      selectedCount: this.state.items.filter((i) => i.enabled !== false).length,
      getData: (scope) => {
        if (scope === "selected") return this.buildSelectedLibrary();
        if (scope === "group") return ops.exportSubset(this.state.library, this.state.ui.group || null, null);
        if (scope === "sub") return ops.exportSubset(this.state.library, this.state.ui.group || null, this.state.ui.sub || null);
        return ops.exportSubset(this.state.library, null, null);
      },
    });
  }

  /* ------------------------------------------------------- 分类 / tag 编辑 */

  async addGroup() {
    const name = await nameDialog({ title: "新建一级分类", label: "分类名称", value: "" });
    if (!name) return;
    if (this.findGroup(name)) {
      toast("已存在同名一级分类", "err");
      return;
    }
    this.groups.push({ name, subs: [] });
    this.state.ui.group = name;
    this.state.ui.sub = null;
    this.markLibDirty();
    this.renderColumns();
  }

  async renameGroup(group) {
    const name = await nameDialog({ title: "重命名一级分类", label: "新名称", value: group.name });
    if (!name || name === group.name) return;
    if (this.findGroup(name)) {
      toast("已存在同名一级分类", "err");
      return;
    }
    const oldName = group.name;
    group.name = name;
    if (this.state.ui.group === oldName) this.state.ui.group = name;
    for (const item of this.state.items) if (item.group === oldName) item.group = name;
    this.markLibDirty();
    this.emitConfig();
    this.renderAll();
  }

  async deleteGroup(group) {
    const count = (group.subs || []).reduce((n, s) => n + (s.tags || []).length, 0);
    const ok = await confirmDialog({
      title: "删除一级分类",
      message: `确定删除一级分类「${group.name}」及其下 ${count} 个 tag 吗？`,
      okText: "删除",
      danger: true,
    });
    if (!ok) return;
    this.state.library.groups = this.groups.filter((g) => g !== group);
    if (this.state.ui.group === group.name) {
      this.state.ui.group = null;
      this.state.ui.sub = null;
    }
    this.markLibDirty();
    this.renderAll();
  }

  async addSub(group) {
    const name = await nameDialog({ title: "新建二级分类", label: `在「${group.name}」下新建二级分类`, value: "" });
    if (!name) return;
    if (this.findSub(group.name, name)) {
      toast("该分类下已存在同名二级分类", "err");
      return;
    }
    group.subs.push({ name, tags: [] });
    this.state.ui.group = group.name;
    this.state.ui.sub = name;
    this.markLibDirty();
    this.renderColumns();
  }

  async renameSub(group, sub) {
    const name = await nameDialog({ title: "重命名二级分类", label: "新名称", value: sub.name });
    if (!name || name === sub.name) return;
    if (this.findSub(group.name, name)) {
      toast("已存在同名二级分类", "err");
      return;
    }
    const oldName = sub.name;
    sub.name = name;
    for (const item of this.state.items) {
      if (item.group === group.name && item.sub === oldName) item.sub = name;
    }
    if (this.state.ui.sub === oldName) this.state.ui.sub = name;
    this.markLibDirty();
    this.emitConfig();
    this.renderAll();
  }

  async deleteSub(group, sub) {
    const ok = await confirmDialog({
      title: "删除二级分类",
      message: `确定删除「${group.name} / ${sub.name}」及其下 ${(sub.tags || []).length} 个 tag 吗？`,
      okText: "删除",
      danger: true,
    });
    if (!ok) return;
    group.subs = group.subs.filter((s) => s !== sub);
    if (this.state.ui.sub === sub.name) this.state.ui.sub = null;
    this.markLibDirty();
    this.renderColumns();
  }

  async addTags(group, sub) {
    if (!sub) return;
    const input = await promptDialog({
      title: "添加 tag",
      label: `添加到「${group.name} / ${sub.name}」`,
      placeholder: "多个 tag 用英文逗号分隔",
      hint: "例：red_hair, blue_eyes, long_hair",
    });
    if (!input) return;
    const list = String(input)
      .split(/[,，\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!list.length) return;
    const lower = new Set((sub.tags || []).map((t) => t.toLowerCase()));
    let added = 0;
    for (const t of list) {
      if (lower.has(t.toLowerCase())) continue;
      lower.add(t.toLowerCase());
      sub.tags.push(t);
      added += 1;
    }
    this.markLibDirty();
    this.renderColumns();
    if (added) toast(`已添加 ${added} 个 tag`, "ok");
  }

  async renameTag(group, sub, tag) {
    const name = await nameDialog({ title: "重命名 tag", label: "新内容", value: tag });
    if (!name || name === tag) return;
    sub.tags = (sub.tags || []).map((t) => (t === tag ? name : t));
    if (sub.descs && typeof sub.descs === "object" && sub.descs[tag] !== undefined) {
      sub.descs[name] = sub.descs[tag];
      delete sub.descs[tag];
    }
    for (const item of this.state.items) if (key(item.text) === key(tag)) item.text = name;
    this.markLibDirty();
    this.emitConfig();
    this.renderAll();
  }

  /** 修改（或添加）某个 tag 的中文翻译 */
  async editDesc(group, sub, tag) {
    if (!sub) return;
    const current = (sub.descs && sub.descs[tag]) || "";
    const value = await promptDialog({
      title: current ? "修改中文翻译" : "添加中文翻译",
      label: `${tag}`,
      value: current,
      placeholder: "例如：红发　（留空 = 删除翻译）",
      hint: "翻译保存在词库里，可以随时再改；留空并确定即删除。",
    });
    if (value === null) return;
    const text = String(value).replace(/\s+/g, " ").trim();
    if (!sub.descs || typeof sub.descs !== "object") sub.descs = {};
    if (text) sub.descs[tag] = text;
    else delete sub.descs[tag];
    if (!Object.keys(sub.descs).length) delete sub.descs;
    this.markLibDirty();
    this.renderTags();
    this.renderSelected();
    this.renderPreview();
    this.renderManualSegments();
    toast(text ? `已更新「${tag}」的翻译：${text}` : `已删除「${tag}」的翻译`, "ok");
  }

  /** 批量设置翻译：{tag: 中文} */
  applyDescs(sub, mapping) {
    if (!sub || !mapping) return 0;
    if (!sub.descs || typeof sub.descs !== "object") sub.descs = {};
    let changed = 0;
    for (const [tag, desc] of Object.entries(mapping)) {
      if (!(sub.tags || []).includes(tag)) continue;
      const text = String(desc || "").trim();
      if (text) {
        if (sub.descs[tag] !== text) {
          sub.descs[tag] = text;
          changed += 1;
        }
      } else if (sub.descs[tag]) {
        delete sub.descs[tag];
        changed += 1;
      }
    }
    if (!Object.keys(sub.descs).length) delete sub.descs;
    return changed;
  }

  async deleteTag(group, sub, tag) {
    sub.tags = (sub.tags || []).filter((t) => t !== tag);
    if (sub.descs && typeof sub.descs === "object") delete sub.descs[tag];
    this.markLibDirty();
    this.renderColumns();
  }

  async batchEditSub(group, sub) {
    const result = await batchTagsDialog({
      group: group.name,
      sub: sub.name,
      tags: sub.tags || [],
      descs: sub.descs || {},
    });
    if (!result) return;
    sub.tags = ops.dedupeTags(result.map((x) => x.tag));
    const descMap = {};
    for (const item of result) if (item.desc) descMap[item.tag] = item.desc;
    // 整份覆盖翻译：没写的就当作删除
    if (Object.keys(descMap).length) sub.descs = descMap;
    else delete sub.descs;
    if (sub.descs) {
      const keep = {};
      for (const t of sub.tags) if (sub.descs[t]) keep[t] = sub.descs[t];
      if (Object.keys(keep).length) sub.descs = keep;
      else delete sub.descs;
    }
    this.markLibDirty();
    this.renderColumns();
    const withDesc = sub.descs ? Object.keys(sub.descs).length : 0;
    toast(`「${sub.name}」现有 ${sub.tags.length} 个 tag，其中 ${withDesc} 个带翻译`, "ok");
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}
