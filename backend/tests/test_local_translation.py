import pytest

from app.services import local_translation
from app.services.local_translation import (
    LocalRuntimeUnavailableError,
    LocalTranslationError,
    detect_source_language,
)
from app.services.native_runtime import reset_native_runtime_for_tests


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("подскажите аккорды", "ru"),
        ("Hello world", "en"),
        ("こんにちは", "ja"),
        ("안녕하세요", "ko"),
        ("已经是中文", "zh"),
        ("Привіт", "uk"),
    ],
)
def test_detect_source_language_by_script(text: str, expected: str) -> None:
    assert detect_source_language(text) == expected


def test_detect_source_language_rejects_non_linguistic_text() -> None:
    with pytest.raises(LocalTranslationError, match="无法识别"):
        detect_source_language("12345 !!!")


def test_policy_block_is_reported_before_offline_model_download(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TIKTOK_ASSISTANT_DIAGNOSTIC_AI_POLICY_BLOCK", "1")
    reset_native_runtime_for_tests()
    try:
        with pytest.raises(LocalRuntimeUnavailableError) as captured:
            local_translation.translate_argos_local("Hello world")
    finally:
        reset_native_runtime_for_tests()

    assert captured.value.code == "APPLICATION_CONTROL_BLOCKED"
    assert captured.value.policy_blocked is True
