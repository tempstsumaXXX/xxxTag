"""HTTP 接口：词库的读写 / 批量导入导出 / 提示词预览。

**默认开启**（``tag_store.is_http_enabled()``）。可以在面板里关掉，关掉后除 ``/status``
与 ``/switch`` 之外的接口一律拒绝访问，前端自动退化为「浏览器本地词库」模式
（节点执行完全不受影响）。开关状态保存在
``ComfyUI/user/prompt_tag_manager/.settings.json``，也可以用环境变量
``PROMPT_TAG_HTTP=1 / 0`` 强制开关。
"""

from __future__ import annotations

import functools
import os
import threading
import traceback

from . import tag_store, translate
from .prompt_builder import DEFAULT_WEIGHT_STYLE, preview as build_preview

ROUTE_PREFIX = "/prompt_tag"
MAX_BODY_BYTES = 32 * 1024 * 1024  # 32MB，防止误传超大文件

_REGISTERED = False
_ATTEMPTS = 0
_MAX_ATTEMPTS = 5


def _ok(**kwargs) -> dict:
    payload = {"ok": True}
    payload.update(kwargs)
    return payload


def _err(message) -> dict:
    return {"ok": False, "error": str(message)}


def _disabled_payload() -> dict:
    return {
        "ok": False,
        "code": "http_disabled",
        "error": "HTTP 接口已关闭：请在 TAG 面板里点「开启 HTTP 接口」，"
        "或设置环境变量 PROMPT_TAG_HTTP=1 后重启 ComfyUI",
    }


def _log(message: str) -> None:
    print("[PromptTag] %s" % message)


def register_routes() -> bool:
    """注册 aiohttp 路由。返回是否成功。"""
    global _REGISTERED, _ATTEMPTS

    if _REGISTERED:
        return True
    _ATTEMPTS += 1

    try:
        from aiohttp import web  # type: ignore
        from server import PromptServer  # type: ignore
    except Exception as exc:
        _log("未检测到 ComfyUI 服务端（%s），跳过接口注册。" % exc)
        return False

    instance = getattr(PromptServer, "instance", None)
    routes = getattr(instance, "routes", None)
    if routes is None:
        if _ATTEMPTS < _MAX_ATTEMPTS:
            timer = threading.Timer(1.0, register_routes)
            timer.daemon = True
            timer.start()
        else:
            _log("无法获取 PromptServer.routes，导入/导出接口不可用（前端会走本地模式）。")
        return False

    async def _read_json(request):
        body = await request.read()
        if len(body) > MAX_BODY_BYTES:
            raise ValueError("请求体过大（超过 32MB）")
        if not body:
            return {}
        import json as _json

        return _json.loads(body.decode("utf-8"))

    def _guarded(fn):
        """接口默认关闭：除 status / switch 外，关闭时一律拒绝。"""

        @functools.wraps(fn)
        async def wrapper(request):
            if not tag_store.is_http_enabled():
                return web.json_response(_disabled_payload())
            return await fn(request)

        return wrapper

    # -- 开关状态（始终可用） -----------------------------------------------
    @routes.get(ROUTE_PREFIX + "/status")
    async def prompt_tag_status(request):
        enabled = tag_store.is_http_enabled()
        forced = tag_store.env_http_override()
        return web.json_response(
            _ok(
                http_enabled=enabled,
                http_default=True,
                env_locked=forced is not None,
                env_var=tag_store.ENV_HTTP,
                version="1.0.1",
                data_dir=tag_store.get_user_dir(),
            )
        )

    @routes.post(ROUTE_PREFIX + "/switch")
    async def prompt_tag_switch(request):
        try:
            payload = await _read_json(request)
            if tag_store.env_http_override() is not None:
                return web.json_response(
                    _err(
                        "已被环境变量 %s 强制锁定，改设置文件无效；请修改环境变量后重启 ComfyUI"
                        % tag_store.ENV_HTTP
                    )
                )
            enable = bool(payload.get("enable"))
            state = tag_store.set_http_enabled(enable)
            _log("HTTP 接口已%s" % ("开启" if state else "关闭"))
            return web.json_response(
                _ok(
                    http_enabled=state,
                    data_dir=tag_store.get_user_dir(),
                    message="HTTP 接口已%s" % ("开启" if state else "关闭"),
                )
            )
        except Exception as exc:
            traceback.print_exc()
            return web.json_response(_err(exc))

    # -- 状态 ---------------------------------------------------------------
    @routes.get(ROUTE_PREFIX + "/state")
    @_guarded
    async def prompt_tag_state(request):
        try:
            libraries = tag_store.list_libraries()
            default = tag_store.get_default_library_name()
            return web.json_response(
                _ok(
                    libraries=libraries,
                    default=default,
                    data_dir=tag_store.get_user_dir(),
                    builtin_dir=tag_store.BUILTIN_DIR,
                    version="1.0.0",
                )
            )
        except Exception as exc:
            traceback.print_exc()
            return web.json_response(_err(exc))

    # -- 读取单个词库 -------------------------------------------------------
    @routes.get(ROUTE_PREFIX + "/library")
    @_guarded
    async def prompt_tag_get_library(request):
        try:
            name = request.query.get("name") or ""
            if not name:
                name = tag_store.get_default_library_name()
            data, kind = tag_store.load_library(name)
            return web.json_response(_ok(name=name, kind=kind, data=data))
        except FileNotFoundError as exc:
            return web.json_response(_err(exc))
        except Exception as exc:
            traceback.print_exc()
            return web.json_response(_err(exc))

    # -- 保存 ---------------------------------------------------------------
    @routes.post(ROUTE_PREFIX + "/library/save")
    @_guarded
    async def prompt_tag_save_library(request):
        try:
            payload = await _read_json(request)
            name = payload.get("name") or "默认词库"
            data = payload.get("data") or {}
            saved = tag_store.save_library(name, data)
            libraries = tag_store.list_libraries()
            return web.json_response(_ok(name=saved, libraries=libraries))
        except Exception as exc:
            traceback.print_exc()
            return web.json_response(_err(exc))

    # -- 删除 ---------------------------------------------------------------
    @routes.post(ROUTE_PREFIX + "/library/delete")
    @_guarded
    async def prompt_tag_delete_library(request):
        try:
            payload = await _read_json(request)
            name = payload.get("name") or ""
            if not name:
                raise ValueError("缺少词库名")
            removed = tag_store.delete_library(name)
            if not removed:
                raise ValueError("只能删除用户词库（内置词库受保护）")
            return web.json_response(
                _ok(deleted=name, libraries=tag_store.list_libraries())
            )
        except Exception as exc:
            return web.json_response(_err(exc))

    # -- 重命名 -------------------------------------------------------------
    @routes.post(ROUTE_PREFIX + "/library/rename")
    @_guarded
    async def prompt_tag_rename_library(request):
        try:
            payload = await _read_json(request)
            name = payload.get("name") or ""
            new_name = payload.get("new_name") or ""
            if not name or not new_name:
                raise ValueError("缺少词库名")
            renamed = tag_store.rename_library(name, new_name)
            return web.json_response(
                _ok(name=renamed, libraries=tag_store.list_libraries())
            )
        except Exception as exc:
            return web.json_response(_err(exc))

    # -- 批量导入 -----------------------------------------------------------
    @routes.post(ROUTE_PREFIX + "/import")
    @_guarded
    async def prompt_tag_import(request):
        try:
            payload = await _read_json(request)
            result = tag_store.import_library(
                name=payload.get("name"),
                text=payload.get("text") or "",
                filename=payload.get("filename") or "",
                mode=payload.get("mode") or "replace",
                new_name=payload.get("new_name"),
            )
            data, kind = tag_store.load_library(result["library"])
            result.update(
                {
                    "data": data,
                    "kind": kind,
                    "libraries": tag_store.list_libraries(),
                }
            )
            return web.json_response(_ok(**result))
        except Exception as exc:
            traceback.print_exc()
            return web.json_response(_err(exc))

    # -- 从服务器本地路径导入（大文件用这个，不经过浏览器） -----------------
    @routes.post(ROUTE_PREFIX + "/import_path")
    @_guarded
    async def prompt_tag_import_path(request):
        try:
            payload = await _read_json(request)
            path = payload.get("path") or ""
            if not path:
                raise ValueError("缺少文件路径")
            if not os.path.isabs(path):
                raise ValueError("请填写绝对路径，例如 D:/tags/xxx.sql")
            try:
                split = int(payload.get("split") or 0)
            except (TypeError, ValueError):
                split = 0

            args = dict(
                path=path,
                name=payload.get("name"),
                mode=payload.get("mode") or "new",
                new_name=payload.get("new_name"),
                split=split,
            )
            # 大文件解析很耗时，放到线程里跑，别把 ComfyUI 的事件循环堵住
            try:
                import asyncio

                result = await asyncio.to_thread(tag_store.import_path, **args)
            except (AttributeError, RuntimeError):
                result = tag_store.import_path(**args)

            data = None
            kind = None
            first = None
            if result.get("split"):
                names = [x["name"] for x in result.get("libraries") or []]
                first = names[0] if names else None
            else:
                first = result.get("library")
            if first:
                data, kind = tag_store.load_library(first)
            result.update(
                {
                    "data": data,
                    "kind": kind,
                    "libraries": tag_store.list_libraries(),
                }
            )
            return web.json_response(_ok(**result))
        except FileNotFoundError as exc:
            return web.json_response(_err(exc))
        except Exception as exc:
            traceback.print_exc()
            return web.json_response(_err(exc))

    # -- 批量导出 -----------------------------------------------------------
    @routes.post(ROUTE_PREFIX + "/export")
    @_guarded
    async def prompt_tag_export(request):
        try:
            payload = await _read_json(request)
            data = payload.get("data")
            fmt = payload.get("format") or "json"
            if data is None and payload.get("name"):
                data = tag_store.load_library(payload["name"])[0]
            if data is None:
                raise ValueError("没有可导出的词库数据")
            subset = tag_store.export_subset(
                data, payload.get("group") or None, payload.get("sub") or None
            )
            out = tag_store.export_library(subset, fmt)
            return web.json_response(_ok(**out))
        except Exception as exc:
            traceback.print_exc()
            return web.json_response(_err(exc))

    # -- 提示词预览（含随机抽样） -------------------------------------------
    @routes.post(ROUTE_PREFIX + "/preview")
    @_guarded
    async def prompt_tag_preview(request):
        try:
            payload = await _read_json(request)
            result = build_preview(
                config=payload.get("config") or "",
                seed=int(payload.get("seed") or 0),
                separator=payload.get("separator", ", "),
                dedupe=bool(payload.get("dedupe", True)),
                underscore_to_space=bool(payload.get("underscore_to_space", True)),
                weight_style=payload.get("weight_style") or DEFAULT_WEIGHT_STYLE,
                resolver=tag_store.library_sub_tags,
            )
            return web.json_response(_ok(**result))
        except Exception as exc:
            return web.json_response(_err(exc))

    # -- 自定义翻译（保存到本地） -------------------------------------------
    @routes.get(ROUTE_PREFIX + "/descs")
    @_guarded
    async def prompt_tag_get_descs(request):
        try:
            data = tag_store.load_custom_descs()
            return web.json_response(_ok(descs=data, total=len(data), file=tag_store.CUSTOM_DESC_FILENAME))
        except Exception as exc:
            return web.json_response(_err(exc))

    @routes.post(ROUTE_PREFIX + "/descs")
    @_guarded
    async def prompt_tag_save_descs(request):
        try:
            payload = await _read_json(request)
            mapping = payload.get("descs") or {}
            if payload.get("text") is not None:
                mapping = {payload.get("text"): payload.get("desc") or ""}
            if not isinstance(mapping, dict):
                raise ValueError("descs 需要是 {原文: 译文} 的对象")
            remove = payload.get("remove") or []
            data = tag_store.save_custom_descs(mapping, remove=remove)
            return web.json_response(_ok(descs=data, total=len(data)))
        except Exception as exc:
            traceback.print_exc()
            return web.json_response(_err(exc))

    # -- 翻译 ---------------------------------------------------------------
    @routes.get(ROUTE_PREFIX + "/translate/settings")
    @_guarded
    async def prompt_tag_translate_settings(request):
        try:
            return web.json_response(_ok(settings=translate.public_settings()))
        except Exception as exc:
            return web.json_response(_err(exc))

    @routes.post(ROUTE_PREFIX + "/translate/settings")
    @_guarded
    async def prompt_tag_save_translate_settings(request):
        try:
            payload = await _read_json(request)
            translate.save_settings(payload.get("settings") or payload or {})
            return web.json_response(_ok(settings=translate.public_settings()))
        except Exception as exc:
            return web.json_response(_err(exc))

    @routes.post(ROUTE_PREFIX + "/translate")
    @_guarded
    async def prompt_tag_translate(request):
        try:
            payload = await _read_json(request)
            texts = payload.get("texts") or []
            if not isinstance(texts, list):
                raise ValueError("texts 需要是数组")
            settings = payload.get("settings") or None
            try:
                import asyncio

                result = await asyncio.to_thread(translate.translate_many, texts, settings)
            except (AttributeError, RuntimeError):
                result = translate.translate_many(texts, settings)
            return web.json_response(_ok(**result))
        except Exception as exc:
            traceback.print_exc()
            return web.json_response(_err(exc))

    @routes.post(ROUTE_PREFIX + "/translate/test")
    @_guarded
    async def prompt_tag_translate_test(request):
        try:
            payload = await _read_json(request)
            if payload.get("settings"):
                translate.save_settings(payload["settings"])
            try:
                import asyncio

                result = await asyncio.to_thread(translate.test_translate)
            except (AttributeError, RuntimeError):
                result = translate.test_translate()
            return web.json_response(result)
        except Exception as exc:
            return web.json_response(_err(exc))

    @routes.post(ROUTE_PREFIX + "/translate/clear")
    @_guarded
    async def prompt_tag_translate_clear(request):
        try:
            count = translate.clear_cache()
            return web.json_response(_ok(cleared=count))
        except Exception as exc:
            return web.json_response(_err(exc))

    # -- 探活 ---------------------------------------------------------------
    @routes.get(ROUTE_PREFIX + "/health")
    @_guarded
    async def prompt_tag_health(request):
        return web.json_response(
            _ok(version="1.0.0", data_dir=tag_store.get_user_dir())
        )

    _REGISTERED = True
    if tag_store.is_http_enabled():
        _log("HTTP 接口已开启：%s/*（词库目录：%s）" % (ROUTE_PREFIX, tag_store.get_user_dir()))
    else:
        _log(
            "HTTP 接口已关闭（只放行 /status 与 /switch）。可在 TAG 面板里打开，"
            "或设环境变量 %s=1 后重启。词库目录：%s" % (tag_store.ENV_HTTP, tag_store.get_user_dir())
        )
    return True


__all__ = ["register_routes", "ROUTE_PREFIX"]
