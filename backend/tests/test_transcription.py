from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.models.download import DownloadedFile, SingleDownloadRequest, SingleDownloadResponse
from app.models.transcription import TranscriptSegment, TranscriptionRequest
from app.services import transcription


@pytest.fixture(autouse=True)
def clear_cache() -> None:
    transcription.clear_transcription_cache_for_tests()
    yield
    transcription.clear_transcription_cache_for_tests()


def test_transcription_falls_back_to_cpu_when_cuda_runtime_is_unavailable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audio = tmp_path / "audio.m4a"
    audio.write_bytes(b"audio")
    calls: list[tuple[str, str]] = []
    cpu_result = transcription._RawTranscription(
        language="en",
        language_probability=0.9,
        duration_seconds=1.0,
        segments=[TranscriptSegment(start=0, end=1, text="hello")],
        device_used="cpu",
        compute_type="int8",
        fallback_reason=None,
    )

    monkeypatch.setattr(transcription, "_model_is_installed", lambda: True)
    monkeypatch.setattr(
        transcription,
        "_load_transcription_runtime",
        lambda: (SimpleNamespace(get_cuda_device_count=lambda: 1), object),
    )

    def fake_run(*args, **kwargs):
        device = args[4]
        compute_type = args[5]
        calls.append((device, compute_type))
        if device == "cuda":
            raise RuntimeError("missing private CUDA detail")
        return cpu_result

    monkeypatch.setattr(transcription, "_run_transcription", fake_run)
    result = transcription.transcribe_audio(audio, None, 5, True)

    assert calls == [("cuda", "int8_float16"), ("cpu", "int8")]
    assert result.device_used == "cpu"
    assert result.fallback_reason == "CUDA 运行库不可用，已自动切换 CPU"
    assert "private" not in result.fallback_reason


def test_web_service_import_does_not_load_optional_native_ai_runtime() -> None:
    backend_root = Path(__file__).resolve().parents[1]
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys; import app.main; "
                "assert 'ctranslate2' not in sys.modules; "
                "assert 'faster_whisper' not in sys.modules"
            ),
        ],
        cwd=backend_root,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr


def test_transcription_files_are_utf8_srt_text_and_json(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(transcription, "TRANSCRIPT_DIR", tmp_path)
    result = transcription._RawTranscription(
        language="zh",
        language_probability=0.98,
        duration_seconds=2.5,
        segments=[
            TranscriptSegment(start=0.125, end=1.5, text="你好"),
            TranscriptSegment(start=1.5, end=2.5, text="TikTok"),
        ],
        device_used="cpu",
        compute_type="int8",
        fallback_reason=None,
    )
    files = transcription.write_transcript_files(
        "7654207540028394774",
        "creator_7654207540028394774_audio",
        result,
    )

    assert {item.kind for item in files} == {"transcript_text", "transcript_srt", "transcript_json"}
    srt = next(Path(item.path) for item in files if item.kind == "transcript_srt").read_text(encoding="utf-8")
    assert "00:00:00,125 --> 00:00:01,500" in srt
    payload = json.loads(next(Path(item.path) for item in files if item.kind == "transcript_json").read_text(encoding="utf-8"))
    assert payload["video_id"] == "7654207540028394774"
    assert payload["text"] == "你好 TikTok"


def test_silent_transcription_only_writes_nonempty_json(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(transcription, "TRANSCRIPT_DIR", tmp_path)
    result = transcription._RawTranscription(
        language="en",
        language_probability=0.5,
        duration_seconds=1.0,
        segments=[],
        device_used="cpu",
        compute_type="int8",
        fallback_reason=None,
    )
    files = transcription.write_transcript_files("7654207540028394774", "7654207540028394774", result)

    assert [item.kind for item in files] == ["transcript_json"]
    assert files[0].size_bytes > 0


@pytest.mark.anyio
async def test_online_only_transcription_removes_temporary_audio_and_writes_no_files(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audio = tmp_path / "temporary.m4a"
    audio.write_bytes(b"audio")

    async def fake_download(_request: SingleDownloadRequest) -> SingleDownloadResponse:
        return SingleDownloadResponse(
            video_id="7654207540028394774",
            status="completed",
            files=[
                DownloadedFile(
                    kind="audio_track",
                    file_name=audio.name,
                    path=str(audio),
                    size_bytes=audio.stat().st_size,
                )
            ],
        )

    raw = transcription._RawTranscription(
        language="en",
        language_probability=0.9,
        duration_seconds=1.0,
        segments=[TranscriptSegment(start=0, end=1, text="hello")],
        device_used="cpu",
        compute_type="int8",
        fallback_reason=None,
    )
    monkeypatch.setattr(transcription, "execute_single_download", fake_download)
    monkeypatch.setattr(transcription, "transcribe_audio", lambda *_args: raw)
    monkeypatch.setattr(
        transcription,
        "write_subtitle_file",
        lambda *_args: pytest.fail("online-only mode must not write transcript files"),
    )

    response = await transcription.execute_transcription(
        TranscriptionRequest(
            media=SingleDownloadRequest(
                video_id="7654207540028394774",
                media_url="https://v16.tiktokcdn.com/video.mp4",
                download_video=False,
                extract_audio=True,
            )
        )
    )

    assert response.text == "hello"
    assert response.audio_file is None
    assert response.transcript_files == []
    assert not audio.exists()


def test_explicit_subtitle_download_writes_only_srt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(transcription, "TRANSCRIPT_DIR", tmp_path)
    result = transcription._RawTranscription(
        language="en",
        language_probability=0.9,
        duration_seconds=1.5,
        segments=[TranscriptSegment(start=0.125, end=1.5, text="hello")],
        device_used="cpu",
        compute_type="int8",
        fallback_reason=None,
    )

    files = transcription.write_subtitle_file(
        "7654207540028394774",
        "7654207540028394774_audio",
        result,
    )

    assert [item.kind for item in files] == ["transcript_srt"]
    assert list(tmp_path.glob("*.srt"))
    assert not list(tmp_path.glob("*.txt"))
    assert not list(tmp_path.glob("*.json"))
