/**
 * 弹窗 / 提示条等通用 UI。
 */

import { h, readFileAsText, downloadText } from "./dom.js";
import * as ops from "./lib_ops.js";
import * as api from "./tag_api.js";

/* ---------------------------------------------------------------- Toast */

let toastWrap = null;

export function toast(message, type = "") {
  if (!toastWrap || !document.body.contains(toastWrap)) {
    toastWrap = h("div", { class: "ptm-toast-wrap" });
    document.body.appendChild(toastWrap);
  }
  const node = h("div", { class: `ptm-toast ${type || ""}` }, String(message));
  toastWrap.appendChild(node);
  node.remove = () => {
    if (node.parentElement) node.parentElement.removeChild(node);
  };
  setTimeout(() => {
    node.style.transition = "opacity .25s, transform .25s";
    node.style.opacity = "0";
    node.style.transform = "translateY(6px)";
    setTimeout(() => node.remove(), 260);
  }, type === "err" ? 4200 : 2200);
  return node;
}

/* ---------------------------------------------------------------- 基础弹窗 */

/**
 * @param {{title:string, body:Node|Node[], actions?:Array<{label:string, primary?:boolean, danger?:boolean, onClick?:Function}>, width?:string, onClose?:Function}} opts
 */
export function openDialog(opts = {}) {
  const backdrop = h("div", { class: "ptm-modal-backdrop" });
  const dialog = h("div", { class: "ptm-dialog", style: opts.width ? { width: opts.width } : null });

  const closeBtn = h("button", { class: "ptm-btn ghost icon", title: "关闭" }, "✕");
  const head = h(
    "div",
    { class: "ptm-dialog-head" },
    h("span", null, opts.title || ""),
    h("span", { class: "ptm-grow" }),
    closeBtn
  );

  const body = h("div", { class: "ptm-dialog-body" });
  const kids = Array.isArray(opts.body) ? opts.body : [opts.body];
  for (const kid of kids) if (kid) body.appendChild(kid);

  const foot = h("div", { class: "ptm-dialog-foot" });
  const api_ = {
    root: dialog,
    backdrop,
    body,
    foot,
    close(result) {
      if (dialog.dataset.closed === "1") return;
      dialog.dataset.closed = "1";
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      if (opts.onClose) opts.onClose(result);
    },
  };

  for (const action of opts.actions || []) {
    foot.appendChild(
      h(
        "button",
        {
          class: `ptm-btn ${action.primary ? "primary" : ""} ${action.danger ? "danger" : ""}`,
          onclick: async () => {
            if (action.onClick) await action.onClick(api_);
            else api_.close();
          },
        },
        action.label
      )
    );
  }
  if (opts.closable !== false) closeBtn.addEventListener("click", () => api_.close());

  function onKey(ev) {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      api_.close();
    }
  }
  document.addEventListener("keydown", onKey);

  backdrop.addEventListener("mousedown", (ev) => {
    if (ev.target === backdrop) api_.close();
  });

  dialog.appendChild(head);
  dialog.appendChild(body);
  if ((opts.actions || []).length) dialog.appendChild(foot);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  return api_;
}

export function confirmDialog({ title = "确认", message = "", okText = "确定", danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const dlg = openDialog({
      title,
      body: h("div", { class: "ptm-hint" }, message),
      actions: [
        { label: "取消", onClick: (d) => d.close() },
        {
          label: okText,
          primary: !danger,
          danger,
          onClick: (d) => {
            answered = true;
            d.close();
          },
        },
      ],
      onClose: () => resolve(answered),
    });
    setTimeout(() => {
      const btn = dlg.foot.querySelector(".ptm-btn.primary, .ptm-btn.danger");
      if (btn) btn.focus();
    }, 30);
  });
}

export function promptDialog({ title = "请输入", label = "", value = "", placeholder = "", hint = "" }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h("input", { class: "ptm-input", value: value || "", placeholder, style: { width: "100%" } });
    const body = h(
      "div",
      { class: "ptm-field" },
      label ? h("label", null, label) : null,
      input,
      hint ? h("div", { class: "ptm-hint" }, hint) : null
    );
    const dlg = openDialog({
      title,
      body,
      actions: [
        { label: "取消", onClick: (d) => d.close() },
        {
          label: "确定",
          primary: true,
          onClick: (d) => {
            result = input.value;
            d.close();
          },
        },
      ],
      onClose: () => resolve(result),
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        result = input.value;
        dlg.close();
      }
    });
  });
}

/* ---------------------------------------------------------------- 剪贴板 */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    try {
      const area = h("textarea", { style: { position: "fixed", left: "-9999px", top: "0" } });
      area.value = text;
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

/* ---------------------------------------------------------------- 导入 */

/**
 * 批量导入弹窗
 * @param {{currentName:string, mode?:string}} opts
 * @returns {Promise<{text:string, filename:string, mode:string, newName?:string}|null>}
 */
export function importDialog(opts = {}) {
  return new Promise((resolve) => {
    let payload = null;
    let filename = "";
    let text = "";

    const textarea = h("textarea", {
      class: "ptm-textarea",
      placeholder:
        "把 tag 内容粘贴到这里，或在上方选择文件。\n支持：\n  一级分类,二级分类,子项[,中文描述]   （CSV，每行一条）\n  一级分类 > 二级分类 > 子项\n  # 一级分类 / ## 二级分类 / 子项   （TXT 标题风格）\n  JSON（本插件格式 / {一级:{二级:[tag]}} / 三元组数组）\n  WeiLin-Comfyui-Tools 导出的 .sql（tag_groups / tag_subgroups / tag_tags）",
    });
    const fileInput = h("input", { type: "file", accept: ".json,.csv,.txt,.tsv,.sql", style: { display: "none" } });
    const info = h("div", { class: "ptm-hint" }, "尚未选择文件");

    const drop = h(
      "div",
      { class: "ptm-file-drop", onclick: () => fileInput.click() },
      "📂 点击选择文件，或把文件拖到这里（.json / .csv / .txt / .sql）"
    );

    drop.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      drop.classList.remove("over");
      const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (file) await loadFile(file);
    });

    async function loadFile(file) {
      try {
        text = await readFileAsText(file);
        filename = file.name;
        textarea.value = text;
        updateInfo();
      } catch (err) {
        toast("读取文件失败：" + err.message, "err");
      }
    }

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) await loadFile(file);
      fileInput.value = "";
    });

    function updateInfo() {
      const content = textarea.value || "";
      if (!content.trim()) {
        info.textContent = filename ? `${filename}（内容为空）` : "尚未选择文件";
        return;
      }
      try {
        const lib = ops.parseText(content, filename || "粘贴内容.txt", null);
        const c = ops.libraryCounts(lib);
        info.textContent = `${filename || "粘贴内容"}：解析到 ${c.groups} 个一级分类 / ${c.subs} 个二级分类 / ${c.tags} 个 tag`;
        info.style.color = "#37d67a";
      } catch (err) {
        info.textContent = "解析失败：" + err.message;
        info.style.color = "#ff5c6c";
      }
    }
    textarea.addEventListener("input", () => {
      text = textarea.value;
      updateInfo();
    });

    const modeSelect = h(
      "select",
      { class: "ptm-select" },
      h("option", { value: "merge" }, "合并到当前词库（推荐）"),
      h("option", { value: "replace" }, "覆盖当前词库"),
      h("option", { value: "new" }, "保存为新词库")
    );
    modeSelect.value = opts.mode || "merge";

    const newNameInput = h("input", {
      class: "ptm-input",
      placeholder: "新词库名称",
      value: "",
      style: { width: "180px" },
    });
    const newNameField = h("div", { class: "ptm-field-row", style: { display: "none" } }, "新词库名：", newNameInput);

    modeSelect.addEventListener("change", () => {
      newNameField.style.display = modeSelect.value === "new" ? "flex" : "none";
    });
    if (modeSelect.value === "new") newNameField.style.display = "flex";

    const pathInput = h("input", {
      class: "ptm-input",
      placeholder: "D:/tags/xxx.sql",
      style: { flex: "1 1 auto", minWidth: "220px" },
    });
    const splitInput = h("input", {
      class: "ptm-input",
      type: "number",
      min: "0",
      step: "500",
      value: "3000",
      title: "0 = 不拆分；大于 0 时会按二级分类自动拆成多份词库",
      style: { width: "88px" },
    });

    const body = h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "10px" } },
      h(
        "div",
        { class: "ptm-hint" },
        "当前词库：",
        h("b", null, opts.currentName || "（未选择）"),
        "　导入后会自动保存。"
      ),
      drop,
      fileInput,
      h("div", { class: "ptm-field" }, h("label", null, "或直接粘贴内容："), textarea),
      info,
      h("div", { class: "ptm-field-row" }, "导入方式：", modeSelect, newNameField),
      h("hr", { style: { border: "none", borderTop: "1px solid #34343f", margin: "2px 0" } }),
      h(
        "div",
        { class: "ptm-field" },
        h("label", null, "大文件：直接从服务器磁盘路径导入（不经过浏览器，几十甚至上百 MB 都可以）"),
        h(
          "div",
          { class: "ptm-field-row" },
          pathInput,
          h("span", { class: "ptm-hint" }, "每库最多"),
          splitInput,
          h("span", { class: "ptm-hint" }, "个 tag")
        ),
        h(
          "div",
          { class: "ptm-hint" },
          "填 ComfyUI 所在机器上的绝对路径；拆分值 > 0 时会按二级分类切分成「词库名-01、-02…」多份，",
          "填 0 则全部导入成一份（超大词库建议拆分，否则面板打开会很慢）。"
        )
      )
    );

    openDialog({
      title: "批量导入 tag",
      body,
      width: "700px",
      actions: [
        { label: "取消", onClick: (d) => d.close() },
        {
          label: "从路径导入",
          onClick: (d) => {
            const p = (pathInput.value || "").trim();
            if (!p) {
              toast("请先填写服务器上的文件绝对路径", "err");
              return;
            }
            const split = Number(splitInput.value) || 0;
            const newName = (newNameInput.value || "").trim() || null;
            payload = { mode: "path", path: p, split, filename: p, text: "", newName };
            d.close();
          },
        },
        {
          label: "开始导入",
          primary: true,
          onClick: async (d) => {
            const content = textarea.value || "";
            if (!content.trim()) {
              toast("请先选择文件或粘贴内容", "err");
              return;
            }
            const mode = modeSelect.value;
            const newName = newNameInput.value.trim();
            if (mode === "new" && !newName) {
              toast("请填写新词库名称", "err");
              return;
            }
            payload = { text: content, filename, mode, newName };
            d.close();
          },
        },
      ],
      onClose: () => resolve(payload),
    });
  });
}

/* ---------------------------------------------------------------- 导出 */

/**
 * 批量导出弹窗
 * @param {{libraryName:string, getData:(scope:"all"|"group"|"sub"|"selected")=>object, currentGroup?:string, currentSub?:string, selectedCount:number}} opts
 */
export function exportDialog(opts = {}) {
  const fmt = h(
    "select",
    { class: "ptm-select" },
    h("option", { value: "json" }, "JSON（本插件格式，可再次导入）"),
    h("option", { value: "csv" }, "CSV（一级分类,二级分类,子项）"),
    h("option", { value: "txt" }, "TXT（标题 + 每行一个 tag）")
  );

  const scope = h(
    "select",
    { class: "ptm-select" },
    h("option", { value: "all" }, "整个词库"),
    h("option", { value: "group" }, `当前一级分类（${opts.currentGroup || "未选择"}）`),
    h("option", { value: "sub" }, `当前二级分类（${opts.currentSub || "未选择"}）`),
    h("option", { value: "selected" }, `仅已选择的 tag（${opts.selectedCount || 0} 个）`)
  );
  if (!opts.currentGroup) scope.querySelectorAll("option")[1].disabled = true;
  if (!opts.currentSub) scope.querySelectorAll("option")[2].disabled = true;
  if (!opts.selectedCount) scope.querySelectorAll("option")[3].disabled = true;

  const info = h("div", { class: "ptm-hint" }, "");
  const preview = h("textarea", { class: "ptm-textarea", readonly: true, style: { minHeight: "170px" } });

  let current = null;

  async function refresh() {
    const data = opts.getData(scope.value);
    const counts = ops.libraryCounts(data);
    info.textContent = `${counts.groups} 个一级分类 / ${counts.subs} 个二级分类 / ${counts.tags} 个 tag`;
    try {
      const out = await api.exportContent({ data, format: fmt.value });
      current = out;
      preview.value = out.content.length > 20000 ? out.content.slice(0, 20000) + "\n…（内容过长，已截断显示）" : out.content;
    } catch (err) {
      const out = ops.exportLibrary(data, fmt.value);
      current = out;
      preview.value = out.content;
      info.textContent += "（本地导出）";
    }
  }

  fmt.addEventListener("change", refresh);
  scope.addEventListener("change", refresh);

  const body = h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "10px" } },
    h("div", { class: "ptm-hint" }, "词库：", h("b", null, opts.libraryName || "")),
    h("div", { class: "ptm-field-row" }, "导出格式：", fmt, "范围：", scope),
    info,
    preview
  );

  const dlg = openDialog({
    title: "导出 tag",
    body,
    width: "680px",
    actions: [
      {
        label: "复制到剪贴板",
        onClick: async () => {
          if (!current) return;
          const ok = await copyText(current.content);
          toast(ok ? "已复制到剪贴板" : "复制失败，请手动选择文本", ok ? "ok" : "err");
        },
      },
      {
        label: "下载文件",
        primary: true,
        onClick: () => {
          if (!current) return;
          downloadText(current.filename, current.content);
          toast("已开始下载 " + current.filename, "ok");
          dlg.close();
        },
      },
    ],
  });

  refresh();
}

/* ---------------------------------------------------------------- 翻译设置 */

/**
 * 翻译服务设置弹窗
 * @param {{settings:object}} opts 由后端 /translate/settings 返回的设置
 * @returns {Promise<object|null>} 保存后的设置；取消返回 null
 */
export function translateSettingsDialog(opts = {}) {
  return new Promise((resolve) => {
    const current = opts.settings || {};
    let saved = null;

    const providerSel = h("select", { class: "ptm-select", style: { width: "100%" } });
    const labels = current.provider_labels || {};
    for (const name of current.providers || ["mymemory"]) {
      providerSel.appendChild(h("option", { value: name }, labels[name] || name));
    }
    providerSel.value = current.provider || "mymemory";

    const targetSel = h("select", { class: "ptm-select", style: { width: "120px" } });
    for (const lang of current.target_langs || ["zh-CN"]) {
      targetSel.appendChild(h("option", { value: lang }, lang));
    }
    targetSel.value = current.target || "zh-CN";

    const sourceSel = h("select", { class: "ptm-select", style: { width: "130px" } });
    for (const lang of current.source_langs || ["auto"]) {
      sourceSel.appendChild(h("option", { value: lang }, lang === "auto" ? "auto（自动）" : lang));
    }
    sourceSel.value = current.source || "auto";

    const keyInput = h("input", {
      class: "ptm-input",
      placeholder: current.has_api_key ? "已保存（留空表示不改）" : "可选，仅 LibreTranslate 之类的服务需要",
      style: { width: "100%" },
    });
    const baseInput = h("input", {
      class: "ptm-input",
      value: current.base_url || "",
      placeholder: "例如 https://your-libretranslate-host",
      style: { width: "100%" },
    });
    const fallbackCheck = h("input", { type: "checkbox", checked: current.fallback !== false });
    const resultLine = h("div", { class: "ptm-hint" }, "");
    const providerHint = h("div", { class: "ptm-hint" }, "");

    function syncProviderUi() {
      const isLibre = providerSel.value === "libretranslate";
      const isFake = providerSel.value === "fake";
      keyInput.disabled = !isLibre;
      baseInput.disabled = !isLibre;
      providerHint.textContent = isFake
        ? "离线测试用：不联网，直接在原文前加标记返回，方便验证界面流程。"
        : isLibre
          ? "LibreTranslate 需要填接口地址；自建实例通常不需要 Key。"
          : providerSel.value === "google"
            ? "Google 免费接口无需 Key，但需要能访问 translate.googleapis.com（部分地区可能不通）。"
            : "MyMemory 免费、无需 Key，匿名有每日额度限制，够日常用。";
    }
    providerSel.addEventListener("change", syncProviderUi);
    syncProviderUi();

    const collect = () => {
      const patch = {
        provider: providerSel.value,
        source: sourceSel.value,
        target: targetSel.value,
        base_url: baseInput.value.trim(),
        fallback: fallbackCheck.checked,
      };
      const key = keyInput.value.trim();
      if (key) patch.api_key = key;
      return patch;
    };

    const testBtn = h(
      "button",
      {
        class: "ptm-btn",
        onclick: async () => {
          resultLine.textContent = "正在测试…";
          resultLine.style.color = "#9a9aa8";
          try {
            const res = await api.testTranslate(collect());
            if (res.ok) {
              resultLine.textContent = `成功（${res.ms} ms，${res.provider}）：${res.sample} → ${res.result}`;
              resultLine.style.color = "#37d67a";
            } else {
              resultLine.textContent = `失败（${res.provider}）：${res.error || "未知错误"}`;
              resultLine.style.color = "#ff5c6c";
            }
          } catch (err) {
            resultLine.textContent = "测试失败：" + err.message;
            resultLine.style.color = "#ff5c6c";
          }
        },
      },
      "测试翻译"
    );

    const body = h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "10px" } },
      h("div", { class: "ptm-field" }, h("label", null, "翻译服务"), providerSel, providerHint),
      h(
        "div",
        { class: "ptm-field-row" },
        h("span", { class: "ptm-hint" }, "源语言"),
        sourceSel,
        h("span", { class: "ptm-hint" }, "目标语言"),
        targetSel,
        h("label", { class: "ptm-check", title: "首选服务失败时自动换另一个免费服务再试" }, fallbackCheck, "自动回退")
      ),
      h("div", { class: "ptm-field" }, h("label", null, "接口地址 base_url（LibreTranslate 用）"), baseInput),
      h("div", { class: "ptm-field" }, h("label", null, "API Key（可选）"), keyInput),
      h("div", { class: "ptm-field-row" }, testBtn, resultLine),
      h(
        "div",
        { class: "ptm-hint" },
        "翻译结果会缓存到 ComfyUI/user/prompt_tag_manager/.translate_cache.json，同样的内容不会重复请求。"
      )
    );

    openDialog({
      title: "翻译设置",
      body,
      width: "620px",
      actions: [
        { label: "取消", onClick: (d) => d.close() },
        {
          label: "保存",
          primary: true,
          onClick: async (d) => {
            try {
              saved = await api.saveTranslateSettings(collect());
              toast("翻译设置已保存", "ok");
              d.close();
            } catch (err) {
              toast("保存失败：" + err.message, "err");
            }
          },
        },
      ],
      onClose: () => resolve(saved),
    });
  });
}

/* ---------------------------------------------------------------- 批量编辑 */

/**
 * 批量编辑某个二级分类下的 tag（每行一个，可写成 `tag = 中文翻译`）
 * @returns {Promise<{tags: Node[], descs: Array<{tag:string, desc:string}>}|null>}
 *   tags 为文本节点数组（保持原样交给调用方解析）
 */
export function batchTagsDialog({ group, sub, tags, descs }) {
  return new Promise((resolve) => {
    let result = null;
    const descMap = descs && typeof descs === "object" ? descs : {};
    const initial = (tags || []).map((t) => (descMap[t] ? `${t} = ${descMap[t]}` : t)).join("\n");

    const textarea = h("textarea", { class: "ptm-textarea", style: { minHeight: "280px" } }, initial);

    const counter = h("div", { class: "ptm-hint" }, "");
    const parse = () =>
      (textarea.value || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const idx = line.indexOf("=");
          // 只在 " = " 这种分隔处切开，避免误伤 tag 内部的等号
          if (idx > 0 && /\s=\s|\s=$/.test(line.slice(Math.max(0, idx - 1), idx + 2))) {
            return { tag: line.slice(0, idx).trim(), desc: line.slice(idx + 1).trim() };
          }
          return { tag: line, desc: "" };
        });

    const update = () => {
      const list = parse();
      const withDesc = list.filter((x) => x.desc).length;
      counter.textContent = `当前 ${list.length} 行，其中 ${withDesc} 行带翻译`;
    };
    textarea.addEventListener("input", update);
    update();

    const body = h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "8px" } },
      h(
        "div",
        { class: "ptm-hint" },
        "词库：",
        h("b", null, `${group} / ${sub}`),
        "　每行一个 tag；想改翻译就写成 ",
        h("code", null, "tag = 中文翻译"),
        "，把翻译删掉即表示删除该 tag 的翻译。删掉的行会从词库删除，新加的行会添加。"
      ),
      textarea,
      counter
    );

    openDialog({
      title: "批量编辑 tag 与翻译",
      body,
      width: "620px",
      actions: [
        { label: "取消", onClick: (d) => d.close() },
        {
          label: "保存",
          primary: true,
          onClick: (d) => {
            result = parse();
            d.close();
          },
        },
      ],
      onClose: () => resolve(result),
    });
    setTimeout(() => textarea.focus(), 30);
  });
}

/** 新建/编辑某个分类名的小弹窗 */
export async function nameDialog({ title, label, value = "", hint = "" }) {
  const res = await promptDialog({ title, label, value, hint });
  if (res === null) return null;
  const trimmed = res.trim();
  if (!trimmed) {
    toast("名称不能为空", "err");
    return null;
  }
  return trimmed;
}
