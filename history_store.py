"""提示词历史的存储层。

数据位置::

    ComfyUI/user/prompt_history/history.json   # 全部记录 + 面板设置 + 当前选中项
    ComfyUI/user/prompt_history/images/        # 出图副本 + 缩略图（删除记录时一并清理）

设计要点：

* 单文件 JSON，写入走 ``临时文件 + os.replace``，避免半截文件；
* 所有读写都在 ``threading.RLock`` 里，节点线程 / aiohttp 线程都能安全调用；
* 出图会复制一份到 ``images/``，这样即使清空 ComfyUI 的 output/temp 目录，
  图文模式下仍然能看到图（复制失败时退化为 ``/view`` 链接）。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import traceback
import uuid

DEFAULT_SETTINGS = {
    # 开关：单击选中后，是否把提示词注入工作流的「提示词选择器」节点
    "inject_enabled": True,
    # 展示模式：text = 纯文字列表；gallery = 图文（图片 + 提示词）
    "mode": "text",
    # 排序：desc = 最新在上；asc = 最早在上
    "sort": "desc",
    # 最多保留多少条，超出后从最旧的开始丢
    "max_entries": 300,
    # 是否把出图复制一份到插件自己的目录
    "save_images": True,
}

VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".ogv"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".tif", ".tiff"}
MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS

THUMB_EDGE = 512  # 缩略图最长边


def log(message: str) -> None:
    print("[PromptHistory] %s" % message)


def clean_text(value) -> str:
    """把任意输入规整成一段文本（去掉首尾空白 / 统一换行）。"""
    if value is None:
        return ""
    if not isinstance(value, str):
        value = str(value)
    return value.replace("\r\n", "\n").replace("\r", "\n").strip()


# 随机池 / 提示词插件往文本里塞的说明片段，不属于提示词本身
_ANNOTATION_REMOVERS = (
    # 🎲 含1个 / 含 1 个随机池（执行时按 seed 抽取）
    re.compile(r"[\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F]?\s*含\s*\d+\s*个[^,，。；;\n]*"),
    re.compile(r"[（(][^）)\n]*(执行时|按\s*seed)[^）)\n]*[）)]"),
    re.compile(r"随机池[^,，。；;\n]*"),
    # [🎲一键模式/*×1] / 【一键模式】
    re.compile(r"[\[【][^\]】\n]*(一键模式|随机池|随机提示词)[^\]】\n]*[\]】]"),
    re.compile(r"一键模式[^,，。；;\n]*"),
)


def sanitize_prompt(value) -> str:
    """清掉提示词里的说明性片段（例如「🎲 含1个随机池（执行时按 seed 抽取）」）。

    只删注记本身，保留提示词正文；整行都是注记时整行丢掉。
    """
    text = clean_text(value)
    if not text:
        return ""
    kept = []
    for line in text.split("\n"):
        cleaned = line
        for pattern in _ANNOTATION_REMOVERS:
            cleaned = pattern.sub(" ", cleaned)
        cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
        cleaned = cleaned.strip().strip(",，、|/;；")
        if not cleaned.strip(" []【】()（）*×x"):
            continue
        kept.append(cleaned)
    return clean_text("\n".join(kept))


def user_root() -> str:
    """取 ComfyUI 的 user 目录；拿不到时退回到插件目录下的 user/。"""
    try:
        import folder_paths  # type: ignore

        getter = getattr(folder_paths, "get_user_directory", None)
        if callable(getter):
            base = getter()
        else:  # 非常老的版本
            base = os.path.join(getattr(folder_paths, "base_path", "."), "user")
    except Exception:
        base = os.path.join(os.path.dirname(os.path.realpath(__file__)), "user")
    return base


class PromptHistoryStore:
    """提示词历史 + 面板设置的内存/磁盘双层存储。"""

    VERSION = 1

    def __init__(self, root: str | None = None):
        self._lock = threading.RLock()
        self._save_timer = None
        self._root = root or os.path.join(user_root(), "prompt_history")
        self._images_dir = os.path.join(self._root, "images")
        self._file = os.path.join(self._root, "history.json")

        self.settings = dict(DEFAULT_SETTINGS)
        self.entries: list[dict] = []
        self.selected_id: str | None = None
        self._next_seq = 1
        self._prompt_map: dict[str, str] = {}

        try:
            os.makedirs(self._images_dir, exist_ok=True)
        except Exception:
            log("无法创建数据目录 %s：%s" % (self._images_dir, traceback.format_exc()))

        self._load()

    # ------------------------------------------------------------------ 属性

    @property
    def root(self) -> str:
        return self._root

    @property
    def images_dir(self) -> str:
        return self._images_dir

    @property
    def data_file(self) -> str:
        return self._file

    # ------------------------------------------------------------------ 读写

    def _load(self) -> None:
        if not os.path.isfile(self._file):
            return
        try:
            with open(self._file, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception as exc:
            log("历史文件损坏，已忽略（%s），本次会从空列表开始：%s" % (exc, self._file))
            return
        if not isinstance(data, dict):
            return

        with self._lock:
            entries = data.get("entries")
            if isinstance(entries, list):
                self.entries = [item for item in entries if isinstance(item, dict) and item.get("id")]

            used_seqs: set[int] = set()
            next_free = 1
            for entry in self.entries:
                # 手改过 / 老版本留下的脏字段都顺手规整掉，别让面板渲染崩
                entry["positive"] = clean_text(entry.get("positive"))
                entry.pop("negative", None)  # 不再保存反向提示词，老文件里的直接丢掉
                entry["label"] = clean_text(entry.get("label"))
                entry["prompt_id"] = str(entry.get("prompt_id") or "")
                if entry.get("source") not in ("workflow", "manual", "import"):
                    entry["source"] = "workflow"
                try:
                    entry["created_at"] = float(entry.get("created_at") or 0) or time.time()
                except Exception:
                    entry["created_at"] = time.time()

                entry["pinned"] = bool(entry.get("pinned"))
                order = entry.get("order")
                if not isinstance(order, (int, float)) or isinstance(order, bool):
                    order = -_as_int(entry.get("seq"))
                entry["order"] = float(order)

                images = entry.get("images")
                if isinstance(images, list):
                    entry["images"] = [item for item in images if isinstance(item, dict) and item.get("filename")]
                else:
                    entry["images"] = []

                seq = _as_int(entry.get("seq"))
                if seq <= 0 or seq in used_seqs:
                    while next_free in used_seqs:
                        next_free += 1
                    seq = next_free
                used_seqs.add(seq)
                entry["seq"] = seq

                prompt_id = entry["prompt_id"]
                if prompt_id:
                    self._prompt_map[prompt_id] = str(entry["id"])

            settings = data.get("settings")
            if isinstance(settings, dict):
                for key, default in DEFAULT_SETTINGS.items():
                    if key in settings:
                        value = settings[key]
                        if isinstance(default, bool):
                            self.settings[key] = bool(value)
                        elif isinstance(default, int):
                            try:
                                self.settings[key] = int(value)
                            except Exception:
                                pass
                        else:
                            self.settings[key] = value
                # 老文件里的非法取值兜底
                if self.settings.get("mode") not in ("text", "gallery"):
                    self.settings["mode"] = DEFAULT_SETTINGS["mode"]
                if self.settings.get("sort") not in ("asc", "desc", "manual"):
                    self.settings["sort"] = DEFAULT_SETTINGS["sort"]

            selected = data.get("selected")
            if isinstance(selected, str) and self._find(selected) is not None:
                self.selected_id = selected

            max_seq = max(used_seqs | {0})
            self._next_seq = max(_as_int(data.get("next_seq"), 1), max_seq + 1)

    def _save(self) -> None:
        """调用方需持有锁。"""
        payload = {
            "version": self.VERSION,
            "settings": self.settings,
            "selected": self.selected_id,
            "next_seq": self._next_seq,
            "entries": self.entries,
        }
        tmp = self._file + ".tmp"
        try:
            os.makedirs(self._root, exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=1)
            os.replace(tmp, self._file)
        except Exception:
            log("历史写入失败：%s" % traceback.format_exc())

    def _save_soon(self, delay: float = 0.5) -> None:
        """选中项 / 设置这类小改动延迟合并写盘，避免狂点面板时反复落盘。"""
        with self._lock:
            if self._save_timer is not None:
                return
            timer = threading.Timer(delay, self._flush)
            timer.daemon = True
            self._save_timer = timer
            timer.start()

    def _flush(self) -> None:
        with self._lock:
            self._save_timer = None
            self._save()

    def flush(self) -> None:
        """立刻把待写的改动落盘（退出前/删除后调用）。"""
        with self._lock:
            if self._save_timer is not None:
                self._save_timer.cancel()
                self._save_timer = None
            self._save()

    # ------------------------------------------------------------------ 查找

    def _find(self, entry_id) -> dict | None:
        if not entry_id:
            return None
        entry_id = str(entry_id)
        for entry in self.entries:
            if entry.get("id") == entry_id:
                return entry
        return None

    def _find_by_prompt(self, prompt_id) -> dict | None:
        if not prompt_id:
            return None
        prompt_id = str(prompt_id)
        entry_id = self._prompt_map.get(prompt_id)
        if entry_id:
            entry = self._find(entry_id)
            if entry is not None:
                return entry
        for entry in reversed(self.entries):
            if str(entry.get("prompt_id") or "") == prompt_id:
                self._prompt_map[prompt_id] = str(entry["id"])
                return entry
        return None

    def get_entry(self, entry_id) -> dict | None:
        with self._lock:
            entry = self._find(entry_id)
            return json.loads(json.dumps(entry)) if entry else None

    def find_by_prompt(self, prompt_id) -> dict | None:
        with self._lock:
            entry = self._find_by_prompt(prompt_id)
            return dict(entry) if entry else None

    # ------------------------------------------------------------------ 增删

    def _append_entry(
        self,
        positive: str,
        *,
        prompt_id: str = "",
        source: str = "workflow",
        label: str = "",
        created_at: float | None = None,
        pinned: bool = False,
        origin: str = "",
    ) -> dict:
        """调用方需持有锁；只负责追加，不写盘。"""
        seq = self._next_seq
        self._next_seq += 1
        entry = {
            "id": uuid.uuid4().hex,
            "seq": seq,
            "created_at": float(created_at or time.time()),
            "source": source,
            "prompt_id": str(prompt_id or ""),
            "label": clean_text(label),
            "positive": sanitize_prompt(positive),
            # 文本来源：merge=合并节点算出的完整提示词 / node=选择器节点写回 /
            # runtime=执行期展开 / graph=启发式抽取
            "origin": origin or "",
            # 手动排序用的权重：新记录权重更小，手动模式下排在最前面
            "order": -seq,
            "pinned": bool(pinned),
            "images": [],
        }
        self.entries.append(entry)
        if prompt_id:
            self._prompt_map[str(prompt_id)] = entry["id"]
        self._prune()
        return entry

    def add_entry(
        self,
        positive: str,
        *,
        prompt_id: str = "",
        source: str = "workflow",
        label: str = "",
        origin: str = "",
    ) -> dict:
        positive = clean_text(positive)
        with self._lock:
            if prompt_id:
                existing = self._find_by_prompt(prompt_id)
                if existing is not None:
                    # 同一个 prompt_id 重复提交，只记一次
                    return existing
            entry = self._append_entry(
                positive, prompt_id=prompt_id, source=source, label=label, origin=origin
            )
            self._save()
            return entry

    def update_entry(self, entry_id: str, positive=None) -> dict | None:
        with self._lock:
            entry = self._find(entry_id)
            if entry is None:
                return None
            if positive is not None:
                entry["positive"] = sanitize_prompt(positive)
            self._save()
            return entry

    def set_pinned(self, entry_id, pinned) -> dict | None:
        """收藏 / 取消收藏（收藏的记录固定显示在列表最上面）。"""
        with self._lock:
            entry = self._find(entry_id)
            if entry is None:
                return None
            entry["pinned"] = bool(pinned)
            self._save()
            return entry

    def reorder(self, ids) -> int:
        """按给定的 id 顺序重排（拖拽排序用）。返回参与重排的条数。"""
        wanted = [str(item) for item in (ids or []) if item]
        if not wanted:
            return 0
        with self._lock:
            position = {entry_id: index + 1 for index, entry_id in enumerate(wanted)}
            applied = 0
            tail = len(position)
            for entry in self.entries:
                key = str(entry.get("id"))
                if key in position:
                    entry["order"] = position[key]
                    applied += 1
                else:
                    tail += 1
                    entry["order"] = tail
            if applied:
                self._save()
            return applied

    def import_entries(self, items) -> int:
        """从导出的 JSON 里恢复记录（只取提示词 / 时间 / 收藏状态）。"""
        added = 0
        with self._lock:
            for item in items or []:
                if isinstance(item, str):
                    positive = clean_text(item)
                    created_at = None
                    pinned = False
                elif isinstance(item, dict):
                    positive = clean_text(item.get("positive") or item.get("text") or item.get("prompt"))
                    created_at = _as_float(item.get("created_at")) or None
                    pinned = bool(item.get("pinned"))
                else:
                    continue
                if not positive:
                    continue
                self._append_entry(positive, source="import", created_at=created_at, pinned=pinned, origin="import")
                added += 1
            if added:
                self._save()
            return added

    def delete_ids(self, ids) -> int:
        wanted = {str(i) for i in (ids or []) if i}
        if not wanted:
            return 0
        removed = 0
        with self._lock:
            keep = []
            for entry in self.entries:
                if str(entry.get("id")) in wanted:
                    self._drop_images(entry)
                    prompt_id = entry.get("prompt_id")
                    if prompt_id:
                        self._prompt_map.pop(str(prompt_id), None)
                    removed += 1
                    if self.selected_id and str(self.selected_id) == str(entry.get("id")):
                        self.selected_id = None
                else:
                    keep.append(entry)
            if removed:
                self.entries = keep
                self.flush()
        return removed

    def clear(self, keep_selection: bool = False) -> int:
        with self._lock:
            count = len(self.entries)
            for entry in self.entries:
                self._drop_images(entry)
            self.entries = []
            self._prompt_map.clear()
            self._next_seq = 1
            if not keep_selection:
                self.selected_id = None
            self.flush()
        return count

    def _prune(self) -> None:
        """超出 max_entries 时丢掉最旧的。"""
        try:
            limit = int(self.settings.get("max_entries") or DEFAULT_SETTINGS["max_entries"])
        except Exception:
            limit = DEFAULT_SETTINGS["max_entries"]
        limit = max(10, limit)
        while len(self.entries) > limit:
            entry = self.entries.pop(0)
            self._drop_images(entry)
            prompt_id = entry.get("prompt_id")
            if prompt_id:
                self._prompt_map.pop(str(prompt_id), None)
            if self.selected_id and str(self.selected_id) == str(entry.get("id")):
                self.selected_id = None

    def _drop_images(self, entry: dict) -> None:
        for item in entry.get("images") or []:
            if not isinstance(item, dict):
                continue
            for key in ("stored", "thumb"):
                name = item.get(key)
                if not name:
                    continue
                path = os.path.join(self._images_dir, os.path.basename(str(name)))
                try:
                    if os.path.isfile(path):
                        os.remove(path)
                except Exception:
                    pass

    # ------------------------------------------------------------------ 出图

    def attach_images(self, prompt_id: str, refs) -> int:
        """把 executed 事件里的出图挂到对应记录上（可在线程里跑）。"""
        if not prompt_id or not refs:
            return 0
        added = 0
        with self._lock:
            entry = self._find_by_prompt(prompt_id)
            if entry is None:
                return 0
            items = entry.setdefault("images", [])
            if not isinstance(items, list):
                items = entry["images"] = []
            existing = {
                (str(i.get("filename")), str(i.get("subfolder")), str(i.get("type")))
                for i in items
                if isinstance(i, dict)
            }
            for ref in refs:
                if not isinstance(ref, dict):
                    continue
                filename = str(ref.get("filename") or "")
                if not filename:
                    continue
                key = (filename, str(ref.get("subfolder") or ""), str(ref.get("type") or "output"))
                if key in existing:
                    continue
                item = self._materialize_image(ref)
                if item is None:
                    continue
                items.append(item)
                existing.add(key)
                added += 1
            if added:
                self._save()
        return added

    def _materialize_image(self, ref: dict) -> dict | None:
        filename = os.path.basename(str(ref.get("filename") or "").replace("\\", "/"))
        if not filename:
            return None
        ext = os.path.splitext(filename)[1].lower()
        if ext not in MEDIA_EXTS:
            return None
        subfolder = str(ref.get("subfolder") or "").strip("/\\")
        media_type = str(ref.get("type") or "output") or "output"
        item = {
            "filename": filename,
            "subfolder": subfolder,
            "type": media_type,
            "kind": "video" if ext in VIDEO_EXTS else "image",
            "stored": "",
            "thumb": "",
            "width": 0,
            "height": 0,
        }
        if not self.settings.get("save_images", True):
            return item

        source = self._source_path(item)
        if not source:
            # 复制不到就保留引用，前端会退化成 /view 链接
            return item
        stored = uuid.uuid4().hex + ext
        target = os.path.join(self._images_dir, stored)
        try:
            os.makedirs(self._images_dir, exist_ok=True)
            shutil.copyfile(source, target)
        except Exception:
            log("出图复制失败：%s" % traceback.format_exc())
            return item
        item["stored"] = stored
        thumb, width, height = _write_thumbnail(target, self._images_dir)
        if thumb:
            item["thumb"] = thumb
        item["width"] = width
        item["height"] = height
        return item

    def _source_path(self, item: dict) -> str | None:
        try:
            import folder_paths  # type: ignore

            base = folder_paths.get_directory_by_type(item.get("type") or "output")
        except Exception:
            base = None
        if not base:
            return None
        parts = [p for p in str(item.get("subfolder") or "").replace("\\", "/").split("/") if p and p != "."]
        if any(p == ".." for p in parts):
            return None
        path = os.path.join(base, *parts, item["filename"])
        return path if os.path.isfile(path) else None

    # ------------------------------------------------------------------ 文本修正

    def note_exact_text(self, prompt_id: str, positive: str, origin: str = "node") -> dict | None:
        """节点执行时调用：这就是这次运行真正用到的文本，直接写进/更新记录。

        比从提交的图里「猜」出来的文本准得多——合并节点、分隔符、通配符展开、
        执行期拼出来的内容都以这里为准。
        """
        if not prompt_id:
            return None
        positive = sanitize_prompt(positive)
        if not positive:
            return None
        # 还带 @引用 / 通配符占位符的文本不算「完整」，留给执行期展开结果去替换
        exact = not has_placeholder(positive)
        with self._lock:
            entry = self._find_by_prompt(prompt_id)
            if entry is None:
                entry = self.add_entry(
                    positive, prompt_id=str(prompt_id), source="workflow", origin=origin
                )
                entry["exact"] = exact
                self._save()
                return entry
            changed = False
            if entry.get("positive") != positive:
                entry["positive"] = positive
                changed = True
            if not entry.get("exact") and exact:
                entry["exact"] = True
                changed = True
            if origin and entry.get("origin") != origin:
                entry["origin"] = origin
                changed = True
            if changed:
                self._save()
            return entry

    def apply_runtime_text(self, prompt_id: str, texts, mark_exact: bool = True) -> dict | None:
        """执行期文本（随机池展开 / 通配符解析之后）的兜底校正。

        优先级是「合并节点算出的完整提示词」优先：如果记录里已经是合并节点 /
        选择器节点 / 上一次执行期给出的完整文本（而且不再带占位符），就不动它；
        否则才用执行期文本替换模板。
        """
        candidates: list[str] = []
        seen = set()
        for value in texts or []:
            text = clean_text(value)
            if not text or text in seen:
                continue
            seen.add(text)
            candidates.append(text)
        if not candidates:
            return None

        with self._lock:
            entry = self._find_by_prompt(prompt_id) if prompt_id else None
            if entry is not None and entry.get("exact"):
                return entry  # 节点 / 合并节点已经给了完整文本，别再覆盖
            positive = clean_text(entry.get("positive")) if entry else ""
            # 已经有完整文本（且不再带占位符）就别折腾了
            if positive and entry is not None:
                origin = entry.get("origin") or ""
                if origin in ("merge", "node", "runtime") and not has_placeholder(positive):
                    return entry
            chosen = _runtime_pick(candidates, positive)
            if not chosen:
                return entry
            chosen = sanitize_prompt(chosen)
            if entry is None:
                entry = self.add_entry(
                    chosen, prompt_id=str(prompt_id or ""), source="workflow", origin="runtime"
                )
            if entry.get("positive") != chosen:
                entry["positive"] = chosen
                self._save()
            if mark_exact and not entry.get("exact"):
                entry["exact"] = True
                entry["origin"] = "runtime"
                self._save()
            return entry

    # ------------------------------------------------------------------ 选中

    def set_selected(self, entry_id) -> dict | None:
        with self._lock:
            entry = self._find(entry_id) if entry_id else None
            self.selected_id = entry.get("id") if entry else None
            self._save_soon()
            return json.loads(json.dumps(entry)) if entry else None

    def get_injected_entry(self) -> dict | None:
        """供节点执行时调用：返回当前应当注入的记录（开关关掉时返回 None）。"""
        with self._lock:
            if not self.settings.get("inject_enabled", True):
                return None
            entry = self._find(self.selected_id)
            return json.loads(json.dumps(entry)) if entry else None

    # ------------------------------------------------------------------ 设置

    def update_settings(self, patch) -> dict:
        if not isinstance(patch, dict):
            return dict(self.settings)
        with self._lock:
            for key, default in DEFAULT_SETTINGS.items():
                if key not in patch:
                    continue
                value = patch[key]
                if key in ("inject_enabled", "save_images"):
                    self.settings[key] = bool(value)
                elif key == "mode":
                    if value in ("text", "gallery"):
                        self.settings[key] = value
                elif key == "sort":
                    if value in ("asc", "desc", "manual"):
                        self.settings[key] = value
                elif key == "max_entries":
                    try:
                        self.settings[key] = max(10, min(5000, int(value)))
                    except Exception:
                        pass
                else:
                    self.settings[key] = value
            self._prune()
            self._save_soon()
            return dict(self.settings)

    # ------------------------------------------------------------------ 输出

    def public_entry(self, entry: dict) -> dict:
        images = []
        for item in entry.get("images") or []:
            if not isinstance(item, dict):
                continue
            images.append(
                {
                    "kind": item.get("kind") or "image",
                    "width": _as_int(item.get("width")),
                    "height": _as_int(item.get("height")),
                    "filename": str(item.get("filename") or ""),
                    "thumb_url": self._media_url(item, prefer_thumb=True),
                    "url": self._media_url(item, prefer_thumb=False),
                }
            )
        positive = clean_text(entry.get("positive"))
        created = _as_float(entry.get("created_at"))
        order = entry.get("order")
        if not isinstance(order, (int, float)) or isinstance(order, bool):
            order = -_as_int(entry.get("seq"))
        return {
            "id": entry.get("id") or "",
            "seq": _as_int(entry.get("seq")),
            "created_at": created,
            "time": time.strftime("%H:%M:%S", time.localtime(created)) if created else "",
            "date": time.strftime("%m-%d", time.localtime(created)) if created else "",
            "source": entry.get("source") or "workflow",
            "label": str(entry.get("label") or ""),
            "prompt_id": str(entry.get("prompt_id") or ""),
            "positive": positive,
            "chars": len(positive),
            "exact": bool(entry.get("exact")),
            "origin": str(entry.get("origin") or ("node" if entry.get("exact") else "graph")),
            "pinned": bool(entry.get("pinned")),
            "order": float(order),
            "images": images,
        }

    def _media_url(self, item: dict, *, prefer_thumb: bool) -> str:
        name = item.get("thumb") if prefer_thumb else ""
        if name:
            return "/prompt_history/image/%s" % os.path.basename(str(name))
        stored = item.get("stored")
        if stored:
            return "/prompt_history/image/%s" % os.path.basename(str(stored))
        return "/view?%s" % _urlencode(
            {
                "filename": item.get("filename") or "",
                "subfolder": item.get("subfolder") or "",
                "type": item.get("type") or "output",
            }
        )

    def public_state(self) -> dict:
        with self._lock:
            entries = [self.public_entry(entry) for entry in self.entries]
            image_count = sum(len(e.get("images") or []) for e in self.entries)
            return {
                "entries": entries,
                "settings": dict(self.settings),
                "selected": self.selected_id,
                "stats": {"total": len(self.entries), "images": image_count},
                "data_dir": self._root,
            }

    def export_payload(self, ids=None) -> dict:
        """导出全部或指定的记录（``ids`` 为空时导出全部）。"""
        wanted = {str(item) for item in (ids or []) if item}
        with self._lock:
            entries = [
                self.public_entry(entry)
                for entry in self.entries
                if not wanted or str(entry.get("id")) in wanted
            ]
            return {
                "version": self.VERSION,
                "exported_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "settings": dict(self.settings),
                "entries": entries,
            }

    # ------------------------------------------------------------------ 生命周期

    def close(self) -> None:
        try:
            self.flush()
        except Exception:
            pass


def _as_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _as_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


_TOKEN_PATTERN = re.compile(r"[0-9a-zA-Z\u4e00-\u9fff]+")

# 提示词里的「占位符」：@词库引用 / __通配符__ / {a|b} 随机 / **权重 之类，
# 这些在提交时还没展开，所以执行期文本才算完整提示词
_PLACEHOLDER_PATTERN = re.compile(
    r"@[^\s,，、]+|__[A-Za-z0-9_\-\u4e00-\u9fff]+__|\{[^{}]*\|[^{}]*\}|\*\*"
)


def _tokens(text: str) -> set[str]:
    return {token.lower() for token in _TOKEN_PATTERN.findall(text or "")}


def text_similarity(left: str, right: str) -> float:
    """按词元重合度算相似度；用较短的作分母，所以「更完整的长文本」也能得高分。"""
    left_tokens = _tokens(left)
    right_tokens = _tokens(right)
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / min(len(left_tokens), len(right_tokens))


def has_placeholder(text: str) -> bool:
    """文本里是否还有没展开的 @引用 / 通配符占位符。"""
    return bool(_PLACEHOLDER_PATTERN.search(text or ""))


def _runtime_pick(candidates: list[str], positive: str) -> str:
    """从执行期文本里挑出「完整的那条提示词」。"""
    if not candidates:
        return ""
    if not positive:
        return max(candidates, key=len)

    placeholder_hint = has_placeholder(positive)
    qualified: list[str] = []
    for text in candidates:
        similarity = text_similarity(text, positive)
        if similarity >= 0.6:
            qualified.append(text)
        elif placeholder_hint and similarity >= 0.2:
            qualified.append(text)
    if not qualified:
        return ""
    # 展开后的提示词通常更长：优先取最长的那条（并列时保留靠前的）
    return max(qualified, key=len)


def _urlencode(mapping: dict) -> str:
    from urllib.parse import urlencode

    return urlencode(mapping)


def _write_thumbnail(path: str, out_dir: str):
    """生成缩略图，返回 (文件名, 宽, 高)；失败时返回 (None, 0, 0)。"""
    try:
        from PIL import Image  # type: ignore
    except Exception:
        return None, 0, 0
    try:
        with Image.open(path) as image:
            try:
                image.seek(0)
            except Exception:
                pass
            width, height = image.size
            if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
                rgba = image.convert("RGBA")
                flat = Image.new("RGB", rgba.size, (28, 28, 28))
                flat.paste(rgba, mask=rgba.split()[-1])
                thumb = flat
            else:
                thumb = image.convert("RGB")
            thumb.thumbnail((THUMB_EDGE, THUMB_EDGE))
            name = uuid.uuid4().hex + ".jpg"
            os.makedirs(out_dir, exist_ok=True)
            thumb.save(os.path.join(out_dir, name), "JPEG", quality=82, optimize=True)
            return name, int(width), int(height)
    except Exception:
        return None, 0, 0


_STORE: PromptHistoryStore | None = None
_STORE_LOCK = threading.Lock()


def get_store() -> PromptHistoryStore:
    global _STORE
    if _STORE is None:
        with _STORE_LOCK:
            if _STORE is None:
                _STORE = PromptHistoryStore()
    return _STORE
