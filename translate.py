"""翻译模块：默认使用免费接口（无需 API Key），带本地缓存。

支持的翻译服务：

* ``mymemory``      —— MyMemory，免费、无需 Key（匿名每天有额度），**默认**
* ``google``        —— Google 免费接口（translate.googleapis.com），无需 Key，
                       但需要能访问 googleapis.com
* ``libretranslate``—— 自建/第三方 LibreTranslate，需要填地址（可选 Key）
* ``fake``          —— 仅用于离线测试：直接把原文加个前缀返回，不发网络请求

所有网络请求都在本模块内完成（前端不直连，避免跨域），结果按
「服务 + 源语言 + 目标语言 + 原文」缓存到
``ComfyUI/user/prompt_tag_manager/.translate_cache.json``。
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from . import tag_store

PROVIDERS = ["mymemory", "google", "libretranslate", "fake"]

PROVIDER_LABELS = {
    "mymemory": "MyMemory（免费，无需 Key）",
    "google": "Google 免费接口（无需 Key，需能访问 googleapis）",
    "libretranslate": "LibreTranslate（自建，填地址）",
    "fake": "离线测试（不联网）",
}

TARGET_LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"]
SOURCE_LANGS = ["auto", "en", "zh-CN", "ja", "ko"]

DEFAULT_SETTINGS = {
    "provider": "mymemory",
    "source": "auto",
    "target": "zh-CN",
    "api_key": "",
    "base_url": "",
    "fallback": True,  # 首选服务失败时自动换另一个免费服务再试
}

CACHE_FILENAME = ".translate_cache.json"
CACHE_LIMIT = 20000
MAX_BATCH = 60           # 单次最多翻多少段，防止把免费额度一次打光
REQUEST_GAP = 0.12       # 每段之间的间隔（秒），对免费接口友好一点
TIMEOUT = 12

_memory_cache = {}
_cache_loaded = False


# ---------------------------------------------------------------------------
# 设置
# ---------------------------------------------------------------------------


def normalize_settings(raw) -> dict:
    out = dict(DEFAULT_SETTINGS)
    if isinstance(raw, dict):
        for key, value in raw.items():
            if key in out and isinstance(value, type(out[key])):
                out[key] = value
            elif key in out and key == "api_key" and isinstance(value, str):
                out[key] = value
    if out["provider"] not in PROVIDERS:
        out["provider"] = DEFAULT_SETTINGS["provider"]
    if out["target"] not in TARGET_LANGS:
        out["target"] = DEFAULT_SETTINGS["target"]
    if out["source"] not in SOURCE_LANGS:
        out["source"] = DEFAULT_SETTINGS["source"]
    out["api_key"] = str(out.get("api_key") or "")
    out["base_url"] = str(out.get("base_url") or "").strip()
    out["fallback"] = bool(out.get("fallback"))
    return out


def get_settings() -> dict:
    return normalize_settings(tag_store.read_settings().get("translate"))


def save_settings(patch) -> dict:
    merged = normalize_settings({**get_settings(), **(patch or {})})
    tag_store.write_settings({"translate": merged})
    return merged


def public_settings() -> dict:
    """给前端看的设置：隐藏 Key，只告诉你填没填。"""
    cfg = get_settings()
    out = dict(cfg)
    out["has_api_key"] = bool(cfg.get("api_key"))
    out["api_key"] = ""
    out["provider_labels"] = PROVIDER_LABELS
    out["providers"] = PROVIDERS
    out["target_langs"] = TARGET_LANGS
    out["source_langs"] = SOURCE_LANGS
    return out


# ---------------------------------------------------------------------------
# 缓存
# ---------------------------------------------------------------------------


def _cache_path() -> str:
    return os.path.join(tag_store.get_user_dir(), CACHE_FILENAME)


def _load_cache() -> dict:
    global _cache_loaded
    if _cache_loaded:
        return _memory_cache
    _cache_loaded = True
    try:
        path = _cache_path()
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
            if isinstance(data, dict):
                _memory_cache.update({str(k): str(v) for k, v in data.items()})
    except Exception as exc:
        print("[PromptTag] 读取翻译缓存失败：%s" % exc)
    return _memory_cache


def _save_cache() -> None:
    try:
        cache = _memory_cache
        if len(cache) > CACHE_LIMIT:
            keep = list(cache.items())[-CACHE_LIMIT:]
            cache.clear()
            cache.update(dict(keep))
        path = _cache_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(cache, f, ensure_ascii=False)
    except Exception as exc:
        print("[PromptTag] 写入翻译缓存失败：%s" % exc)


def _cache_key(provider: str, source: str, target: str, text: str) -> str:
    return "%s|%s|%s|%s" % (provider, source, target, text)


def clear_cache() -> int:
    count = len(_memory_cache)
    _memory_cache.clear()
    _save_cache()
    return count


# ---------------------------------------------------------------------------
# 网络
# ---------------------------------------------------------------------------


def _http_get(url: str, params: dict, timeout: int = TIMEOUT) -> str:
    query = urllib.parse.urlencode(params, doseq=True)
    full = url + ("&" if "?" in url else "?") + query
    req = urllib.request.Request(
        full,
        headers={
            "User-Agent": "Mozilla/5.0 (ComfyUI-PromptTagManager)",
            "Accept": "application/json, text/plain, */*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def _http_post_json(url: str, payload: dict, timeout: int = TIMEOUT) -> str:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (ComfyUI-PromptTagManager)",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def _provider_mymemory(text: str, cfg: dict) -> str:
    source = cfg["source"] if cfg["source"] != "auto" else "en"
    raw = _http_get(
        "https://api.mymemory.translated.net/get",
        {"q": text, "langpair": "%s|%s" % (source, cfg["target"])},
    )
    data = json.loads(raw)
    status = data.get("responseStatus")
    if isinstance(status, (int, str)) and str(status) not in ("200", "0"):
        detail = data.get("responseDetails") or "接口返回错误"
        raise RuntimeError("MyMemory：%s" % detail)
    translated = ((data.get("responseData") or {}).get("translatedText")) or ""
    translated = str(translated).strip()
    if not translated or translated.upper() == text.upper():
        # 查不到时接口会把原文丢回来，这种当作没有结果
        if translated and translated.upper() != text.upper():
            return translated
        if not translated:
            raise RuntimeError("MyMemory 没有返回译文")
    return translated


def _provider_google(text: str, cfg: dict) -> str:
    raw = _http_get(
        "https://translate.googleapis.com/translate_a/single",
        {
            "client": "gtx",
            "sl": cfg["source"] if cfg["source"] != "auto" else "auto",
            "tl": cfg["target"],
            "dt": "t",
            "q": text,
        },
    )
    data = json.loads(raw)
    if not isinstance(data, list) or not data or not isinstance(data[0], list):
        raise RuntimeError("Google 返回格式异常")
    parts = [seg[0] for seg in data[0] if isinstance(seg, list) and seg and isinstance(seg[0], str)]
    translated = "".join(parts).strip()
    if not translated:
        raise RuntimeError("Google 没有返回译文")
    return translated


def _provider_libretranslate(text: str, cfg: dict) -> str:
    base = cfg.get("base_url") or ""
    if not base:
        raise RuntimeError("LibreTranslate 需要先填写接口地址（base_url）")
    if not base.startswith("http"):
        base = "https://" + base
    payload = {
        "q": text,
        "source": cfg["source"] if cfg["source"] != "auto" else "auto",
        "target": cfg["target"],
        "format": "text",
    }
    if cfg.get("api_key"):
        payload["api_key"] = cfg["api_key"]
    raw = _http_post_json(base.rstrip("/") + "/translate", payload)
    data = json.loads(raw)
    translated = str(data.get("translatedText") or "").strip()
    if not translated:
        raise RuntimeError(data.get("error") or "LibreTranslate 没有返回译文")
    return translated


def _provider_fake(text: str, cfg: dict) -> str:
    return "【机翻】" + text


_PROVIDER_FUNCS = {
    "mymemory": _provider_mymemory,
    "google": _provider_google,
    "libretranslate": _provider_libretranslate,
    "fake": _provider_fake,
}


def _provider_chain(cfg: dict) -> list:
    chain = [cfg["provider"]]
    if cfg.get("fallback"):
        for name in ("mymemory", "google"):
            if name not in chain and name != "fake":
                # 只有确实能用的（libretranslate 没地址就不排队）
                if name == "libretranslate" and not cfg.get("base_url"):
                    continue
                chain.append(name)
    return [n for n in chain if n in _PROVIDER_FUNCS]


def translate_one(text: str, cfg: dict = None) -> str:
    cfg = normalize_settings(cfg or get_settings())
    text = str(text or "").strip()
    if not text:
        return ""
    key = _cache_key(cfg["provider"], cfg["source"], cfg["target"], text)
    cache = _load_cache()
    if key in cache:
        return cache[key]

    errors = []
    for provider in _provider_chain(cfg):
        try:
            translated = _PROVIDER_FUNCS[provider](text, cfg)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            errors.append("%s: 网络错误 %s" % (provider, exc))
            continue
        except Exception as exc:
            errors.append("%s: %s" % (provider, exc))
            continue
        translated = str(translated or "").strip()
        if translated:
            cache[_cache_key(cfg["provider"], cfg["source"], cfg["target"], text)] = translated
            return translated
    raise RuntimeError("；".join(errors) if errors else "翻译失败")


def translate_many(texts, settings=None) -> dict:
    """批量翻译。返回 {translations: {原文: 译文}, failed: n, provider, cached: n}"""
    cfg = normalize_settings(settings or get_settings())
    items = []
    seen = set()
    for raw in texts or []:
        text = str(raw or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        items.append(text)
    if not items:
        return {"translations": {}, "failed": 0, "provider": cfg["provider"], "cached": 0, "total": 0}

    truncated = len(items) > MAX_BATCH
    items = items[:MAX_BATCH]

    cache = _load_cache()
    out = {}
    failed = 0
    cached_hits = 0
    last_error = ""

    for index, text in enumerate(items):
        key = _cache_key(cfg["provider"], cfg["source"], cfg["target"], text)
        if key in cache:
            out[text] = cache[key]
            cached_hits += 1
            continue
        try:
            out[text] = translate_one(text, cfg)
        except Exception as exc:
            failed += 1
            last_error = str(exc)
        if index < len(items) - 1:
            time.sleep(REQUEST_GAP)

    _save_cache()
    result = {
        "translations": out,
        "failed": failed,
        "provider": cfg["provider"],
        "cached": cached_hits,
        "total": len(items),
        "truncated": truncated,
    }
    if last_error:
        result["error"] = last_error
    return result


def test_translate() -> dict:
    """自检：翻译一个短语，返回耗时与结果。"""
    started = time.time()
    cfg = get_settings()
    sample = "long hair, blue eyes"
    try:
        translated = translate_one(sample, cfg)
        return {
            "ok": True,
            "provider": cfg["provider"],
            "source": cfg["source"],
            "target": cfg["target"],
            "sample": sample,
            "result": translated,
            "ms": int((time.time() - started) * 1000),
        }
    except Exception as exc:
        return {
            "ok": False,
            "provider": cfg["provider"],
            "sample": sample,
            "error": str(exc),
            "ms": int((time.time() - started) * 1000),
        }
