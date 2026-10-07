from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.download import DownloadedFile
from app.models.transcription import TranscriptSegment, TranscriptionResponse
from app.services import model_manager, transcription


def test_transcription_api_does_not_save_files_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_execute(request):
        assert request.media.video_id == "7654207540028394774"
        assert request.save_transcript_files is False
        return TranscriptionResponse(
            video_id=request.media.video_id,
            language="en",
            language_probability=0.99,
            duration_seconds=1.5,
            device_used="cpu",
            compute_type="int8",
            text="hello",
            segments=[TranscriptSegment(start=0, end=1.5, text="hello")],
            audio_file=None,
            transcript_files=[],
        )

    monkeypatch.setattr("app.api.transcriptions.execute_transcription", fake_execute)
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/transcriptions",
            json={
                "media": {
                    "video_id": "7654207540028394774",
                    "media_url": "https://v16.tiktokcdn.com/video.mp4",
                    "download_video": False,
                    "extract_audio": True,
                }
            },
        )

    assert response.status_code == 200
    assert response.json()["text"] == "hello"
    assert response.json()["audio_file"] is None
    assert response.json()["transcript_files"] == []


def test_transcription_api_accepts_explicit_file_download(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_execute(request):
        assert request.save_transcript_files is True
        return TranscriptionResponse(
            video_id=request.media.video_id,
            language="en",
            language_probability=0.99,
            duration_seconds=1.5,
            device_used="cpu",
            compute_type="int8",
            text="hello",
            segments=[TranscriptSegment(start=0, end=1.5, text="hello")],
            audio_file=None,
            transcript_files=[
                DownloadedFile(
                    kind="transcript_srt",
                    file_name="audio.srt",
                    path=str(Path("D:/outputs/audio.srt")),
                    size_bytes=50,
                )
            ],
        )

    monkeypatch.setattr("app.api.transcriptions.execute_transcription", fake_execute)
    monkeypatch.setattr(
        "app.api.transcriptions.expose_files",
        lambda files: [
            item.model_copy(update={"download_url": "/api/v1/downloads/files/test-token"})
            for item in files
        ],
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/transcriptions",
            json={
                "media": {
                    "video_id": "7654207540028394774",
                    "media_url": "https://v16.tiktokcdn.com/video.mp4",
                    "download_video": False,
                    "extract_audio": True,
                },
                "save_transcript_files": True,
            },
        )

    assert response.status_code == 200
    assert response.json()["transcript_files"][0]["kind"] == "transcript_srt"
    assert response.json()["transcript_files"][0]["download_url"].endswith("/test-token")
    assert "path" not in response.json()["transcript_files"][0]


def test_missing_transcription_model_returns_409_before_media_download(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TIKTOK_ASSISTANT_HOME", str(tmp_path))
    model_manager.reset_model_manager_for_tests()

    async def media_download_must_not_run(_request):
        raise AssertionError("missing model must be detected before media download")

    monkeypatch.setattr(
        "app.services.transcription.execute_single_download",
        media_download_must_not_run,
    )
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/transcriptions",
                json={
                    "media": {
                        "video_id": "7654207540028394774",
                        "media_url": "https://v16.tiktokcdn.com/video.mp4",
                        "download_video": False,
                        "extract_audio": True,
                    }
                },
            )
    finally:
        model_manager.reset_model_manager_for_tests()

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "MODEL_REQUIRED"
    assert detail["model_ids"] == ["whisper-base"]
    assert detail["models"][0]["id"] == "whisper-base"
    assert detail["models"][0]["installed"] is False


def test_application_control_block_returns_browser_fallback_before_model_download(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TIKTOK_ASSISTANT_HOME", str(tmp_path))
    monkeypatch.setenv("TIKTOK_ASSISTANT_DIAGNOSTIC_AI_POLICY_BLOCK", "1")
    model_manager.reset_model_manager_for_tests()
    transcription.clear_transcription_cache_for_tests()

    async def media_download_must_not_run(_request):
        raise AssertionError("policy block must be detected before media download")

    monkeypatch.setattr(
        "app.services.transcription.execute_single_download",
        media_download_must_not_run,
    )
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/transcriptions",
                json={
                    "media": {
                        "video_id": "7654207540028394774",
                        "media_url": "https://v16.tiktokcdn.com/video.mp4",
                        "download_video": False,
                        "extract_audio": True,
                    }
                },
            )
    finally:
        transcription.clear_transcription_cache_for_tests()
        model_manager.reset_model_manager_for_tests()

    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail["code"] == "APPLICATION_CONTROL_BLOCKED"
    assert detail["browser_fallback"] is True
    assert detail["policy_blocked"] is True
