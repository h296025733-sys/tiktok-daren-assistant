from __future__ import annotations

import hashlib
import io
import json
import threading
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import model_manager


@pytest.fixture
def isolated_model_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("TIKTOK_ASSISTANT_HOME", str(tmp_path))
    monkeypatch.delenv("TIKTOK_ASSISTANT_MODEL_ROOT", raising=False)
    monkeypatch.delenv("TDA_DATA_ROOT", raising=False)
    monkeypatch.delenv("TDA_MODEL_ROOT", raising=False)
    model_manager.reset_model_manager_for_tests()
    yield tmp_path
    model_manager.reset_model_manager_for_tests()


def test_model_api_lists_whitelisted_models_with_stable_contract(
    isolated_model_home: Path,
) -> None:
    with TestClient(app) as client:
        response = client.get("/api/v1/models")

    assert response.status_code == 200
    models = {item["id"]: item for item in response.json()["models"]}
    assert set(models) == {"whisper-base", "argos-en-zh", "argos-ru-en"}
    assert models["whisper-base"] == {
        "id": "whisper-base",
        "name": "Whisper Base 语音识别模型",
        "purpose": "transcription",
        "state": "missing",
        "installed": False,
        "estimated_size_bytes": 147_882_941,
        "downloaded_bytes": 0,
        "total_bytes": 147_882_941,
        "error": None,
    }
    assert models["argos-en-zh"]["purpose"] == "offline_translation"
    assert models["argos-en-zh"]["estimated_size_bytes"] == 70_743_021
    assert models["argos-ru-en"]["purpose"] == "offline_translation"
    assert models["argos-ru-en"]["estimated_size_bytes"] == 156_239_112

    russian_asset = model_manager.MODEL_SPECS["argos-ru-en"].assets[0]
    assert russian_asset.url == "https://argos-net.com/v1/translate-ru_en-1_9.argosmodel"
    assert russian_asset.sha256 == (
        "e9ba8bf722d10a4a4c39f74289d5938fd47eac08dbe4ed0afd22d89445a5c3ac"
    )


def test_model_install_is_backgrounded_and_concurrent_requests_are_deduplicated(
    isolated_model_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = threading.Event()
    release = threading.Event()
    calls = 0

    def fake_install(spec, progress) -> None:
        nonlocal calls
        calls += 1
        started.set()
        assert release.wait(timeout=2)
        progress(spec.estimated_size_bytes)
        _write_valid_argos_install(model_manager.model_destination(spec.id))

    monkeypatch.setattr(model_manager, "_install_model", fake_install)

    with TestClient(app) as client:
        first = client.post("/api/v1/models/argos-en-zh/install")
        assert first.status_code == 202
        assert first.json()["state"] == "downloading"
        assert started.wait(timeout=1)

        second = client.post("/api/v1/models/argos-en-zh/install")
        assert second.status_code == 202
        assert second.json()["state"] in {"downloading", "installing"}
        assert calls == 1

        release.set()
        ready = _poll_model(client, "argos-en-zh", "ready")

    assert ready["installed"] is True
    assert ready["downloaded_bytes"] == ready["total_bytes"]
    assert calls == 1


def test_argos_install_uses_staging_atomic_destination_and_removes_archive(
    isolated_model_home: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_download(asset, destination, progress) -> None:
        _write_argos_archive(destination)
        progress(asset.size_bytes)

    monkeypatch.setattr(model_manager, "_download_asset", fake_download)
    status = model_manager.install_model_blocking("argos-en-zh")

    assert status.state == "ready"
    assert status.installed is True
    destination = isolated_model_home / "models" / "argos" / "packages" / "translate-en_zh-1_9"
    assert (destination / "metadata.json").is_file()
    staging = isolated_model_home / "cache" / "model-downloads"
    assert not list(staging.glob("**/*.argosmodel"))
    assert not list(staging.glob("*.partial"))


def test_download_rejects_sha_mismatch_and_removes_partial_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = b"bad"
    asset = model_manager.DownloadAsset(
        file_name="asset.bin",
        url="https://models.example/asset.bin",
        size_bytes=len(payload),
        sha256=hashlib.sha256(b"good").hexdigest(),
    )
    monkeypatch.setattr(
        model_manager.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: io.BytesIO(payload),
    )
    destination = tmp_path / asset.file_name

    with pytest.raises(model_manager.ModelInstallError, match="SHA256"):
        model_manager._download_asset(asset, destination, lambda _value: None)

    assert not destination.exists()
    assert not (tmp_path / "asset.bin.partial").exists()


def test_download_stops_when_server_exceeds_declared_size(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = b"too-large"
    asset = model_manager.DownloadAsset(
        file_name="asset.bin",
        url="https://models.example/asset.bin",
        size_bytes=3,
        sha256=hashlib.sha256(payload).hexdigest(),
    )
    monkeypatch.setattr(
        model_manager.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: io.BytesIO(payload),
    )

    with pytest.raises(model_manager.ModelInstallError, match="超过预期大小"):
        model_manager._download_asset(asset, tmp_path / asset.file_name, lambda _value: None)

    assert not list(tmp_path.iterdir())


def test_argos_extractor_rejects_path_traversal(tmp_path: Path) -> None:
    archive = tmp_path / "unsafe.argosmodel"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("../outside.txt", "unsafe")
    spec = model_manager.MODEL_SPECS["argos-en-zh"]

    with pytest.raises(model_manager.ModelInstallError, match="不安全路径"):
        model_manager._extract_argos_archive(spec, archive, tmp_path)

    assert not (tmp_path.parent / "outside.txt").exists()


def test_argos_extractor_rejects_expanded_size_over_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    member = zipfile.ZipInfo("translate-en_zh-1_9/model/model.bin")
    member.file_size = model_manager.MAX_ARGOS_EXPANDED_BYTES + 1

    class OversizedBundle:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def testzip(self):
            return None

        def infolist(self):
            return [member]

        def extractall(self, _destination):
            raise AssertionError("oversized archive must not be extracted")

    monkeypatch.setattr(model_manager.zipfile, "ZipFile", lambda _archive: OversizedBundle())
    archive = tmp_path / "oversized.argosmodel"
    archive.write_bytes(b"placeholder")

    with pytest.raises(model_manager.ModelInstallError, match="解压后超过允许大小"):
        model_manager._extract_argos_archive(
            model_manager.MODEL_SPECS["argos-en-zh"],
            archive,
            tmp_path,
        )


def test_unknown_model_install_is_rejected_without_starting_a_download(
    isolated_model_home: Path,
) -> None:
    with TestClient(app) as client:
        response = client.post("/api/v1/models/not-allowed/install")
    assert response.status_code == 404
    assert response.json() == {"detail": "未知模型"}


def _poll_model(client: TestClient, model_id: str, expected_state: str) -> dict:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        response = client.get("/api/v1/models")
        item = next(item for item in response.json()["models"] if item["id"] == model_id)
        if item["state"] == expected_state:
            return item
        time.sleep(0.01)
    raise AssertionError(f"model {model_id} did not reach {expected_state}")


def _write_argos_archive(destination: Path) -> None:
    root = "translate-en_zh-1_9"
    with zipfile.ZipFile(destination, "w") as bundle:
        bundle.writestr(
            f"{root}/metadata.json",
            json.dumps({"from_code": "en", "to_code": "zh"}),
        )
        bundle.writestr(f"{root}/model/model.bin", b"model")
        bundle.writestr(f"{root}/model/config.json", "{}")
        bundle.writestr(f"{root}/sentencepiece.model", b"sentencepiece")


def _write_valid_argos_install(destination: Path) -> None:
    (destination / "model").mkdir(parents=True, exist_ok=True)
    (destination / "metadata.json").write_text(
        json.dumps({"from_code": "en", "to_code": "zh"}),
        encoding="utf-8",
    )
    (destination / "model" / "model.bin").write_bytes(b"model")
    (destination / "model" / "config.json").write_text("{}", encoding="utf-8")
    (destination / "sentencepiece.model").write_bytes(b"sentencepiece")
