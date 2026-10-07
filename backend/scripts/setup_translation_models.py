from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from app.storage.paths import get_model_root  # noqa: E402


MODEL_ROOT = get_model_root() / "argos"
DOWNLOAD_DIR = MODEL_ROOT / "downloads"
PACKAGE_DIR = MODEL_ROOT / "packages"
MAX_ARCHIVE_BYTES = 300 * 1024 * 1024
MAX_EXPANDED_BYTES = 800 * 1024 * 1024


@dataclass(frozen=True)
class ModelSpec:
    key: str
    directory: str
    url: str
    from_code: str
    to_code: str


MODELS = {
    "en_zh": ModelSpec("en_zh", "translate-en_zh-1_9", "https://argos-net.com/v1/translate-en_zh-1_9.argosmodel", "en", "zh"),
    "ru_en": ModelSpec("ru_en", "translate-ru_en-1_9", "https://argos-net.com/v1/translate-ru_en-1_9.argosmodel", "ru", "en"),
    "ja_en": ModelSpec("ja_en", "translate-ja_en-1_1", "https://argos-net.com/v1/translate-ja_en-1_1.argosmodel", "ja", "en"),
    "ko_en": ModelSpec("ko_en", "translate-ko_en-1_1", "https://argos-net.com/v1/translate-ko_en-1_1.argosmodel", "ko", "en"),
}


def install(spec: ModelSpec) -> None:
    target = PACKAGE_DIR / spec.directory
    archive = DOWNLOAD_DIR / f"{spec.directory}.argosmodel"
    if _valid_install(target, spec):
        archive.unlink(missing_ok=True)
        print(f"[ok] {spec.key} 已安装：{target}")
        return
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    PACKAGE_DIR.mkdir(parents=True, exist_ok=True)
    if not archive.is_file() or archive.stat().st_size == 0:
        print(f"[download] {spec.url}")
        _download(spec.url, archive)
    print(f"[verify] {archive.name}")
    root_name = _verify_archive(archive, spec)
    with tempfile.TemporaryDirectory(prefix="argos-model-", dir=PACKAGE_DIR) as temp_name:
        temp_root = Path(temp_name)
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(temp_root)
        extracted = temp_root / root_name
        if not _valid_install(extracted, spec):
            raise RuntimeError(f"模型校验失败：{spec.key}")
        if target.exists():
            shutil.rmtree(target)
        shutil.move(str(extracted), str(target))
    archive.unlink(missing_ok=True)
    print(f"[ok] {spec.key} 安装完成：{target}")


def _download(url: str, destination: Path) -> None:
    partial = destination.with_suffix(destination.suffix + ".partial")
    request = urllib.request.Request(url, headers={"User-Agent": "TikTok-Daren-Assistant/0.1.4"})
    downloaded = 0
    with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            downloaded += len(chunk)
            if downloaded > MAX_ARCHIVE_BYTES:
                raise RuntimeError("模型包超过允许大小")
            output.write(chunk)
            print(f"\r  {downloaded / 1024 / 1024:.1f} MB", end="", flush=True)
    print()
    partial.replace(destination)


def _verify_archive(archive: Path, spec: ModelSpec) -> str:
    with zipfile.ZipFile(archive) as bundle:
        bad_file = bundle.testzip()
        if bad_file:
            raise RuntimeError(f"模型压缩包 CRC 校验失败：{bad_file}")
        files = bundle.infolist()
        if sum(item.file_size for item in files) > MAX_EXPANDED_BYTES:
            raise RuntimeError("模型解压后超过允许大小")
        roots: set[str] = set()
        for item in files:
            path = Path(item.filename)
            if path.is_absolute() or ".." in path.parts:
                raise RuntimeError("模型压缩包包含不安全路径")
            if path.parts:
                roots.add(path.parts[0])
        if roots != {spec.directory}:
            raise RuntimeError(f"模型根目录不符合预期：{sorted(roots)}")
    return spec.directory


def _valid_install(path: Path, spec: ModelSpec) -> bool:
    try:
        metadata = json.loads((path / "metadata.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return (
        metadata.get("from_code") == spec.from_code
        and metadata.get("to_code") == spec.to_code
        and (path / "model" / "model.bin").is_file()
        and (path / "model" / "config.json").is_file()
        and (path / "sentencepiece.model").is_file()
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="安装项目内 Argos 离线翻译模型")
    parser.add_argument("models", nargs="*", choices=sorted(MODELS))
    args = parser.parse_args()
    for key in args.models or ["en_zh", "ru_en"]:
        install(MODELS[key])
    return 0


if __name__ == "__main__":
    sys.exit(main())
