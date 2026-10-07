from __future__ import annotations

from pathlib import Path

import pytest

from app.storage import database, paths


def _clear_path_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "TIKTOK_ASSISTANT_HOME",
        "TIKTOK_ASSISTANT_MODEL_ROOT",
        "TIKTOK_ASSISTANT_OUTPUT_ROOT",
        "TIKTOK_ASSISTANT_DB_PATH",
        "TDA_DATA_ROOT",
        "TDA_MODEL_ROOT",
    ):
        monkeypatch.delenv(name, raising=False)


def test_development_model_path_keeps_backend_models(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_path_overrides(monkeypatch)
    monkeypatch.delattr(paths.sys, "frozen", raising=False)

    assert paths.get_model_root() == paths.BACKEND_ROOT / "models"
    assert paths.get_model_staging_root() == paths.BACKEND_ROOT / "models" / ".staging"
    assert paths.get_output_root() == paths.BACKEND_ROOT.parent / "outputs"


def test_install_home_and_explicit_model_root_have_stable_precedence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_path_overrides(monkeypatch)
    install_home = tmp_path / "home"
    explicit_models = tmp_path / "custom-models"
    monkeypatch.setenv("TIKTOK_ASSISTANT_HOME", str(install_home))

    assert paths.get_model_root() == install_home.resolve() / "models"
    assert paths.get_model_staging_root() == install_home.resolve() / "cache" / "model-downloads"
    assert paths.get_output_root() == install_home.resolve() / "outputs"

    monkeypatch.setenv("TIKTOK_ASSISTANT_MODEL_ROOT", str(explicit_models))
    assert paths.get_model_root() == explicit_models.resolve()

    explicit_outputs = tmp_path / "custom-outputs"
    monkeypatch.setenv("TIKTOK_ASSISTANT_OUTPUT_ROOT", str(explicit_outputs))
    assert paths.get_output_root() == explicit_outputs.resolve()


def test_frozen_build_defaults_to_local_app_data(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_path_overrides(monkeypatch)
    monkeypatch.setattr(paths.sys, "frozen", True, raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))

    expected_home = tmp_path.resolve() / "TikTokDarenAssistant"
    assert paths.get_data_root() == expected_home
    assert paths.get_model_root() == expected_home / "models"
    assert paths.get_model_staging_root() == expected_home / "cache" / "model-downloads"
    assert paths.get_output_root() == expected_home / "outputs"
    assert database.get_database_path() == expected_home / "data" / "tiktok_assistant.db"
