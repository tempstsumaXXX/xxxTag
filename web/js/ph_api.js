/** 后端接口封装：自动兼容「/api 前缀」与根路径两种部署方式。 */

import { api } from "../../../scripts/api.js";

const ROUTE = "/prompt_history";
const MODE_API = "api";
const MODE_ROOT = "root";

let resolvedMode = null;

function buildURL(path, mode) {
  if (mode === MODE_API) {
    try {
      if (typeof api.apiURL === "function") return api.apiURL(path);
    } catch (err) {
      /* 老版本前端没有 apiURL，退回根路径 */
    }
  }
  const base = (api && api.api_base) || "";
  return base + path;
}

async function doFetch(path, options) {
  const modes = resolvedMode ? [resolvedMode] : [MODE_API, MODE_ROOT];
  let lastError = null;
  let lastResponse = null;

  for (let index = 0; index < modes.length; index += 1) {
    const mode = modes[index];
    try {
      const response = await fetch(buildURL(path, mode), options);
      if (response.status === 404 && index < modes.length - 1) {
        // 可能是根路径部署或反向代理方式不同，换另一种再试
        lastResponse = response;
        continue;
      }
      resolvedMode = mode;
      return response;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  if (lastResponse) return lastResponse;
  throw new Error("请求失败");
}

async function request(path, { method = "GET", body } = {}) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await doFetch(path, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch (err) {
    payload = null;
  }
  if (!response.ok) {
    const message = (payload && (payload.error || payload.message)) || `HTTP ${response.status}`;
    throw new Error(String(message));
  }
  if (payload && payload.ok === false) {
    throw new Error(payload.error || "操作失败");
  }
  return payload || {};
}

export const phApi = {
  status: () => request(`${ROUTE}/status`),
  list: () => request(`${ROUTE}/list`),
  add: (positive, label) =>
    request(`${ROUTE}/add`, { method: "POST", body: { positive, label } }),
  update: (id, positive) => request(`${ROUTE}/update`, { method: "POST", body: { id, positive } }),
  pin: (id, pinned) => request(`${ROUTE}/pin`, { method: "POST", body: { id, pinned } }),
  reorder: (ids) => request(`${ROUTE}/reorder`, { method: "POST", body: { ids } }),
  importEntries: (entries) => request(`${ROUTE}/import`, { method: "POST", body: { entries } }),
  remove: (ids) => request(`${ROUTE}/delete`, { method: "POST", body: { ids } }),
  clear: () => request(`${ROUTE}/clear`, { method: "POST", body: {} }),
  select: (id) => request(`${ROUTE}/select`, { method: "POST", body: { id: id || null } }),
  settings: (patch) => request(`${ROUTE}/settings`, { method: "POST", body: patch || {} }),
  exportAll: () => request(`${ROUTE}/export`),
  exportSelected: (ids) => request(`${ROUTE}/export`, { method: "POST", body: { ids } }),
};

/** 把服务端返回的相对路径（/prompt_history/... 或 /view?...）变成可访问的 URL */
export function mediaURL(relative) {
  if (!relative) return "";
  return buildURL(relative, resolvedMode || MODE_API);
}
