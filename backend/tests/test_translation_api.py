import threading

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.local_translation import LocalTranslationError
from app.services import model_manager
from app.services.translation import GoogleTranslationAttempt, TranslationProviderError


def test_translation_proxy_returns_google_result(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_translate(text: str, target_language: str) -> tuple[str, str | None]:
        assert text == "Hello world"
        assert target_language == "zh-CN"
        return "你好世界", "en"

    monkeypatch.setattr("app.api.translations.translate_google_web", fake_translate)
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/translations/google",
            json={"text": "Hello world", "target_language": "zh-CN"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "translated_text": "你好世界",
        "detected_source_language": "en",
        "target_language": "zh-CN",
        "provider": "google_translate_web",
    }


def test_translation_proxy_rejects_private_or_extra_payload_fields() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/translations/google",
            json={"text": "hello", "cookie": "must-not-be-accepted"},
        )
    assert response.status_code == 422


@pytest.mark.parametrize("text", ["", "   ", "a" * 1_601])
def test_translation_proxy_validates_text_limits(text: str) -> None:
    with TestClient(app) as client:
        response = client.post("/api/v1/translations/google", json={"text": text})
    assert response.status_code == 422


def test_translation_proxy_reports_provider_failure_without_echoing_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_translate(_: str, __: str) -> tuple[str, str | None]:
        raise TranslationProviderError("Google 翻译网络请求失败")

    monkeypatch.setattr("app.api.translations.translate_google_web", fake_translate)
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/translations/google",
            json={"text": "private-looking-test-value"},
        )

    assert response.status_code == 502
    assert response.json() == {"detail": "Google 翻译网络请求失败"}
    assert "private-looking-test-value" not in response.text


def test_translation_chain_falls_back_to_local_argos_after_google_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_local(text: str) -> tuple[str, str, list[str]]:
        assert text == "Привет"
        return "你好", "ru", ["ru", "en", "zh"]

    async def unavailable_google(_: str, __: str) -> tuple[str, str | None]:
        raise TranslationProviderError("网络失败")

    monkeypatch.setattr("app.api.translations.translate_argos_local", fake_local)
    monkeypatch.setattr("app.api.translations.translate_google_web", unavailable_google)
    with TestClient(app) as client:
        response = client.post("/api/v1/translations/translate", json={"text": "Привет"})

    assert response.status_code == 200
    assert response.json() == {
        "translated_text": "你好",
        "detected_source_language": "ru",
        "target_language": "zh-CN",
        "provider": "argos_local",
        "route": ["ru", "en", "zh"],
    }


def test_translation_chain_google_success_never_touches_local_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def local_must_not_run(_: str) -> tuple[str, str, list[str]]:
        raise AssertionError("Google success must not touch local models")

    async def fake_google(_: str, target_language: str) -> tuple[str, str | None]:
        assert target_language == "zh-CN"
        return "你好", "en"

    monkeypatch.setattr("app.api.translations.translate_argos_local", local_must_not_run)
    monkeypatch.setattr("app.api.translations.translate_google_web", fake_google)
    with TestClient(app) as client:
        response = client.post("/api/v1/translations/translate", json={"text": "Hello"})

    assert response.status_code == 200
    assert response.json()["provider"] == "google_translate_web"
    assert "route" not in response.json()


def test_single_translation_google_failure_returns_installable_model_requirement(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TIKTOK_ASSISTANT_HOME", str(tmp_path))
    model_manager.reset_model_manager_for_tests()

    async def unavailable_google(_: str, __: str) -> tuple[str, str | None]:
        raise TranslationProviderError("网络失败")

    monkeypatch.setattr("app.api.translations.translate_google_web", unavailable_google)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/translations/translate",
                json={"text": "Hello", "target_language": "zh-CN"},
            )
    finally:
        model_manager.reset_model_manager_for_tests()

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "LOCAL_MODEL_REQUIRED"
    assert detail["model_ids"] == ["argos-en-zh"]
    assert detail["models"][0]["id"] == "argos-en-zh"
    assert detail["models"][0]["installed"] is False


def test_translation_chain_reports_both_failures_without_echoing_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_local(_: str) -> tuple[str, str, list[str]]:
        raise LocalTranslationError("模型未安装")

    async def fake_google(_: str, __: str) -> tuple[str, str | None]:
        raise TranslationProviderError("网络失败")

    monkeypatch.setattr("app.api.translations.translate_argos_local", fake_local)
    monkeypatch.setattr("app.api.translations.translate_google_web", fake_google)
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/translations/translate",
            json={"text": "private-looking-test-value"},
        )

    assert response.status_code == 502
    assert "模型未安装" in response.json()["detail"]
    assert "网络失败" in response.json()["detail"]
    assert "private-looking-test-value" not in response.text


def test_non_chinese_target_skips_argos_and_uses_google(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_if_called(_: str) -> tuple[str, str, list[str]]:
        raise AssertionError("非中文目标不应调用 Argos")

    async def fake_google(text: str, target_language: str) -> tuple[str, str | None]:
        assert text == "Hello"
        assert target_language == "ja"
        return "こんにちは", "en"

    monkeypatch.setattr("app.api.translations.translate_argos_local", fail_if_called)
    monkeypatch.setattr("app.api.translations.translate_google_web", fake_google)
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/translations/translate",
            json={"text": "Hello", "target_language": "ja"},
        )
    assert response.status_code == 200
    assert response.json() == {
        "translated_text": "こんにちは",
        "detected_source_language": "en",
        "target_language": "ja",
        "provider": "google_translate_web",
    }


def test_translation_rejects_unknown_target_language() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/translations/translate",
            json={"text": "Hello", "target_language": "xx"},
        )
    assert response.status_code == 422


def test_batch_translation_returns_google_and_local_results_in_input_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_google_batch(
        texts: list[str],
        target_language: str,
    ) -> list[GoogleTranslationAttempt]:
        assert texts == ["Hello", "Привет", "broken"]
        assert target_language == "zh-CN"
        unavailable = TranslationProviderError("Google 翻译网络请求失败")
        return [
            GoogleTranslationAttempt("你好", "en"),
            GoogleTranslationAttempt(error=unavailable),
            GoogleTranslationAttempt(error=unavailable),
        ]

    def fake_local(text: str) -> tuple[str, str, list[str]]:
        if text == "Привет":
            return "您好", "ru", ["ru", "en", "zh"]
        raise LocalTranslationError("模型未安装")

    monkeypatch.setattr("app.api.translations.translate_google_web_batch", fake_google_batch)
    monkeypatch.setattr("app.api.translations.translate_argos_local", fake_local)

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/translations/batch",
            json={"texts": ["Hello", "Привет", "broken"], "target_language": "zh-CN"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["target_language"] == "zh-CN"
    assert body["succeeded"] == 2
    assert body["failed"] == 1
    assert body["results"] == [
        {
            "index": 0,
            "ok": True,
            "translated_text": "你好",
            "detected_source_language": "en",
            "provider": "google_translate_web",
        },
        {
            "index": 1,
            "ok": True,
            "translated_text": "您好",
            "detected_source_language": "ru",
            "provider": "argos_local",
            "route": ["ru", "en", "zh"],
        },
        {
            "index": 2,
            "ok": False,
            "error_code": "TRANSLATION_UNAVAILABLE",
            "error_message": (
                "在线翻译不可用：Google 翻译网络请求失败；"
                "本地翻译不可用：模型未安装"
            ),
        },
    ]


def test_batch_translation_non_chinese_failure_has_stable_error_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_google_batch(
        _: list[str],
        __: str,
    ) -> list[GoogleTranslationAttempt]:
        return [
            GoogleTranslationAttempt(
                error=TranslationProviderError("Google 翻译请求超时")
            )
        ]

    def local_must_not_run(_: str) -> tuple[str, str, list[str]]:
        raise AssertionError("非简体中文目标不应调用本地模型")

    monkeypatch.setattr("app.api.translations.translate_google_web_batch", fake_google_batch)
    monkeypatch.setattr("app.api.translations.translate_argos_local", local_must_not_run)

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/translations/batch",
            json={"texts": ["private-looking-test-value"], "target_language": "ja"},
        )

    assert response.status_code == 200
    assert response.json()["results"] == [
        {
            "index": 0,
            "ok": False,
            "error_code": "ONLINE_TRANSLATION_UNAVAILABLE",
            "error_message": "在线翻译不可用：Google 翻译请求超时",
        }
    ]
    assert "private-looking-test-value" not in response.text


def test_batch_translation_runs_local_fallbacks_with_bounded_parallelism(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_google_batch(
        texts: list[str],
        _: str,
    ) -> list[GoogleTranslationAttempt]:
        return [
            GoogleTranslationAttempt(
                error=TranslationProviderError("Google unavailable")
            )
            for _ in texts
        ]

    lock = threading.Lock()
    release_first_pair = threading.Event()
    active = 0
    peak = 0

    def fake_local(text: str) -> tuple[str, str, list[str]]:
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
            if active == 2:
                release_first_pair.set()
        try:
            assert release_first_pair.wait(timeout=1.0)
            return f"local-{text}", "en", ["en", "zh"]
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr("app.api.translations.translate_google_web_batch", fake_google_batch)
    monkeypatch.setattr("app.api.translations.translate_argos_local", fake_local)

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/translations/batch",
            json={"texts": ["one", "two", "three"], "target_language": "zh-CN"},
        )

    assert response.status_code == 200
    assert peak == 2
    assert [item["translated_text"] for item in response.json()["results"]] == [
        "local-one",
        "local-two",
        "local-three",
    ]
    assert all(
        item["provider"] == "argos_local" for item in response.json()["results"]
    )


@pytest.mark.parametrize(
    "texts",
    [[], ["   "], ["a" * 1_601], ["a" * 1_000] * 25, ["ok"] * 81],
)
def test_batch_translation_validates_item_and_batch_limits(texts: list[str]) -> None:
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/translations/batch",
            json={"texts": texts},
        )
    assert response.status_code == 422


def test_batch_google_success_never_checks_or_installs_local_model(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TIKTOK_ASSISTANT_HOME", str(tmp_path))

    async def fake_google_batch(
        texts: list[str],
        target_language: str,
    ) -> list[GoogleTranslationAttempt]:
        assert texts == ["Hello"]
        assert target_language == "zh-CN"
        return [GoogleTranslationAttempt("你好", "en")]

    def local_must_not_run(_: str) -> tuple[str, str, list[str]]:
        raise AssertionError("Google success must not touch local models")

    monkeypatch.setattr("app.api.translations.translate_google_web_batch", fake_google_batch)
    monkeypatch.setattr("app.api.translations.translate_argos_local", local_must_not_run)
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/translations/batch",
            json={"texts": ["Hello"], "target_language": "zh-CN"},
        )

    assert response.status_code == 200
    assert response.json()["results"][0]["provider"] == "google_translate_web"


def test_batch_google_failure_reports_missing_english_local_model(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TIKTOK_ASSISTANT_HOME", str(tmp_path))
    model_manager.reset_model_manager_for_tests()

    async def unavailable_google(
        _texts: list[str],
        _target_language: str,
    ) -> list[GoogleTranslationAttempt]:
        return [GoogleTranslationAttempt(error=TranslationProviderError("网络失败"))]

    monkeypatch.setattr("app.api.translations.translate_google_web_batch", unavailable_google)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/translations/batch",
                json={"texts": ["Hello"], "target_language": "zh-CN"},
            )
    finally:
        model_manager.reset_model_manager_for_tests()

    assert response.status_code == 200
    item = response.json()["results"][0]
    assert item["ok"] is False
    assert item["error_code"] == "LOCAL_MODEL_REQUIRED"
    assert item["required_model_ids"] == ["argos-en-zh"]


@pytest.mark.parametrize(
    ("installed_model_ids", "expected_required"),
    [
        (set(), ["argos-ru-en", "argos-en-zh"]),
        ({"argos-ru-en"}, ["argos-en-zh"]),
        ({"argos-en-zh"}, ["argos-ru-en"]),
    ],
)
def test_batch_russian_fallback_reports_only_missing_route_models(
    installed_model_ids: set[str],
    expected_required: list[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def unavailable_google(
        _texts: list[str],
        _target_language: str,
    ) -> list[GoogleTranslationAttempt]:
        return [GoogleTranslationAttempt(error=TranslationProviderError("网络失败"))]

    monkeypatch.setattr("app.api.translations.translate_google_web_batch", unavailable_google)
    monkeypatch.setattr(
        "app.services.local_translation.is_model_installed",
        lambda model_id: model_id in installed_model_ids,
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/translations/batch",
            json={"texts": ["Привет"], "target_language": "zh-CN"},
        )

    assert response.status_code == 200
    item = response.json()["results"][0]
    assert item["error_code"] == "LOCAL_MODEL_REQUIRED"
    assert item["required_model_ids"] == expected_required


def test_single_russian_translation_returns_both_missing_route_models(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TIKTOK_ASSISTANT_HOME", str(tmp_path))
    model_manager.reset_model_manager_for_tests()

    async def unavailable_google(_: str, __: str) -> tuple[str, str | None]:
        raise TranslationProviderError("网络失败")

    monkeypatch.setattr("app.api.translations.translate_google_web", unavailable_google)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/translations/translate",
                json={"text": "Привет", "target_language": "zh-CN"},
            )
    finally:
        model_manager.reset_model_manager_for_tests()

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "LOCAL_MODEL_REQUIRED"
    assert detail["model_ids"] == ["argos-ru-en", "argos-en-zh"]
    assert [model["id"] for model in detail["models"]] == [
        "argos-ru-en",
        "argos-en-zh",
    ]


def test_batch_unsupported_offline_language_does_not_offer_irrelevant_model(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TIKTOK_ASSISTANT_HOME", str(tmp_path))
    model_manager.reset_model_manager_for_tests()

    async def unavailable_google(
        _texts: list[str],
        _target_language: str,
    ) -> list[GoogleTranslationAttempt]:
        return [GoogleTranslationAttempt(error=TranslationProviderError("网络失败"))]

    monkeypatch.setattr("app.api.translations.translate_google_web_batch", unavailable_google)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/translations/batch",
                json={"texts": ["مرحبا"], "target_language": "zh-CN"},
            )
    finally:
        model_manager.reset_model_manager_for_tests()

    assert response.status_code == 200
    item = response.json()["results"][0]
    assert item["error_code"] == "TRANSLATION_UNAVAILABLE"
    assert "required_model_ids" not in item
