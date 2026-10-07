from __future__ import annotations

import argparse
import sys
from pathlib import Path

from faster_whisper.utils import download_model


BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from app.storage.paths import get_model_root  # noqa: E402


DEFAULT_OUTPUT = get_model_root() / "faster-whisper" / "base"
MODEL_ID = "Systran/faster-whisper-base"
MODEL_REVISION = "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"
REQUIRED_FILES = {"config.json", "model.bin", "tokenizer.json", "vocabulary.txt"}


def main() -> int:
    parser = argparse.ArgumentParser(description="Download the pinned official faster-whisper base model")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if REQUIRED_FILES.issubset({path.name for path in output.iterdir() if path.is_file()}):
        print(f"Whisper model is ready: {output}")
        return 0

    result = Path(
        download_model(
            MODEL_ID,
            output_dir=str(output),
            revision=MODEL_REVISION,
            use_auth_token=False,
        )
    ).resolve()
    missing = REQUIRED_FILES - {path.name for path in result.iterdir() if path.is_file()}
    if missing:
        raise RuntimeError(f"Whisper model download is incomplete: {', '.join(sorted(missing))}")
    print(f"Whisper model is ready: {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
