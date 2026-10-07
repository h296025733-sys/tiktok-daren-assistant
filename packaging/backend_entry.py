from __future__ import annotations

import multiprocessing
import json
import os
import platform
import sys
import tempfile
import time
import wave
from pathlib import Path


def _port() -> int:
    try:
        value = int(os.environ.get("TIKTOK_ASSISTANT_PORT", "8765"))
    except ValueError:
        return 8765
    return value if 1 <= value <= 65535 else 8765


def _self_test_ai_runtime() -> int:
    payload: dict[str, object] = {
        "ok": False,
        "architecture": platform.machine(),
        "python_bits": 64 if sys.maxsize > 2**32 else 32,
    }
    try:
        if os.environ.get("TIKTOK_ASSISTANT_DIAGNOSTIC_AI_POLICY_BLOCK") == "1":
            raise ImportError(
                "DLL load failed while importing _ext: "
                "应用程序控制策略已阻止此文件。"
            )
        import ctranslate2
        from faster_whisper import WhisperModel

        # Importing the Python modules alone is not sufficient: this call also
        # enters the native CTranslate2 runtime and verifies CPU dispatch.
        compute_types = sorted(ctranslate2.get_supported_compute_types("cpu"))
        if not compute_types:
            raise RuntimeError("CTranslate2 reported no supported CPU compute type")
        payload.update(
            {
                "ok": True,
                "ctranslate2": str(getattr(ctranslate2, "__version__", "unknown")),
                "faster_whisper": str(WhisperModel.__module__),
                "cpu_compute_types": compute_types,
            }
        )
        model_path_value = os.environ.get(
            "TIKTOK_ASSISTANT_SELF_TEST_WHISPER_MODEL", ""
        ).strip()
        if model_path_value:
            model_path = Path(model_path_value).resolve()
            if not (model_path / "model.bin").is_file():
                raise FileNotFoundError(f"Whisper model is incomplete: {model_path}")
            temporary_audio = Path(tempfile.gettempdir()) / (
                f"tda-whisper-self-test-{os.getpid()}.wav"
            )
            try:
                with wave.open(str(temporary_audio), "wb") as audio:
                    audio.setnchannels(1)
                    audio.setsampwidth(2)
                    audio.setframerate(16_000)
                    audio.writeframes(b"\0\0" * 16_000)
                model = WhisperModel(
                    str(model_path),
                    device="cpu",
                    compute_type="int8",
                    cpu_threads=max(1, min(4, os.cpu_count() or 2)),
                    num_workers=1,
                    local_files_only=True,
                )
                segments, info = model.transcribe(
                    str(temporary_audio),
                    beam_size=1,
                    vad_filter=False,
                    condition_on_previous_text=False,
                )
                list(segments)
                payload.update(
                    {
                        "whisper_model_loaded": True,
                        "whisper_test_duration": float(info.duration or 0.0),
                    }
                )
            finally:
                temporary_audio.unlink(missing_ok=True)
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as error:
        error_detail = str(error) or repr(error)
        normalized = error_detail.casefold()
        policy_blocked = any(
            marker in normalized
            for marker in (
                "application control policy",
                "windows defender application control",
                "应用程序控制策略已阻止",
                "应用控制策略已阻止",
            )
        )
        payload.update(
            {
                "error_type": type(error).__name__,
                "error": error_detail,
                "error_code": (
                    "APPLICATION_CONTROL_BLOCKED"
                    if policy_blocked
                    else "NATIVE_RUNTIME_UNAVAILABLE"
                ),
            }
        )
        print(json.dumps(payload, ensure_ascii=False))
        return 21


def main() -> None:
    # Used only by release verification to reproduce a slow first launch (for
    # example while endpoint security scans the freshly extracted executable).
    # It is deliberately bounded and is never set by the installed product.
    try:
        diagnostic_delay = float(
            os.environ.get("TIKTOK_ASSISTANT_DIAGNOSTIC_STARTUP_DELAY", "0")
        )
    except ValueError:
        diagnostic_delay = 0
    if 0 < diagnostic_delay <= 30:
        time.sleep(diagnostic_delay)

    import uvicorn

    from app.main import app

    # The service must remain loopback-only. The extension and the launcher
    # both rely on this fixed trust boundary.
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=_port(),
        access_log=False,
        log_level="info",
    )


if __name__ == "__main__":
    multiprocessing.freeze_support()
    if "--self-test-ai-runtime" in sys.argv[1:]:
        raise SystemExit(_self_test_ai_runtime())
    main()
