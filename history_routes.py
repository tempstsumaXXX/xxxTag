"""HTTP 接口 + 服务器端钩子。

接口（全部挂在 ``/prompt_history`` 下，ComfyUI 会自动再套一层 ``/api`` 前缀）::

    GET  /prompt_history/list       读取全部记录 + 设置 + 当前选中项
    POST /prompt_history/add        手动添加一条（positive / negative）
    POST /prompt_history/delete     按 id 批量删除
    POST /prompt_history/clear      清空
    POST /prompt_history/select     设置 / 取消「当前选中项」
    POST /prompt_history/settings   修改设置（注入开关 / 展示模式 / 排序 ...）
    GET  /prompt_history/export     导出全部记录（JSON）
    GET  /prompt_history/image/{name}  读取保存下来的出图 / 缩略图
    GET  /prompt_history/status     健康检查

钩子：

* ``PromptQueue.put``  —— 工作流提交并校验通过后立刻抓取提示词（此时 prompt_id 已确定）；
* ``PromptServer.send_sync`` —— 监听 ``executed`` 事件，把出图挂到对应记录上。
"""

from __future__ import annotations

import atexit
import functools
import os
import re
import threading
import time
import traceback

try:  # aiohttp 是 ComfyUI 自带依赖；单独跑测试时允许缺失
    from aiohttp import web
except Exception:  # pragma: no cover
    web = None

from . import history_store, prompt_extract

ROUTE_PREFIX = "/prompt_history"
_SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]{1,160}$")

_REGISTERED = False
_ATTEMPTS = 0
_MAX_ATTEMPTS = 8

# 当前正在执行的 prompt_id（节点执行时用来知道自己在哪一次提交里）
_CURRENT_PROMPT_ID = ""
# 执行期拿到的真实文本（编码节点实际收到的 / Show Text 之类显示的），完成时用来修正记录
_RUNTIME_TEXTS: dict[str, list[str]] = {}

# 这些输出键里放的是「节点显示给用户看的文本」
_TEXT_OUTPUT_KEYS = ("text", "string", "strings", "prompt", "value", "texts")
# 节点执行时，这些输入键里放的是「最终要用的提示词文本」
_TEXT_INPUT_KEYS = ("text", "string", "text_g", "text_l", "prompt", "positive_prompt", "prompt_text")
# 这些返回类型说明该节点产出的是文本 / 条件，才值得记录
_TEXT_RETURN_TYPES = ("STRING", "CONDITIONING")

_HOOK_STATE = {"submit": False, "events": False, "text_tap": False}

store = history_store.get_store()


def current_prompt_id() -> str:
    """当前正在执行的 prompt_id（没有执行中的任务时是空串）。"""
    return _CURRENT_PROMPT_ID


def note_node_prompt(positive: str) -> None:
    """供「提示词选择器」节点在执行期调用：把这次真正用到的提示词写进历史。"""
    prompt_id = _CURRENT_PROMPT_ID
    if not prompt_id:
        return
    try:
        store.note_exact_text(prompt_id, positive)
    except Exception:
        log("记录节点提示词失败：%s" % traceback.format_exc())


def log(message: str) -> None:
    print("[PromptHistory] %s" % message)


def _ok(**kwargs) -> dict:
    payload = {"ok": True}
    payload.update(kwargs)
    return payload


def _err(message) -> dict:
    return {"ok": False, "error": str(message)}


async def _read_json(request) -> dict:
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


# --------------------------------------------------------------------- 接口


async def _h_status(request):
    return web.json_response(_ok(version=1, data_dir=store.root, hooks=dict(_HOOK_STATE)))


async def _h_list(request):
    try:
        return web.json_response(_ok(state=store.public_state()))
    except Exception as exc:
        traceback.print_exc()
        return web.json_response(_err(exc), status=500)


async def _h_add(request):
    data = await _read_json(request)
    positive = history_store.clean_text(data.get("positive"))
    if not positive:
        return web.json_response(_err("提示词不能为空"), status=400)
    entry = store.add_entry(positive, source="manual", label=data.get("label") or "", origin="manual")
    return web.json_response(_ok(state=store.public_state(), selected=store.public_entry(entry)))


async def _h_delete(request):
    data = await _read_json(request)
    ids = data.get("ids")
    if isinstance(ids, str):
        ids = [ids]
    if not isinstance(ids, list):
        return web.json_response(_err("ids 必须是数组"), status=400)
    removed = store.delete_ids(ids)
    return web.json_response(_ok(removed=removed, state=store.public_state()))


async def _h_update(request):
    """就地编辑某条记录的提示词。"""
    data = await _read_json(request)
    entry_id = data.get("id")
    positive = history_store.clean_text(data.get("positive"))
    if not entry_id:
        return web.json_response(_err("缺少 id"), status=400)
    if not positive:
        return web.json_response(_err("提示词不能为空"), status=400)
    entry = store.update_entry(str(entry_id), positive)
    if entry is None:
        return web.json_response(_err("记录不存在"), status=404)
    return web.json_response(_ok(state=store.public_state(), entry=store.public_entry(entry)))


async def _h_pin(request):
    """收藏 / 取消收藏（收藏项固定显示在最上面）。"""
    data = await _read_json(request)
    entry_id = data.get("id")
    if not entry_id:
        return web.json_response(_err("缺少 id"), status=400)
    entry = store.set_pinned(str(entry_id), bool(data.get("pinned", True)))
    if entry is None:
        return web.json_response(_err("记录不存在"), status=404)
    return web.json_response(_ok(state=store.public_state(), entry=store.public_entry(entry)))


async def _h_reorder(request):
    """拖拽排序：按传入的 id 顺序重排，并把排序方式切成手动。"""
    data = await _read_json(request)
    ids = data.get("ids")
    if isinstance(ids, str):
        ids = [ids]
    if not isinstance(ids, list):
        return web.json_response(_err("ids 必须是数组"), status=400)
    applied = store.reorder(ids)
    if applied:
        store.update_settings({"sort": "manual"})
    return web.json_response(_ok(reordered=applied, state=store.public_state()))


async def _h_import(request):
    """导入导出的 JSON 记录。"""
    data = await _read_json(request)
    items = data.get("entries")
    if isinstance(items, dict):
        items = items.get("entries")
    if not isinstance(items, list):
        return web.json_response(_err("entries 必须是数组"), status=400)
    added = store.import_entries(items)
    return web.json_response(_ok(added=added, state=store.public_state()))


async def _h_clear(request):
    removed = store.clear()
    return web.json_response(_ok(removed=removed, state=store.public_state()))


async def _h_select(request):
    data = await _read_json(request)
    entry_id = data.get("id")
    entry = store.set_selected(entry_id if entry_id else None)
    return web.json_response(
        _ok(state=store.public_state(), selected=store.public_entry(entry) if entry else None)
    )


async def _h_settings(request):
    data = await _read_json(request)
    settings = store.update_settings(data)
    return web.json_response(_ok(settings=settings, state=store.public_state()))


async def _h_export(request):
    return web.json_response(_ok(data=store.export_payload()))


async def _h_export_ids(request):
    """导出选中的记录（POST {ids}），不传 ids 就是全部。"""
    data = await _read_json(request)
    ids = data.get("ids")
    if isinstance(ids, str):
        ids = [ids]
    if ids is not None and not isinstance(ids, list):
        return web.json_response(_err("ids 必须是数组"), status=400)
    return web.json_response(_ok(data=store.export_payload(ids)))


async def _h_image(request):
    name = request.match_info.get("name", "")
    if not _SAFE_NAME.match(name):
        raise web.HTTPNotFound()
    path = os.path.join(store.images_dir, name)
    if not os.path.isfile(path):
        raise web.HTTPNotFound()
    return web.FileResponse(
        path,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


# --------------------------------------------------------------------- 钩子


def _capture_prompt(item) -> None:
    """从排队项里抓取提示词。item = (number, prompt_id, prompt, extra_data, ...)"""
    if not isinstance(item, (tuple, list)) or len(item) < 3:
        return
    prompt_id = item[1]
    prompt = item[2]
    if not isinstance(prompt, dict):
        return
    positive, origin = prompt_extract.extract_with_origin(prompt)
    if not positive:
        return
    entry = store.add_entry(
        positive,
        prompt_id=str(prompt_id or ""),
        source="workflow",
        origin=origin,
    )
    if entry:
        log("已保存 #%s（%d 字）" % (entry.get("seq"), len(entry.get("positive") or "")))


def _refs_from_history(prompt_id: str) -> list[dict]:
    """从 ComfyUI 的 history 里捞出这次生成的图片（没有 websocket 客户端时的兜底）。"""
    try:
        from server import PromptServer  # type: ignore

        queue = getattr(getattr(PromptServer, "instance", None), "prompt_queue", None)
        if queue is None:
            return []
        history = queue.get_history(prompt_id=prompt_id, map_function=lambda item: item)
    except Exception:
        return []
    item = history.get(prompt_id) if isinstance(history, dict) else None
    if not isinstance(item, dict):
        return []
    outputs = item.get("outputs")
    if not isinstance(outputs, dict):
        return []
    refs = []
    for value in outputs.values():
        if not isinstance(value, list):
            continue
        for entry in value:
            if isinstance(entry, dict) and entry.get("filename"):
                refs.append(entry)
    return refs


def _attach_from_history(prompt_id: str, delay: float = 0.8) -> None:
    """完成事件后稍等 history 落库，再把出图挂上（已经在 executed 里挂过的会被去重）。"""

    def worker():
        time.sleep(delay)
        try:
            refs = _refs_from_history(prompt_id)
            if refs:
                store.attach_images(prompt_id, refs)
        except Exception:
            log("从 history 补挂出图失败：%s" % traceback.format_exc())

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()


def _texts_from_output(output: dict) -> list[str]:
    """从 executed 事件的 output 里挑出节点显示的文本。

    Show Text / Preview Any 这类节点会把结果放进 ``{"text": [...]}``，
    这已经是「合并 / 展开之后」的最终文本，用来校正从图里抽取的内容最合适。
    """
    texts: list[str] = []
    for key, value in output.items():
        lowered = str(key).lower()
        if lowered not in _TEXT_OUTPUT_KEYS:
            continue
        if isinstance(value, str):
            if value.strip():
                texts.append(value)
        elif isinstance(value, (list, tuple)):
            for item in value:
                if isinstance(item, str) and item.strip():
                    texts.append(item)
    return texts


def _as_texts(value) -> list[str]:
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if isinstance(value, (list, tuple)):
        texts = []
        for item in value:
            texts.extend(_as_texts(item))
        return texts
    return []


def _collect_runtime_text(prompt_id: str, texts) -> None:
    if not prompt_id or not texts:
        return
    bucket = _RUNTIME_TEXTS.setdefault(str(prompt_id), [])
    bucket.extend(texts)
    if len(bucket) > 64:
        del bucket[32:]
    if len(_RUNTIME_TEXTS) > 64:
        _RUNTIME_TEXTS.clear()


def tap_text_inputs(prompt_id, node, input_data_all) -> None:
    """执行期钩子：记录「节点执行时实际收到的文本」。

    随机池 / 通配符 / 合并节点都是在执行期才把提示词算出来的，
    提交时抓到的只是模板，这里拿到的才是完整提示词。

    新式节点（``io.ComfyNode``）的 ``RETURN_TYPES`` 可能是一堆类型对象而不是字符串，
    所以这里不按 RETURN_TYPES 过滤：只要有 text / string 之类的字符串输入就记下来，
    能不能覆盖原文本交给 :func:`history_store._runtime_pick` 的相似度判断把关。
    """
    if not prompt_id or not isinstance(input_data_all, dict):
        return
    _HOOK_STATE["tap_calls"] = _HOOK_STATE.get("tap_calls", 0) + 1

    texts: list[str] = []
    for key in _TEXT_INPUT_KEYS:
        if key in input_data_all:
            texts.extend(_as_texts(input_data_all.get(key)))
    if texts:
        _HOOK_STATE["tap_texts"] = _HOOK_STATE.get("tap_texts", 0) + 1
        _collect_runtime_text(prompt_id, texts)


def _install_text_tap() -> None:
    """给 ComfyUI 的节点执行加一个「取最终文本」的钩子。"""
    if _HOOK_STATE["text_tap"]:
        return
    try:
        import execution as comfy_execution  # type: ignore
    except Exception:
        log("未找到 execution 模块，跳过执行期取词钩子")
        return

    original = getattr(comfy_execution, "get_output_data", None)
    if original is None or getattr(original, "_prompt_history_patched", False):
        return

    @functools.wraps(original)
    async def patched_get_output_data(prompt_id, unique_id, obj, input_data_all, *args, **kwargs):
        try:
            tap_text_inputs(prompt_id, obj, input_data_all)
        except Exception:
            log("采集执行期文本失败：%s" % traceback.format_exc())
        return await original(prompt_id, unique_id, obj, input_data_all, *args, **kwargs)

    patched_get_output_data._prompt_history_patched = True
    comfy_execution.get_output_data = patched_get_output_data
    _HOOK_STATE["text_tap"] = True
    log("已挂载执行期取词钩子")


def _handle_event(event: str, data) -> None:
    global _CURRENT_PROMPT_ID

    if not isinstance(data, dict):
        return
    prompt_id = data.get("prompt_id")
    if not prompt_id:
        return
    prompt_id = str(prompt_id)

    if event == "execution_start":
        _CURRENT_PROMPT_ID = prompt_id
        _RUNTIME_TEXTS.pop(prompt_id, None)
        if len(_RUNTIME_TEXTS) > 64:
            _RUNTIME_TEXTS.clear()
        return
    if event in ("execution_success", "execution_error", "execution_interrupted"):
        texts = _RUNTIME_TEXTS.pop(prompt_id, [])
        if texts:
            try:
                store.apply_runtime_text(prompt_id, texts)
            except Exception:
                log("修正执行期文本失败：%s" % traceback.format_exc())
        # 没有前端 websocket 连着时 executed 事件不会发出，这里兜底从 history 补图
        _attach_from_history(prompt_id)
        if _CURRENT_PROMPT_ID == prompt_id:
            _CURRENT_PROMPT_ID = ""
        return

    if event != "executed":
        return

    output = data.get("output")
    if not isinstance(output, dict):
        return

    texts = _texts_from_output(output)
    if texts:
        _collect_runtime_text(prompt_id, texts)

    refs = []
    for value in output.values():
        if not isinstance(value, list):
            continue
        for entry in value:
            if isinstance(entry, dict) and entry.get("filename"):
                refs.append(entry)
    if not refs:
        return
    # 复制 / 生成缩略图会有点耗时，丢到后台线程，别卡住执行线程
    worker = threading.Thread(
        target=store.attach_images,
        args=(prompt_id, refs),
        daemon=True,
    )
    worker.start()


def _install_hooks(instance) -> None:
    if getattr(instance, "_prompt_history_hooks", False):
        return
    instance._prompt_history_hooks = True

    # 1) 提交工作流 -> 抓提示词
    queue = getattr(instance, "prompt_queue", None)
    if queue is not None and not getattr(queue, "_prompt_history_patched", False):
        original_put = queue.put

        @functools.wraps(original_put)
        def patched_put(item, _original=original_put):
            try:
                _capture_prompt(item)
            except Exception:
                log("抓取提示词失败：%s" % traceback.format_exc())
            return _original(item)

        queue.put = patched_put
        queue._prompt_history_patched = True
        _HOOK_STATE["submit"] = True
        log("已挂载提交钩子")
    else:
        log("未找到 prompt_queue，跳过提交钩子")

    # 2) executed 事件 -> 挂出图
    if not getattr(instance, "_prompt_history_send_patched", False):
        original_send = instance.send_sync

        @functools.wraps(original_send)
        def patched_send(event, data, sid=None, _original=original_send):
            try:
                _handle_event(event, data)
            except Exception:
                log("处理事件失败：%s" % traceback.format_exc())
            return _original(event, data, sid)

        instance.send_sync = patched_send
        instance._prompt_history_send_patched = True
        _HOOK_STATE["events"] = True
        log("已挂载出图钩子")

    # 3) 节点执行 -> 记录编码节点实际收到的完整提示词
    try:
        _install_text_tap()
    except Exception:
        log("执行期取词钩子挂载失败：%s" % traceback.format_exc())


def register_routes() -> bool:
    """注册 aiohttp 路由 + 钩子。返回是否成功。"""
    global _REGISTERED, _ATTEMPTS, web

    if _REGISTERED:
        return True
    _ATTEMPTS += 1

    try:
        from aiohttp import web as aiohttp_web  # type: ignore

        web = aiohttp_web
        from server import PromptServer  # type: ignore
    except Exception as exc:
        log("未检测到 ComfyUI 服务端（%s），跳过接口注册。" % exc)
        return False

    instance = getattr(PromptServer, "instance", None)
    routes = getattr(instance, "routes", None)
    if instance is None or routes is None:
        if _ATTEMPTS < _MAX_ATTEMPTS:
            timer = threading.Timer(1.0, register_routes)
            timer.daemon = True
            timer.start()
        return False

    if getattr(instance, "_prompt_history_routes", False):
        _REGISTERED = True
        return True

    try:
        routes.get(ROUTE_PREFIX + "/status")(_h_status)
        routes.get(ROUTE_PREFIX + "/list")(_h_list)
        routes.post(ROUTE_PREFIX + "/add")(_h_add)
        routes.post(ROUTE_PREFIX + "/update")(_h_update)
        routes.post(ROUTE_PREFIX + "/pin")(_h_pin)
        routes.post(ROUTE_PREFIX + "/reorder")(_h_reorder)
        routes.post(ROUTE_PREFIX + "/import")(_h_import)
        routes.post(ROUTE_PREFIX + "/delete")(_h_delete)
        routes.post(ROUTE_PREFIX + "/clear")(_h_clear)
        routes.post(ROUTE_PREFIX + "/select")(_h_select)
        routes.post(ROUTE_PREFIX + "/settings")(_h_settings)
        routes.get(ROUTE_PREFIX + "/export")(_h_export)
        routes.post(ROUTE_PREFIX + "/export")(_h_export_ids)
        routes.get(ROUTE_PREFIX + "/image/{name}")(_h_image)
    except Exception:
        log("接口注册失败：%s" % traceback.format_exc())
        return False

    instance._prompt_history_routes = True
    _REGISTERED = True

    try:
        _install_hooks(instance)
    except Exception:
        log("钩子挂载失败：%s" % traceback.format_exc())

    try:
        atexit.register(store.flush)
    except Exception:
        pass

    log("接口已就绪：%s/list（数据目录：%s）" % (ROUTE_PREFIX, store.root))
    return True
