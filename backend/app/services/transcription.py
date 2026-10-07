from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.models.download import DownloadedFile
from app.models.transcription import TranscriptSegment, TranscriptionRequest, TranscriptionResponse
from app.services.media_download import DOWNLOAD_ROOT, MediaDownloadError, execute_single_download, unique_destination
from app.services.model_manager import is_model_installed, model_destination
from app.services.native_runtime import (
    NativeRuntimeUnavailableError,
    ensure_ctranslate2_runtime,
    reset_native_runtime_for_tests,
)


TRANSCRIPT_DIR = DOWNLOAD_ROOT.parent / "transcripts"
logger = logging.getLogger(__name__)
_model_lock = threading.Lock()
_inference_lock = threading.Lock()
_runtime_lock = threading.Lock()
_models: dict[str, Any] = {}
_ctranslate2_runtime: Any | None = None
_whisper_model_class: Any | None = None
_cuda_disabled_reason: str | None = None


class TranscriptionError(RuntimeError):
    pass


class TranscriptionRuntimeUnavailableError(TranscriptionError):
    def __init__(self, error: NativeRuntimeUnavailableError) -> None:
        super().__init__(str(error))
        self.code = error.code
        self.policy_blocked = error.policy_blocked


class TranscriptionModelRequiredError(TranscriptionError):
    def __init__(self) -> None:
        super().__init__("生成字幕需要先下载 Whisper Base 语音识别模型")
        self.model_ids = ["whisper-base"]


@dataclass(frozen=True)
class _RawTranscription:
    language: str
    language_probability: float
    duration_seconds: float
    segments: list[TranscriptSegment]
    device_used: str
    compute_type: str
    fallback_reason: str | None


async def execute_transcription(request: TranscriptionRequest) -> TranscriptionResponse:
    # Probe the native runtime before asking for its model. On managed Windows
    # PCs, WDAC may prohibit CTranslate2 entirely; downloading a 148 MB native
    # model there would be wasted work because the browser fallback is required.
    _load_transcription_runtime()
    if not _model_is_installed():
        raise TranscriptionModelRequiredError()
    media_request = request.media.model_copy(
        update={
            "download_video": False,
            "extract_audio": True,
            "download_background_music": False,
            "background_music_url": None,
        }
    )
    try:
        media_result = await execute_single_download(media_request)
    except MediaDownloadError as error:
        raise TranscriptionError(str(error)) from error
    audio_file = next((item for item in media_result.files if item.kind == "audio_track"), None)
    if audio_file is None:
        raise TranscriptionError("完整音轨提取失败，无法进行语音识别")

    audio_path = Path(audio_file.path)
    try:
        raw = await asyncio.to_thread(
            transcribe_audio,
            audio_path,
            request.language,
            request.beam_size,
            request.vad_filter,
        )
        transcript_files = (
            await asyncio.to_thread(
                write_subtitle_file,
                media_request.video_id,
                audio_path.stem,
                raw,
            )
            if request.save_transcript_files
            else []
        )
    finally:
        # 语音识别只需要临时音轨；需要音频时应使用独立的“提取音频”操作。
        audio_path.unlink(missing_ok=True)
    text = " ".join(segment.text.strip() for segment in raw.segments if segment.text.strip()).strip()
    return TranscriptionResponse(
        video_id=media_request.video_id,
        language=raw.language,
        language_probability=raw.language_probability,
        duration_seconds=raw.duration_seconds,
        device_used=raw.device_used,
        compute_type=raw.compute_type,
        fallback_reason=raw.fallback_reason,
        text=text,
        segments=raw.segments,
        audio_file=None,
        transcript_files=transcript_files,
    )


def transcribe_audio(
    audio_path: Path,
    language: str | None,
    beam_size: int,
    vad_filter: bool,
) -> _RawTranscription:
    if not audio_path.is_file() or audio_path.stat().st_size <= 0:
        raise TranscriptionError("待识别音轨不存在或为空")
    if not _model_is_installed():
        raise TranscriptionModelRequiredError()

    global _cuda_disabled_reason
    ctranslate2_runtime, _ = _load_transcription_runtime()
    cuda_available = (
        _cuda_disabled_reason is None
        and ctranslate2_runtime.get_cuda_device_count() > 0
    )
    if cuda_available:
        try:
            return _run_transcription(audio_path, language, beam_size, vad_filter, "cuda", "int8_float16")
        except (RuntimeError, OSError):
            _cuda_disabled_reason = "CUDA 运行库不可用，已自动切换 CPU"

    try:
        result = _run_transcription(audio_path, language, beam_size, vad_filter, "cpu", "int8")
    except (RuntimeError, OSError, ValueError) as error:
        raise TranscriptionError("本地语音识别失败") from error
    if _cuda_disabled_reason:
        return _RawTranscription(
            **{**result.__dict__, "fallback_reason": _cuda_disabled_reason},
        )
    return result


def _run_transcription(
    audio_path: Path,
    language: str | None,
    beam_size: int,
    vad_filter: bool,
    device: str,
    compute_type: str,
) -> _RawTranscription:
    model = _get_model(device, compute_type)
    with _inference_lock:
        segments_iter, info = model.transcribe(
            str(audio_path),
            language=language,
            beam_size=beam_size,
            vad_filter=vad_filter,
            condition_on_previous_text=False,
            word_timestamps=False,
        )
        segments = [
            TranscriptSegment(
                start=max(0.0, float(segment.start)),
                end=max(float(segment.start), float(segment.end)),
                text=str(segment.text).strip(),
                avg_logprob=_optional_float(segment.avg_logprob),
                no_speech_probability=_optional_float(segment.no_speech_prob),
            )
            for segment in segments_iter
            if str(segment.text).strip()
        ]
    return _RawTranscription(
        language=str(info.language or language or "unknown"),
        language_probability=max(0.0, min(1.0, float(info.language_probability or 0.0))),
        duration_seconds=max(0.0, float(info.duration or 0.0)),
        segments=segments,
        device_used="cuda:0" if device == "cuda" else "cpu",
        compute_type=compute_type,
        fallback_reason=None,
    )


def _load_transcription_runtime() -> tuple[Any, Any]:
    """Load optional native inference DLLs only when subtitles are requested.

    Importing these packages while the web service starts makes every feature
    depend on the colleague PC's native speech-runtime compatibility. Keeping
    them lazy lets downloads and Google translation work without loading the
    optional local AI engine.
    """

    global _ctranslate2_runtime, _whisper_model_class
    with _runtime_lock:
        if _ctranslate2_runtime is not None and _whisper_model_class is not None:
            return _ctranslate2_runtime, _whisper_model_class
        try:
            ctranslate2_runtime = ensure_ctranslate2_runtime()
            from faster_whisper import WhisperModel as whisper_model_class
        except NativeRuntimeUnavailableError as error:
            logger.warning("Optional local AI runtime is unavailable: %s", error)
            raise TranscriptionRuntimeUnavailableError(error) from error
        except (ImportError, OSError, RuntimeError) as error:
            logger.exception("Failed to load the optional local speech runtime")
            raise TranscriptionError(
                "本地语音识别组件无法加载；请改用浏览器兼容模式"
                f"（{type(error).__name__}: {error}）"
            ) from error
        _ctranslate2_runtime = ctranslate2_runtime
        _whisper_model_class = whisper_model_class
        return _ctranslate2_runtime, _whisper_model_class


def _get_model(device: str, compute_type: str) -> Any:
    key = f"{device}:{compute_type}"
    with _model_lock:
        model = _models.get(key)
        if model is None:
            _, whisper_model_class = _load_transcription_runtime()
            model = whisper_model_class(
                str(model_destination("whisper-base")),
                device=device,
                device_index=0,
                compute_type=compute_type,
                cpu_threads=max(1, min(8, os.cpu_count() or 4)),
                num_workers=1,
                local_files_only=True,
            )
            _models[key] = model
        return model


def write_transcript_files(
    video_id: str,
    source_stem: str,
    result: _RawTranscription,
) -> list[DownloadedFile]:
    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    safe_stem = source_stem if video_id in source_stem else f"{video_id}_{source_stem}"
    text_path = unique_destination(TRANSCRIPT_DIR, f"{safe_stem}.txt")
    srt_path = unique_destination(TRANSCRIPT_DIR, f"{safe_stem}.srt")
    json_path = unique_destination(TRANSCRIPT_DIR, f"{safe_stem}.json")
    full_text = "\n".join(segment.text for segment in result.segments).strip()
    srt_text = _build_srt_text(result)
    payload: dict[str, Any] = {
        "video_id": video_id,
        "language": result.language,
        "language_probability": result.language_probability,
        "duration_seconds": result.duration_seconds,
        "device_used": result.device_used,
        "compute_type": result.compute_type,
        "fallback_reason": result.fallback_reason,
        "text": full_text.replace("\n", " ").strip(),
        "segments": [segment.model_dump() for segment in result.segments],
    }
    records: list[DownloadedFile] = []
    if full_text:
        _atomic_write_text(text_path, full_text + "\n")
        _atomic_write_text(srt_path, srt_text + "\n")
        records.extend([_file("transcript_text", text_path), _file("transcript_srt", srt_path)])
    _atomic_write_text(json_path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    records.append(_file("transcript_json", json_path))
    return records


def write_subtitle_file(
    video_id: str,
    source_stem: str,
    result: _RawTranscription,
) -> list[DownloadedFile]:
    """Persist only the user-facing SRT file after an explicit opt-in."""

    srt_text = _build_srt_text(result)
    if not srt_text:
        return []
    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    safe_stem = source_stem if video_id in source_stem else f"{video_id}_{source_stem}"
    srt_path = unique_destination(TRANSCRIPT_DIR, f"{safe_stem}.srt")
    _atomic_write_text(srt_path, srt_text + "\n")
    return [_file("transcript_srt", srt_path)]


def _build_srt_text(result: _RawTranscription) -> str:
    return "\n\n".join(
        f"{index}\n{_srt_time(segment.start)} --> {_srt_time(segment.end)}\n{segment.text}"
        for index, segment in enumerate(result.segments, start=1)
    )


def _atomic_write_text(destination: Path, content: str) -> None:
    partial = destination.with_name(f"{destination.name}.partial")
    partial.unlink(missing_ok=True)
    try:
        partial.write_text(content, encoding="utf-8")
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)


def _file(kind: str, path: Path) -> DownloadedFile:
    return DownloadedFile(kind=kind, file_name=path.name, path=str(path.resolve()), size_bytes=path.stat().st_size)


def _srt_time(value: float) -> str:
    milliseconds = max(0, round(value * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


def _optional_float(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) else None


def _model_is_installed() -> bool:
    return is_model_installed("whisper-base")


def clear_transcription_cache_for_tests() -> None:
    global _ctranslate2_runtime, _whisper_model_class, _cuda_disabled_reason
    with _model_lock:
        _models.clear()
    with _runtime_lock:
        _ctranslate2_runtime = None
        _whisper_model_class = None
    reset_native_runtime_for_tests()
    _cuda_disabled_reason = None
