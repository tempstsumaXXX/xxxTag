/**
 * 纯逻辑：词库的规范化 / 解析 / 合并 / 导出 / 提示词预览。
 * 与后端 Python (tag_store.py / prompt_builder.py) 行为保持一致，
 * 这样即使后端接口不可用（离线模式）功能也不打折。
 */

export const DEFAULT_GROUP = "未分类";
export const DEFAULT_SUB = "默认";

const DELIMITERS = ["\t", ",", "，", "|", "｜", "::", "：", " > ", "＞", ">", " / ", "/"];

const HEADER_WORDS = new Set([
  "一级", "一级分类", "分类", "大类", "group", "category", "primary", "主分类",
  "二级", "二级分类", "子分类", "sub", "subgroup", "secondary", "小类",
  "子项", "标签", "tag", "tags", "item", "items", "关键词", "keyword", "keywords",
  "内容", "描述", "desc", "description", "weight", "权重",
]);

const FORBIDDEN = new Set(['<', '>', ':', '"', "/", "\\", "|", "?", "*"]);

/* ------------------------------------------------------------------ 基础 */

export function sanitizeName(name, fallback = "新词库") {
  let out = "";
  for (const ch of String(name == null ? "" : name)) {
    if (FORBIDDEN.has(ch) || ch.charCodeAt(0) < 32) continue;
    out += ch;
  }
  out = out.trim().replace(/^\.+/, "").replace(/\.+$/, "").trim();
  if (!out) out = fallback;
  return out.slice(0, 64);
}

export function cleanTag(value) {
  let tag = value;
  if (tag && typeof tag === "object") {
    for (const key of ["text", "tag", "name", "value", "label"]) {
      if (typeof tag[key] === "string") {
        tag = tag[key];
        break;
      }
    }
    if (tag && typeof tag === "object") tag = "";
  }
  return String(tag == null ? "" : tag)
    .replace(/[\r\n]/g, " ")
    // 零宽空格 / BOM / 软连字符等不可见字符会让 tag 静默失效
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff\u00ad]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function dedupeTags(list) {
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const tag = cleanTag(item);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export function emptyLibrary(name = "默认词库") {
  return { name: sanitizeName(name, "默认词库"), version: 1, updated_at: "", groups: [] };
}

function toTagArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

/* -------------------------------------------------------------- 规范化 */

export function libraryCounts(lib) {
  const groups = (lib && lib.groups) || [];
  let subs = 0;
  let tags = 0;
  for (const g of groups) {
    for (const s of g.subs || []) {
      subs += 1;
      tags += (s.tags || []).length;
    }
  }
  return { groups: groups.length, subs, tags };
}

/** 把 tag 列表拆成 (文本数组, 描述字典)，tag 可以是字符串或 {text, desc} */
function collectTags(raw, descs) {
  const found = {};
  const texts = [];
  for (const item of toTagArray(raw)) {
    const text = cleanTag(item);
    if (item && typeof item === "object") {
      const desc = item.desc || item.description || item["中文"] || item.note;
      if (typeof desc === "string" && text && desc.trim()) found[text] = desc.trim();
    }
    if (text) texts.push(text);
  }
  if (descs && typeof descs === "object" && !Array.isArray(descs)) {
    for (const [key, value] of Object.entries(descs)) {
      const text = cleanTag(key);
      if (text && typeof value === "string" && value.trim() && !(text in found)) {
        found[text] = value.trim();
      }
    }
  }
  return { texts: dedupeTags(texts), descs: found };
}

function addSub(group, sname, tags, descs) {
  const name = sname || DEFAULT_SUB;
  const collected = collectTags(tags, descs);
  const incoming = collected.texts;
  const existing = group.subs.find((s) => s.name === name);

  if (existing) {
    existing.tags = dedupeTags(existing.tags.concat(incoming));
    const keys = Object.keys(collected.descs);
    if (keys.length) {
      if (!existing.descs || typeof existing.descs !== "object") existing.descs = {};
      for (const key of keys) {
        if (!(key in existing.descs)) existing.descs[key] = collected.descs[key];
      }
    }
    return;
  }

  const entry = { name, tags: incoming };
  if (Object.keys(collected.descs).length) entry.descs = collected.descs;
  group.subs.push(entry);
}

/** 只保留确实存在的 tag 的描述 */
function pruneDescs(sub) {
  if (!sub || typeof sub !== "object") return sub;
  const descs = sub.descs;
  if (!descs || typeof descs !== "object" || !Object.keys(descs).length) {
    delete sub.descs;
    return sub;
  }
  const index = new Map();
  for (const t of sub.tags || []) index.set(String(t).toLowerCase(), t);
  const keep = {};
  for (const [key, value] of Object.entries(descs)) {
    const real = index.get(String(key).toLowerCase());
    if (real && typeof value === "string" && value.trim()) keep[real] = value.trim();
  }
  if (Object.keys(keep).length) sub.descs = keep;
  else delete sub.descs;
  return sub;
}

function normalizeGroups(groups) {
  const out = [];
  const index = new Map();

  for (let g of groups || []) {
    if (typeof g === "string") g = { name: g };
    if (!g || typeof g !== "object") continue;
    const gname = cleanTag(g.name || g.group || g.title) || DEFAULT_GROUP;

    let target = index.get(gname);
    if (!target) {
      target = { name: gname, subs: [] };
      index.set(gname, target);
      out.push(target);
    }

    const rawSubs = g.subs || g.groups || g.children || g.subgroups;
    const directTags = g.tags || g.items;

    if (rawSubs && !Array.isArray(rawSubs) && typeof rawSubs === "object") {
      for (const [sname, sval] of Object.entries(rawSubs)) {
        addSub(target, cleanTag(sname), sval);
      }
    } else if (Array.isArray(rawSubs)) {
      for (const sg of rawSubs) {
        if (typeof sg === "string") addSub(target, sg, []);
        else if (sg && typeof sg === "object") {
          addSub(target, cleanTag(sg.name || sg.sub || sg.title), sg.tags || sg.items || [], sg.descs);
        }
      }
    } else if (rawSubs == null && directTags != null) {
      addSub(target, DEFAULT_SUB, directTags, g.descs);
    }

    if (directTags != null && rawSubs != null) addSub(target, DEFAULT_SUB, directTags, g.descs);
  }

  return out.filter((g) => g.subs.length > 0);
}

function normalizeMapping(mapping) {
  const out = [];
  const index = new Map();
  for (const [gname, gval] of Object.entries(mapping || {})) {
    const name = cleanTag(gname) || DEFAULT_GROUP;
    let target = index.get(name);
    if (!target) {
      target = { name, subs: [] };
      index.set(name, target);
      out.push(target);
    }
    if (gval && typeof gval === "object" && !Array.isArray(gval)) {
      for (const [sname, sval] of Object.entries(gval)) {
        addSub(target, cleanTag(sname) || DEFAULT_SUB, sval);
      }
    } else {
      addSub(target, DEFAULT_SUB, gval);
    }
  }
  return out;
}

function normalizeList(items) {
  const out = [];
  const index = new Map();

  const targetFor = (gname) => {
    let target = index.get(gname);
    if (!target) {
      target = { name: gname, subs: [] };
      index.set(gname, target);
      out.push(target);
    }
    return target;
  };

  for (const item of items || []) {
    if (Array.isArray(item)) {
      const parts = item.map((p) => cleanTag(p)).filter(Boolean);
      if (!parts.length) continue;
      let gname;
      let sname;
      let tags;
      if (parts.length >= 3) {
        [gname, sname] = parts;
        tags = parts.slice(2);
      } else if (parts.length === 2) {
        gname = parts[0];
        sname = DEFAULT_SUB;
        tags = [parts[1]];
      } else {
        gname = DEFAULT_GROUP;
        sname = DEFAULT_SUB;
        tags = [parts[0]];
      }
      addSub(targetFor(gname), sname, tags);
    } else if (item && typeof item === "object") {
      const gname =
        cleanTag(item.group || item.category || item["一级"] || item.primary || "") || DEFAULT_GROUP;
      const sname =
        cleanTag(item.sub || item.subgroup || item["二级"] || item.secondary || "") || DEFAULT_SUB;
      addSub(targetFor(gname), sname, item.tags || item.tag || item.text || [], item.descs);
    } else {
      const tag = cleanTag(item);
      if (!tag) continue;
      addSub(targetFor(DEFAULT_GROUP), DEFAULT_SUB, [tag]);
    }
  }

  return out.filter((g) => g.subs.length > 0);
}

export function normalizeLibrary(raw, name = "") {
  let libName = name ? sanitizeName(name, "") : "";
  let groups = [];
  let updatedAt = "";

  if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.groups && Array.isArray(raw.groups)) {
    libName = libName || cleanTag(raw.name);
    updatedAt = raw.updated_at || "";
    groups = normalizeGroups(raw.groups);
  } else if (Array.isArray(raw)) {
    groups = normalizeList(raw);
  } else if (raw && typeof raw === "object") {
    libName = libName || cleanTag(raw.name);
    updatedAt = raw.updated_at || "";
    if (raw.tags && Array.isArray(raw.tags)) {
      groups = normalizeGroups([
        { name: cleanTag(raw.name) || DEFAULT_GROUP, tags: raw.tags, descs: raw.descs },
      ]);
    } else {
      groups = normalizeMapping(raw);
    }
  }

  for (const g of groups) {
    for (const s of g.subs || []) pruneDescs(s);
  }

  return { name: libName || "导入词库", version: 1, updated_at: updatedAt, groups };
}

/* ---------------------------------------------------------------- 解析 */

function detectDelimiter(line) {
  for (const d of DELIMITERS) {
    if (line.includes(d)) return d;
  }
  return null;
}

function looksLikeHeader(parts) {
  const cleaned = parts.map((p) => p.replace(/^"|"$/g, "").trim().toLowerCase()).filter(Boolean);
  if (cleaned.length < 2) return false;
  return cleaned.every((p) => HEADER_WORDS.has(p));
}

export function parseText(text, filename = "", name = "") {
  const content = String(text == null ? "" : text).replace(/^\ufeff/, "");
  const stem = String(filename || "").replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const libName = sanitizeName(name || stem || "导入词库", "导入词库");
  const stripped = content.trim();

  if (stripped.startsWith("{") || stripped.startsWith("[")) {
    try {
      return normalizeLibrary(JSON.parse(stripped), libName);
    } catch (err) {
      if (/\.json$/i.test(filename || "")) throw new Error("JSON 解析失败，请检查文件是否合法");
    }
  } else if (/\.json$/i.test(filename || "")) {
    throw new Error("文件内容不是合法的 JSON");
  }

  if (looksLikeSql(content)) return parseSql(content, libName);
  if (/\.sql$/i.test(filename || "")) {
    throw new Error("没有在 SQL 里找到 tag_groups / tag_subgroups / tag_tags 的 INSERT 语句");
  }

  return parseLines(content, libName);
}

/* ------------------------------------------- WeiLin 导出的 SQLite .sql 解析 */

const SQL_TABLES = new Set(["tag_groups", "tag_subgroups", "tag_tags"]);

/** 粗略判断是不是 SQL INSERT 脚本 */
export function looksLikeSql(text) {
  const head = String(text || "").slice(0, 4000).toUpperCase();
  if (!head.includes("INSERT")) return false;
  return head.includes("TAG_GROUPS") || head.includes("TAG_SUBGROUPS") || head.includes("TAG_TAGS");
}

function splitSqlStatements(text) {
  const out = [];
  let buf = "";
  let inStr = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      buf += ch;
      if (ch === "'") {
        if (text[i + 1] === "'") {
          buf += "'";
          i += 1;
          continue;
        }
        inStr = false;
      }
      continue;
    }
    if (ch === "'") {
      inStr = true;
      buf += ch;
    } else if (ch === ";") {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = "";
    } else {
      buf += ch;
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

function parseSqlValueRows(text) {
  const rows = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && " \t\r\n,".includes(text[i])) i += 1;
    if (text[i] !== "(") break;
    i += 1;
    const row = [];
    let cur = "";
    let inStr = false;
    while (i < text.length) {
      const ch = text[i];
      if (inStr) {
        if (ch === "'") {
          if (text[i + 1] === "'") {
            cur += "'";
            i += 2;
            continue;
          }
          inStr = false;
          i += 1;
          continue;
        }
        cur += ch;
        i += 1;
        continue;
      }
      if (ch === "'") {
        inStr = true;
        i += 1;
        continue;
      }
      if (ch === ",") {
        row.push(cur);
        cur = "";
        i += 1;
        continue;
      }
      if (ch === ")") {
        row.push(cur);
        i += 1;
        break;
      }
      cur += ch;
      i += 1;
    }
    rows.push(row.map((v) => v.trim()));
  }
  return rows;
}

function toTime(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** 把 WeiLin 导出的 .sql 解析成三级词库 */
export function parseSql(text, name = "导入词库") {
  const groups = new Map();
  const subs = new Map();
  const tags = [];
  let sawTable = false;

  for (const stmt of splitSqlStatements(text)) {
    const m = stmt.match(/^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(.+?)\s*\((.*?)\)\s*VALUES([\s\S]*)$/i);
    if (!m) continue;
    const table = m[1]
      .trim()
      .replace(/^["'`\[]|["'`\]]$/g, "")
      .split(".")
      .pop()
      .replace(/^["'`\[]|["'`\]]$/g, "")
      .toLowerCase();
    if (!SQL_TABLES.has(table)) continue;
    sawTable = true;

    const cols = m[2].split(",").map((c) => c.trim().replace(/^["'`\[]|["'`\]]$/g, "").toLowerCase());
    for (const row of parseSqlValueRows(m[3])) {
      const rec = {};
      cols.forEach((col, idx) => {
        rec[col] = row[idx] === undefined ? "" : row[idx];
      });
      if (table === "tag_groups") {
        const uid = cleanTag(rec.p_uuid);
        if (uid) groups.set(uid, { name: cleanTag(rec.name), time: toTime(rec.create_time) });
      } else if (table === "tag_subgroups") {
        const uid = cleanTag(rec.g_uuid);
        if (uid) {
          subs.set(uid, {
            name: cleanTag(rec.name),
            groupUuid: cleanTag(rec.p_uuid),
            time: toTime(rec.create_time),
          });
        }
      } else {
        const tagText = cleanTag(rec.text);
        if (!tagText) continue;
        tags.push({
          text: tagText,
          desc: cleanTag(rec.desc),
          subUuid: cleanTag(rec.g_uuid),
          time: toTime(rec.create_time),
        });
      }
    }
  }

  if (!sawTable) throw new Error("SQL 里没有找到 tag_groups / tag_subgroups / tag_tags 表");

  const tagsBySub = new Map();
  for (const item of tags) {
    if (!tagsBySub.has(item.subUuid)) tagsBySub.set(item.subUuid, []);
    tagsBySub.get(item.subUuid).push(item);
  }
  for (const list of tagsBySub.values()) {
    list.sort((a, b) => b.time - a.time || a.text.localeCompare(b.text));
  }

  const subsByGroup = new Map();
  for (const [uuid, info] of subs) {
    if (!subsByGroup.has(info.groupUuid)) subsByGroup.set(info.groupUuid, []);
    subsByGroup.get(info.groupUuid).push([uuid, info]);
  }
  for (const list of subsByGroup.values()) {
    list.sort((a, b) => a[1].time - b[1].time || String(a[1].name).localeCompare(String(b[1].name)));
  }

  const makeSub = (group, subInfo, subUuid) => {
    const list = tagsBySub.get(subUuid) || [];
    const texts = list.map((t) => t.text);
    const descs = {};
    for (const t of list) if (t.desc) descs[t.text] = t.desc;
    addSub(group, subInfo ? subInfo.name || DEFAULT_SUB : DEFAULT_SUB, texts, descs);
  };

  const outGroups = [];
  const ordered = Array.from(groups.entries()).sort(
    (a, b) => a[1].time - b[1].time || String(a[1].name).localeCompare(String(b[1].name))
  );
  for (const [uuid, info] of ordered) {
    const group = { name: info.name || DEFAULT_GROUP, subs: [] };
    for (const [subUuid, subInfo] of subsByGroup.get(uuid) || []) makeSub(group, subInfo, subUuid);
    if (group.subs.length) outGroups.push(group);
  }

  const orphans = Array.from(subs.entries()).filter(([, info]) => !groups.has(info.groupUuid));
  if (orphans.length) {
    const group = { name: DEFAULT_GROUP, subs: [] };
    for (const [subUuid, subInfo] of orphans) makeSub(group, subInfo, subUuid);
    if (group.subs.length) outGroups.push(group);
  }

  if (!outGroups.length) throw new Error("SQL 解析完成，但没有任何 tag 数据");

  return normalizeLibrary(
    { name: libName_of(name) , groups: outGroups },
    libName_of(name)
  );
}

function libName_of(name) {
  return sanitizeName(name || "导入词库", "导入词库");
}

function parseLines(text, libName) {
  const groups = new Map();
  const descsMap = new Map();
  const order = [];
  const state = { group: DEFAULT_GROUP, sub: DEFAULT_SUB };
  let delimiter;
  let first = true;

  const bucket = (gname, sname) => {
    if (!groups.has(gname)) {
      groups.set(gname, new Map());
      order.push(gname);
    }
    const g = groups.get(gname);
    if (!g.has(sname)) g.set(sname, []);
    return g.get(sname);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    const stripped = line.trim();
    if (!stripped) continue;

    if (stripped.startsWith("#")) {
      const level = stripped.length - stripped.replace(/^#+/, "").length;
      const title = stripped.replace(/^#+/, "").trim();
      if (!title) continue;
      if (level <= 1) {
        state.group = title;
        state.sub = DEFAULT_SUB;
      } else {
        state.sub = title;
      }
      continue;
    }

    if (delimiter === null || delimiter === undefined) {
      const detected = detectDelimiter(stripped);
      if (detected) delimiter = detected;
    }
    const parts = (delimiter ? stripped.split(delimiter) : [stripped]).map((p) => p.trim()).filter((p) => p !== "");
    if (!parts.length) continue;

    if (first && looksLikeHeader(parts)) {
      first = false;
      continue;
    }
    first = false;

    let gname;
    let sname;
    let tag;
    let desc = "";
    if (parts.length >= 4) {
      [gname, sname, tag, desc] = parts;
    } else if (parts.length === 3) {
      [gname, sname, tag] = parts;
    } else if (parts.length === 2) {
      gname = parts[0];
      sname = DEFAULT_SUB;
      tag = parts[1];
    } else {
      gname = state.group;
      sname = state.sub;
      tag = parts[0];
    }

    const cleanT = cleanTag(tag);
    if (!cleanT) continue;
    const gkey = gname || DEFAULT_GROUP;
    const skey = sname || DEFAULT_SUB;
    const list = bucket(gkey, skey);
    if (!list.some((t) => t.toLowerCase() === cleanT.toLowerCase())) list.push(cleanT);
    const cleanD = cleanTag(desc);
    if (cleanD) descsMap.set(`${gkey}\u0000${skey}\u0000${cleanT.toLowerCase()}`, cleanD);
  }

  return normalizeLibrary({
    name: libName,
    updated_at: new Date().toISOString().slice(0, 19),
    groups: order.map((gname) => ({
      name: gname,
      subs: Array.from(groups.get(gname).entries()).map(([s, t]) => {
        const entry = { name: s, tags: t };
        const descs = {};
        for (const tag of t) {
          const key = `${gname}\u0000${s}\u0000${tag.toLowerCase()}`;
          if (descsMap.has(key)) descs[tag] = descsMap.get(key);
        }
        if (Object.keys(descs).length) entry.descs = descs;
        return entry;
      }),
    })),
  }, libName);
}

/* ---------------------------------------------------------------- 合并 */

export function mergeLibrary(base, incoming) {
  const result = normalizeLibrary(base || {}, (base && base.name) || "");
  const inc = normalizeLibrary(incoming || {});
  const index = new Map();

  for (const g of result.groups) index.set(g.name, g);

  for (const g of inc.groups) {
    let target = index.get(g.name);
    if (!target) {
      target = { name: g.name, subs: [] };
      index.set(g.name, target);
      result.groups.push(target);
    }
    for (const s of g.subs) addSub(target, s.name, s.tags, s.descs);
  }

  result.updated_at = new Date().toISOString().slice(0, 19);
  return result;
}

/* ---------------------------------------------------------------- 导出 */

function csvEscape(value) {
  return /[",\n\r]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}

export function exportLibrary(lib, fmt = "json") {
  const data = normalizeLibrary(lib || {}, (lib && lib.name) || "");
  const stem = sanitizeName(data.name || "词库", "词库");

  if (fmt === "csv") {
    const hasDesc = data.groups.some((g) =>
      (g.subs || []).some((s) => s.descs && Object.keys(s.descs).length)
    );
    const lines = [];
    for (const g of data.groups) {
      for (const s of g.subs) {
        const descs = s.descs && typeof s.descs === "object" ? s.descs : {};
        for (const t of s.tags) {
          const cells = [csvEscape(g.name), csvEscape(s.name), csvEscape(t)];
          if (hasDesc) cells.push(csvEscape(descs[t] || ""));
          lines.push(cells.join(","));
        }
      }
    }
    return { filename: stem + ".csv", content: "\ufeff" + lines.join("\n") + "\n", mime: "text/csv" };
  }

  if (fmt === "txt") {
    const lines = [];
    for (const g of data.groups) {
      lines.push("# " + g.name);
      for (const s of g.subs) {
        lines.push("## " + s.name);
        for (const t of s.tags) lines.push(t);
      }
    }
    return { filename: stem + ".txt", content: lines.join("\n") + "\n", mime: "text/plain" };
  }

  return {
    filename: stem + ".json",
    content: JSON.stringify(data, null, 2),
    mime: "application/json",
  };
}

export function exportSubset(lib, group, sub) {
  const data = normalizeLibrary(lib || {}, (lib && lib.name) || "");
  if (!group) return data;
  const groups = [];
  for (const g of data.groups) {
    if (g.name !== group) continue;
    if (!sub) {
      groups.push(g);
      continue;
    }
    const subs = g.subs.filter((s) => s.name === sub);
    if (subs.length) groups.push({ name: g.name, subs });
  }
  data.groups = groups;
  return data;
}

/* ------------------------------------------------------- 提示词预览构建 */

export const WEIGHT_STYLES = ["不输出权重", "(tag:1.2)", "tag:1.2"];
export const DEFAULT_WEIGHT_STYLE = "不输出权重";

// 手动提示词框的使用方式（需与 prompt_builder.py 的 MANUAL_MODES 一致）
export const MANUAL_MODES = [
  "两者结合（提示词框在前）",
  "两者结合（提示词框在后）",
  "仅使用提示词框",
  "仅使用 TAG 词库",
];
export const DEFAULT_MANUAL_MODE = MANUAL_MODES[0];

/** 整理手动提示词：保留换行，收掉多余空行与首尾空白，并去掉结尾逗号 */
export function cleanManualPrompt(text) {
  const raw = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
  const lines = raw.split("\n").map((line) => line.replace(/\s+$/, ""));
  let out = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  out = out.replace(/[,，]\s*$/, ""); // 结尾逗号会和后面的连接符叠出 ", ,"
  return out.trim();
}

/** 把连在一起的多个逗号收敛成一个（`a,, b` / `a, , b` → `a, b`） */
export function collapseSeparators(text) {
  const str = String(text == null ? "" : text);
  return str.replace(/[,，](?:[ \t]*[,，])+/g, ",");
}

/** 把提示词框里 tag 之间的空白（空格/制表符/换行）换成连接符 */
export function splitManualBySpace(text, separator) {
  const sep = String(separator === undefined || separator === null ? ", " : separator)
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
  const cleaned = cleanManualPrompt(text);
  if (!cleaned) return "";
  return cleaned.split(/\s+/).filter(Boolean).join(sep);
}

/** 手动提示词 + TAG 词库结果 → 最终正文（与后端 combine_prompt 行为一致） */
export function combinePrompt({
  manual = "",
  tagPrompt = "",
  mode = DEFAULT_MANUAL_MODE,
  separator = ", ",
  spaceAsSeparator = false,
  natural = "",
  naturalAppend = false,
} = {}) {
  const sep = String(separator === undefined || separator === null ? ", " : separator)
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
  let text = cleanManualPrompt(manual);
  if (text && spaceAsSeparator) text = splitManualBySpace(text, sep);
  const tags = tagPrompt || "";
  const useMode = MANUAL_MODES.includes(mode) ? mode : DEFAULT_MANUAL_MODE;

  let body;
  if (useMode === "仅使用提示词框") body = text;
  else if (useMode === "仅使用 TAG 词库") body = tags;
  else if (!text) body = tags;
  else if (!tags) body = text;
  else body = useMode === "两者结合（提示词框在后）" ? tags + sep + text : text + sep + tags;

  if (naturalAppend) {
    const nat = cleanManualPrompt(natural);
    if (nat) body = body ? body + sep + nat : nat;
  }
  // 粘贴内容自带逗号时拼接会出现 ", ,"，统一收敛（与后端 collapse_separators 一致）
  return collapseSeparators(body);
}

/** 该模式是否要用 TAG 词库 */
export function manualUsesTags(mode) {
  return mode !== "仅使用提示词框";
}

/** 该模式是否要用手动提示词框 */
export function manualUsesText(mode) {
  return mode !== "仅使用 TAG 词库";
}

function formatTag(text, weight, style) {
  if (Math.abs(weight - 1) < 1e-6 || style === "不输出权重") return text;
  const escaped = text.replace(/(?<!\\)([()])/g, "\\$1");
  const w = Number(weight.toFixed(3)).toString();
  return style === "tag:1.2" ? `${escaped}:${w}` : `(${escaped}:${w})`;
}

/**
 * 只渲染固定部分（随机池用占位符表示），用于编辑器里的实时预览。
 * @returns {{text:string, tags:string[], poolCount:number}}
 */
export function previewPrompt(items, opts = {}) {
  const separator = opts.separator === undefined ? ", " : opts.separator;
  const dedupe = opts.dedupe !== false;
  const underscoreToSpace = opts.underscoreToSpace !== false;
  const style = WEIGHT_STYLES.includes(opts.weightStyle) ? opts.weightStyle : WEIGHT_STYLES[0];

  const pieces = [];
  const plain = [];
  const seen = new Set();
  let poolCount = 0;

  for (const item of items || []) {
    if (item.enabled === false) continue;
    const weight = Number(item.weight) > 0 ? Number(item.weight) : 1;

    if (item.kind === "pool") {
      poolCount += 1;
      pieces.push(`[🎲${item.label || "随机池"}×${item.count || 1}]`);
      continue;
    }

    let text = cleanTag(item.text);
    if (!text) continue;
    if (underscoreToSpace) text = text.replace(/_/g, " ").replace(/\s+/g, " ").trim();
    const key = text.toLowerCase();
    if (dedupe && seen.has(key)) continue;
    seen.add(key);
    plain.push(text);
    pieces.push(formatTag(text, weight, style));
  }

  return { text: pieces.join(separator), tags: plain, poolCount };
}

/** 32 位整数随机源（离线预览用，保证同种子结果一致） */
export function mulberry32(seed) {
  let a = (Number(seed) || 0) >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 离线模式下的完整随机预览（算法与后端相近，仅用于界面展示） */
export function randomPreview(items, opts = {}, seed = 0) {
  const rnd = mulberry32(seed);
  const expanded = [];
  for (const item of items || []) {
    if (item.enabled === false) continue;
    if (item.kind === "pool") {
      const tags = (item.tags || []).slice();
      const count = Math.max(0, Number(item.count) || 0);
      if (!tags.length || count <= 0) continue;
      const chosen = [];
      const pool = tags.slice();
      while (chosen.length < count) {
        if (!pool.length) pool.push(...tags);
        const idx = Math.floor(rnd() * pool.length) % pool.length;
        chosen.push(pool.splice(idx, 1)[0]);
      }
      for (const t of chosen) expanded.push({ kind: "tag", text: t, weight: item.weight, enabled: true });
    } else {
      expanded.push(item);
    }
  }
  return previewPrompt(expanded, opts);
}
