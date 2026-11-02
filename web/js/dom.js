/**
 * 极简 DOM 辅助，避免到处写 innerHTML。
 */

const EVENT_RE = /^on([a-z]+)$/i;

/**
 * 创建元素：
 *   h("div", { class: "x", onclick: fn, dataset: { k: "v" } }, "文字", childNode)
 */
export function h(tag, attrs, ...children) {
  const node = document.createElement(tag);

  if (attrs && typeof attrs === "object" && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;

      const m = key.match(EVENT_RE);
      if (m) {
        node.addEventListener(m[1].toLowerCase(), value);
        continue;
      }
      if (key === "class" || key === "className") {
        node.className = String(value);
        continue;
      }
      if (key === "style" && typeof value === "object") {
        Object.assign(node.style, value);
        continue;
      }
      if (key === "dataset" && typeof value === "object") {
        for (const [dk, dv] of Object.entries(value)) {
          if (dv !== null && dv !== undefined) node.dataset[dk] = String(dv);
        }
        continue;
      }
      if (key === "text") {
        node.textContent = String(value);
        continue;
      }
      if (key === "value" && "value" in node) {
        node.value = value;
        continue;
      }
      if (key === "checked" && "checked" in node) {
        node.checked = Boolean(value);
        continue;
      }
      if (key === "html") {
        node.innerHTML = String(value);
        continue;
      }
      node.setAttribute(key, value === true ? "" : String(value));
    }
  } else if (attrs !== undefined && attrs !== null) {
    children.unshift(attrs);
  }

  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(node, child);
      continue;
    }
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function $(selector, root) {
  return (root || document).querySelector(selector);
}

/** 让元素支持「拖拽排序」，回调给出 fromIndex / toIndex */
export function makeSortable(container, onMove) {
  let dragIndex = null;

  container.addEventListener("dragstart", (ev) => {
    const item = ev.target.closest("[data-idx]");
    if (!item) return;
    dragIndex = Number(item.dataset.idx);
    item.classList.add("dragging");
    ev.dataTransfer.effectAllowed = "move";
    try {
      ev.dataTransfer.setData("text/plain", String(dragIndex));
    } catch (e) {
      /* 某些浏览器需要忽略 */
    }
  });

  container.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    const item = ev.target.closest("[data-idx]");
    container.querySelectorAll(".drop-target").forEach((n) => n.classList.remove("drop-target"));
    if (item) item.classList.add("drop-target");
  });

  container.addEventListener("dragend", () => {
    container.querySelectorAll(".dragging, .drop-target").forEach((n) => {
      n.classList.remove("dragging");
      n.classList.remove("drop-target");
    });
    dragIndex = null;
  });

  container.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const item = ev.target.closest("[data-idx]");
    const from = dragIndex;
    if (item === null || from === null) return;
    const to = Number(item.dataset.idx);
    container.querySelectorAll(".drop-target").forEach((n) => n.classList.remove("drop-target"));
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return;
    onMove(from, to);
  });
}

/** 触发浏览器下载 */
export function downloadText(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "export.txt";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

/** 读取本地文件为文本 */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsText(file, "utf-8");
  });
}

export function debounce(fn, wait) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  /** 取消待执行的任务 */
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  /** 立刻执行（返回 fn 的返回值，可能是 Promise），并取消待执行的任务 */
  wrapped.flush = (...args) => {
    const pending = Boolean(timer);
    if (timer) clearTimeout(timer);
    timer = null;
    return pending ? fn(...args) : undefined;
  };
  wrapped.pending = () => Boolean(timer);
  return wrapped;
}
