/** 通用小工具：DOM 构造、提示条、复制、节流。 */

/** 快速造元素 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** 空掉一个容器 */
export function clearNode(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 造一个图标按钮 */
export function iconButton(text, title, onClick, extraClass) {
  const button = el("button", "ph-icon-btn" + (extraClass ? " " + extraClass : ""), text);
  button.type = "button";
  button.title = title || "";
  button.setAttribute("aria-label", title || text);
  if (onClick) {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick(event);
    });
  }
  return button;
}

/** 造一个普通按钮 */
export function button(text, className, onClick, title) {
  const node = el("button", "ph-btn" + (className ? " " + className : ""), text);
  node.type = "button";
  if (title) node.title = title;
  if (onClick) {
    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick(event);
    });
  }
  return node;
}

/** 造一个文字链接按钮 */
export function linkButton(text, onClick) {
  const node = el("button", "ph-link", text);
  node.type = "button";
  node.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick(event);
  });
  return node;
}

/** 简单的底部提示条，不依赖 ComfyUI 版本 */
let toastHost = null;

export function toast(message, kind = "info") {
  if (!message) return;
  if (!toastHost || !toastHost.isConnected) {
    toastHost = el("div", "ph-toast-host");
    document.body.appendChild(toastHost);
  }
  const item = el("div", "ph-toast ph-toast-" + kind, String(message));
  toastHost.appendChild(item);
  requestAnimationFrame(() => item.classList.add("is-in"));
  setTimeout(() => {
    item.classList.remove("is-in");
    setTimeout(() => item.remove(), 220);
  }, kind === "error" ? 4200 : 2200);
}

/** 复制到剪贴板（带 execCommand 兜底） */
export async function copyText(text) {
  const value = String(text ?? "");
  if (!value) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (err) {
    /* 剪贴板不可用就往下走兜底方案 */
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    area.style.top = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch (err) {
    return false;
  }
}

/** 节流：同一时间只排一个定时器 */
export function makeScheduler(fn, defaultDelay = 250) {
  let timer = null;
  let delay = defaultDelay;
  const run = () => {
    timer = null;
    fn();
  };
  const schedule = (nextDelay) => {
    if (typeof nextDelay === "number") delay = nextDelay;
    if (timer !== null) return;
    timer = setTimeout(run, delay);
  };
  schedule.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return schedule;
}

/** debounce */
export function debounce(fn, wait = 220) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}

/** 文本摘要（去掉多余空白，用于按钮 / 提示） */
export function summarize(text, max = 60) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max) + "…";
}
