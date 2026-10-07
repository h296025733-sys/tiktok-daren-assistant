from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any

import httpx
import pytest

from app.services import translation


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(autouse=True)
def reset_google_translation_cache() -> Iterator[None]:
    translation.reset_translation_cache_for_tests()
    yield
    translation.reset_translation_cache_for_tests()


@pytest.mark.anyio
async def test_google_translation_uses_only_the_controlled_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: dict[str, Any] = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> list[object]:
            return [[["\u4f60\u597d", "hello"]], None, "en"]

    class FakeClient:
        def __init__(self, **options: Any) -> None:
            observed.update(options)

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        async def get(self, url: str, **options: Any) -> FakeResponse:
            observed["url"] = url
            observed["request_options"] = options
            return FakeResponse()

    monkeypatch.setattr(
        translation,
        "resolve_outbound_proxy",
        lambda: "http://127.0.0.1:9567",
    )
    monkeypatch.setattr(translation.httpx, "AsyncClient", FakeClient)

    translated, language = await translation.translate_google_web("hello", "ja")

    assert (translated, language) == ("\u4f60\u597d", "en")
    assert observed["proxy"] == "http://127.0.0.1:9567"
    assert observed["trust_env"] is False
    assert observed["url"] == translation.GOOGLE_TRANSLATE_WEB_ENDPOINT
    assert observed["request_options"]["params"]["tl"] == "ja"


@pytest.mark.anyio
async def test_google_translation_rejects_unknown_target_before_network() -> None:
    with pytest.raises(translation.TranslationProviderError, match="不支持该目标语言"):
        await translation.translate_google_web("hello", "xx")  # type: ignore[arg-type]


@pytest.mark.anyio
async def test_google_batch_reuses_one_client_and_keeps_per_item_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: dict[str, Any] = {"clients": 0, "queries": []}

    class FakeResponse:
        def __init__(self, text: str) -> None:
            self.text = text

        def raise_for_status(self) -> None:
            return None

        def json(self) -> list[object]:
            return [[[f"translated-{self.text}", self.text]], None, "en"]

    class FakeClient:
        def __init__(self, **_: Any) -> None:
            observed["clients"] += 1

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        async def get(self, _: str, **options: Any) -> FakeResponse:
            query = options["params"]["q"]
            observed["queries"].append(query)
            if query == "bad":
                raise httpx.ReadTimeout("simulated timeout")
            return FakeResponse(query)

    monkeypatch.setattr(translation, "resolve_outbound_proxy", lambda: None)
    monkeypatch.setattr(translation.httpx, "AsyncClient", FakeClient)

    attempts = await translation.translate_google_web_batch(
        ["one", "bad", "two"],
        "zh-CN",
        max_concurrency=2,
    )

    assert observed["clients"] == 1
    assert observed["queries"] == ["one", "bad", "two"]
    assert attempts[0].translated_text == "translated-one"
    assert attempts[0].detected_source_language == "en"
    assert attempts[0].error is None
    assert attempts[1].translated_text is None
    assert isinstance(attempts[1].error, translation.TranslationProviderError)
    assert str(attempts[1].error) == "Google 翻译请求超时"
    assert attempts[2].translated_text == "translated-two"

    retry = await translation.translate_google_web_batch(["bad"], "zh-CN")
    assert isinstance(retry[0].error, translation.TranslationProviderError)
    assert observed["queries"].count("bad") == 2


@pytest.mark.anyio
async def test_google_batch_is_bounded_deduplicated_ordered_and_cached(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: dict[str, Any] = {
        "active": 0,
        "peak": 0,
        "queries": [],
    }

    class FakeResponse:
        def __init__(self, text: str) -> None:
            self.text = text

        def raise_for_status(self) -> None:
            return None

        def json(self) -> list[object]:
            return [[[f"translated-{self.text}", self.text]], None, "en"]

    class FakeClient:
        def __init__(self, **_: Any) -> None:
            return None

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        async def get(self, _: str, **options: Any) -> FakeResponse:
            query = options["params"]["q"]
            observed["queries"].append(query)
            observed["active"] += 1
            observed["peak"] = max(observed["peak"], observed["active"])
            try:
                await asyncio.sleep(0.02)
                return FakeResponse(query)
            finally:
                observed["active"] -= 1

    monkeypatch.setattr(translation, "resolve_outbound_proxy", lambda: None)
    monkeypatch.setattr(translation.httpx, "AsyncClient", FakeClient)
    texts = ["one", "two", "one", "three", "two"]

    first = await translation.translate_google_web_batch(
        texts,
        "zh-CN",
        max_concurrency=2,
    )
    queries_after_first_call = list(observed["queries"])
    second = await translation.translate_google_web_batch(
        texts,
        "zh-CN",
        max_concurrency=2,
    )

    assert observed["peak"] == 2
    assert queries_after_first_call == ["one", "two", "three"]
    assert observed["queries"] == queries_after_first_call
    expected = [f"translated-{text}" for text in texts]
    assert [attempt.translated_text for attempt in first] == expected
    assert [attempt.translated_text for attempt in second] == expected


@pytest.mark.anyio
async def test_google_cache_is_target_aware_and_lru_bounded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: list[tuple[str, str]] = []

    class FakeResponse:
        def __init__(self, text: str, target: str) -> None:
            self.text = text
            self.target = target

        def raise_for_status(self) -> None:
            return None

        def json(self) -> list[object]:
            return [[[f"{self.target}-{self.text}", self.text]], None, "en"]

    class FakeClient:
        def __init__(self, **_: Any) -> None:
            return None

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        async def get(self, _: str, **options: Any) -> FakeResponse:
            params = options["params"]
            observed.append((params["tl"], params["q"]))
            return FakeResponse(params["q"], params["tl"])

    monkeypatch.setattr(translation, "resolve_outbound_proxy", lambda: None)
    monkeypatch.setattr(translation.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(translation, "TRANSLATION_CACHE_MAX_ENTRIES", 2)

    assert await translation.translate_google_web("same", "zh-CN") == (
        "zh-CN-same",
        "en",
    )
    assert await translation.translate_google_web("same", "ja") == ("ja-same", "en")
    assert await translation.translate_google_web("third", "zh-CN") == (
        "zh-CN-third",
        "en",
    )
    assert len(translation._TRANSLATION_CACHE) == 2
    assert observed == [("zh-CN", "same"), ("ja", "same"), ("zh-CN", "third")]
