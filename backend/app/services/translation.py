import asyncio
from collections import OrderedDict
from dataclasses import dataclass
import threading
import time
from typing import Any, Iterable, get_args

import httpx

from app.models.translation import TranslationTargetLanguage
from app.services.outbound_proxy import resolve_outbound_proxy


GOOGLE_TRANSLATE_WEB_ENDPOINT = "https://translate.googleapis.com/translate_a/single"
TRANSLATION_TIMEOUT_SECONDS = 8.0
GOOGLE_BATCH_DEFAULT_CONCURRENCY = 6
GOOGLE_BATCH_MAX_CONCURRENCY = 8
TRANSLATION_CACHE_TTL_SECONDS = 300.0
TRANSLATION_CACHE_MAX_ENTRIES = 2_048
SUPPORTED_TRANSLATION_TARGET_LANGUAGES = frozenset(get_args(TranslationTargetLanguage))


class TranslationProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class GoogleTranslationAttempt:
    translated_text: str | None = None
    detected_source_language: str | None = None
    error: TranslationProviderError | None = None


@dataclass(frozen=True)
class _CachedGoogleTranslation:
    translated_text: str
    detected_source_language: str | None
    expires_at: float


_TRANSLATION_CACHE_LOCK = threading.Lock()
_TRANSLATION_CACHE: OrderedDict[
    tuple[str, str], _CachedGoogleTranslation
] = OrderedDict()


async def translate_google_web(
    text: str,
    target_language: TranslationTargetLanguage = "zh-CN",
) -> tuple[str, str | None]:
    _validate_target_language(target_language)
    cached = _get_cached_translation(text, target_language)
    if cached is not None:
        return cached
    proxy_url = resolve_outbound_proxy()
    async with _google_client(proxy_url) as client:
        translated = await _translate_google_web_with_client(client, text, target_language)
    _cache_translation(text, target_language, translated)
    return translated


async def translate_google_web_batch(
    texts: Iterable[str],
    target_language: TranslationTargetLanguage = "zh-CN",
    *,
    max_concurrency: int = GOOGLE_BATCH_DEFAULT_CONCURRENCY,
) -> list[GoogleTranslationAttempt]:
    """使用一个连接池翻译多条文本，并为每条保留独立失败信息。"""
    _validate_target_language(target_language)
    items = list(texts)
    if not items:
        return []
    concurrency = max(1, min(max_concurrency, GOOGLE_BATCH_MAX_CONCURRENCY))
    semaphore = asyncio.Semaphore(concurrency)
    proxy_url = resolve_outbound_proxy()
    unique_items = list(dict.fromkeys(items))

    async with _google_client(proxy_url) as client:
        async def translate_one(text: str) -> GoogleTranslationAttempt:
            cached = _get_cached_translation(text, target_language)
            if cached is not None:
                return GoogleTranslationAttempt(
                    translated_text=cached[0],
                    detected_source_language=cached[1],
                )
            async with semaphore:
                # A concurrent request may have populated the cache while this
                # item was waiting for a network slot.
                cached = _get_cached_translation(text, target_language)
                if cached is not None:
                    return GoogleTranslationAttempt(
                        translated_text=cached[0],
                        detected_source_language=cached[1],
                    )
                try:
                    translated_text, detected_language = (
                        await _translate_google_web_with_client(
                            client,
                            text,
                            target_language,
                        )
                    )
                except TranslationProviderError as error:
                    return GoogleTranslationAttempt(error=error)
                _cache_translation(
                    text,
                    target_language,
                    (translated_text, detected_language),
                )
                return GoogleTranslationAttempt(
                    translated_text=translated_text,
                    detected_source_language=detected_language,
                )

        unique_attempts = await asyncio.gather(
            *(translate_one(text) for text in unique_items)
        )
    attempts_by_text = dict(zip(unique_items, unique_attempts))
    return [attempts_by_text[text] for text in items]


def _get_cached_translation(
    text: str,
    target_language: TranslationTargetLanguage,
) -> tuple[str, str | None] | None:
    key = (target_language, text)
    now = time.monotonic()
    with _TRANSLATION_CACHE_LOCK:
        cached = _TRANSLATION_CACHE.get(key)
        if cached is None:
            return None
        if cached.expires_at <= now:
            del _TRANSLATION_CACHE[key]
            return None
        _TRANSLATION_CACHE.move_to_end(key)
        return cached.translated_text, cached.detected_source_language


def _cache_translation(
    text: str,
    target_language: TranslationTargetLanguage,
    translated: tuple[str, str | None],
) -> None:
    key = (target_language, text)
    now = time.monotonic()
    entry = _CachedGoogleTranslation(
        translated_text=translated[0],
        detected_source_language=translated[1],
        expires_at=now + TRANSLATION_CACHE_TTL_SECONDS,
    )
    with _TRANSLATION_CACHE_LOCK:
        expired_keys = [
            cached_key
            for cached_key, cached in _TRANSLATION_CACHE.items()
            if cached.expires_at <= now
        ]
        for expired_key in expired_keys:
            del _TRANSLATION_CACHE[expired_key]
        _TRANSLATION_CACHE[key] = entry
        _TRANSLATION_CACHE.move_to_end(key)
        while len(_TRANSLATION_CACHE) > TRANSLATION_CACHE_MAX_ENTRIES:
            _TRANSLATION_CACHE.popitem(last=False)


def reset_translation_cache_for_tests() -> None:
    with _TRANSLATION_CACHE_LOCK:
        _TRANSLATION_CACHE.clear()


def _google_client(proxy_url: str | None) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(TRANSLATION_TIMEOUT_SECONDS),
        follow_redirects=True,
        proxy=proxy_url,
        trust_env=False,
        headers={
            "Accept": "application/json",
            "User-Agent": "TikTok-Daren-Assistant/0.1",
        },
    )


def _validate_target_language(target_language: str) -> None:
    if target_language not in SUPPORTED_TRANSLATION_TARGET_LANGUAGES:
        raise TranslationProviderError("不支持该目标语言")


async def _translate_google_web_with_client(
    client: httpx.AsyncClient,
    text: str,
    target_language: TranslationTargetLanguage,
) -> tuple[str, str | None]:
    params = {
        "client": "gtx",
        "sl": "auto",
        "tl": target_language,
        "dt": "t",
        "q": text,
    }
    try:
        response = await client.get(
            GOOGLE_TRANSLATE_WEB_ENDPOINT,
            params=params,
        )
        response.raise_for_status()
    except httpx.TimeoutException as error:
        raise TranslationProviderError("Google 翻译请求超时") from error
    except httpx.HTTPError as error:
        raise TranslationProviderError("Google 翻译网络请求失败") from error

    try:
        payload: Any = response.json()
        segments = payload[0]
        translated_text = "".join(
            segment[0]
            for segment in segments
            if isinstance(segment, list) and segment and isinstance(segment[0], str)
        ).strip()
        detected_language = payload[2] if isinstance(payload[2], str) else None
    except (IndexError, TypeError, ValueError) as error:
        raise TranslationProviderError("Google 翻译返回了无法识别的内容") from error
    if not translated_text:
        raise TranslationProviderError("Google 翻译未返回有效译文")
    return translated_text, detected_language
