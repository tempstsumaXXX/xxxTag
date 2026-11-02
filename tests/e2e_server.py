"""端到端测试用的最小 ComfyUI 替身服务。

它做的只有三件事：
  1. 伪造 ``server.PromptServer``，让插件的 routes.py 正常注册路由；
  2. 用 aiohttp 真正跑起这些 /prompt_tag/* 接口；
  3. 把 web/ 目录挂到 /extensions/ComfyUI-PromptTagManager 下，方便静态校验。

注意：插件没有「内置词库只读保护」，保存会直接写进词库文件。
所以这里把内置词库复制到临时目录（并用 PROMPT_TAG_BUILTIN_DIR 指过去），
避免测试把仓库里的 builtin_tags/ 改坏；再另外造一份合成的「一键模式」大库。

启动后打印：READY <port> <data_dir> <builtin_dir>
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import types

from aiohttp import web

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.dirname(HERE)
WEB_DIR = os.path.join(PKG_DIR, "web")
REAL_BUILTIN = os.path.join(PKG_DIR, "builtin_tags")

SMALL_BUILTINS = ["chinese_style.json", "danbooru_basic.json", "renwu.json"]


def prepare_builtin_dir() -> str:
    """复制真实内置词库到临时目录，并补一份合成的大预置库。"""
    tmp = os.path.join(tempfile.gettempdir(), "ptm_e2e_builtin")
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)

    for fname in SMALL_BUILTINS:
        src = os.path.join(REAL_BUILTIN, fname)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(tmp, fname))

    # 合成一份「一键模式」风格的大库：6 个二级分类 × 1000 条整句提示词
    subs = []
    for i in range(1, 7):
        tags = []
        for j in range(1000):
            tags.append(
                "1girl, solo, preset_%02d_%04d, looking at viewer, long hair, "
                "blue eyes, smile, indoors, upper body, detailed" % (i, j)
            )
        subs.append({"name": "一键NSFW-%02d" % i, "tags": tags})
    synthetic = {"name": "一键模式-01", "version": 1, "updated_at": "2025-01-01T00:00:00", "groups": [{"name": "一键模式", "subs": subs}]}
    with open(os.path.join(tmp, "yijian-01.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(synthetic, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return tmp


def install_fake_server():
    routes = web.RouteTableDef()

    class PromptServer:
        instance = types.SimpleNamespace(routes=routes)

    mod = types.ModuleType("server")
    mod.PromptServer = PromptServer
    sys.modules["server"] = mod
    return routes


def load_package():
    spec = importlib.util.spec_from_file_location(
        "ptm", os.path.join(PKG_DIR, "__init__.py"), submodule_search_locations=[PKG_DIR]
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["ptm"] = mod
    spec.loader.exec_module(mod)
    return mod


async def main():
    port = int(os.environ.get("PTM_PORT", "8399"))
    data_dir = os.path.join(tempfile.gettempdir(), "ptm_e2e_data")
    shutil.rmtree(data_dir, ignore_errors=True)
    os.makedirs(data_dir, exist_ok=True)
    os.environ["PROMPT_TAG_USER_DIR"] = data_dir

    builtin_dir = prepare_builtin_dir()
    os.environ["PROMPT_TAG_BUILTIN_DIR"] = builtin_dir

    routes = install_fake_server()
    ptm = load_package()  # 导入时自动注册路由

    # HTTP 接口默认开启，这里再确认一次
    ptm.tag_store.set_http_enabled(True)
    # 测试环境不联网：翻译服务切成离线 fake（真实默认是免费的 mymemory）
    ptm.translate.save_settings({"provider": "fake"})

    app = web.Application()
    app.add_routes(routes)
    app.router.add_static("/extensions/ComfyUI-PromptTagManager", WEB_DIR)

    async def index(request):
        return web.Response(text="ptm e2e", content_type="text/plain")

    app.router.add_get("/", index)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    print("READY %d %s %s" % (port, data_dir, builtin_dir), flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
