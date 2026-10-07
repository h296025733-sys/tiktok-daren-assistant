from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import tempfile
import threading
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from uuid import uuid4

from app.models.model_asset import ModelInstallState, ModelPurpose, ModelStatus
from app.storage.paths import get_model_root, get_model_staging_root


WHISPER_MODEL_REVISION = "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"
DOWNLOAD_TIMEOUT_SECONDS = 60
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
MAX_ARGOS_EXPANDED_BYTES = 800 * 1024 * 1024
MAX_ARGOS_FILES = 10_000


class UnknownModelError(LookupError):
    pass


class ModelInstallError(RuntimeError):
    pass


@dataclass(frozen=True)
class DownloadAsset:
    file_name: str
    url: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class ModelSpec:
    id: str
    name: str
    purpose: ModelPurpose
    install_kind: str
    destination_parts: tuple[str, ...]
    assets: tuple[DownloadAsset, ...]
    archive_root: str | None = None
    from_code: str | None = None
    to_code: str | None = None

    @property
    def estimated_size_bytes(self) -> int:
        return sum(asset.size_bytes for asset in self.assets)


def _whisper_url(file_name: str) -> str:
    return (
        "https://huggingface.co/Systran/faster-whisper-base/resolve/"
        f"{WHISPER_MODEL_REVISION}/{file_name}?download=true"
    )


MODEL_SPECS: dict[str, ModelSpec] = {
    "whisper-base": ModelSpec(
        id="whisper-base",
        name="Whisper Base 语音识别模型",
        purpose="transcription",
        install_kind="files",
        destination_parts=("faster-whisper", "base"),
        assets=(
            DownloadAsset(
                "config.json",
                _whisper_url("config.json"),
                2_309,
                "56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a",
            ),
            DownloadAsset(
                "model.bin",
                _whisper_url("model.bin"),
                145_217_532,
                "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9",
            ),
            DownloadAsset(
                "tokenizer.json",
                _whisper_url("tokenizer.json"),
                2_203_239,
                "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab",
            ),
            DownloadAsset(
                "vocabulary.txt",
                _whisper_url("vocabulary.txt"),
                459_861,
                "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913",
            ),
        ),
    ),
    "argos-en-zh": ModelSpec(
        id="argos-en-zh",
        name="English → 中文离线翻译模型",
        purpose="offline_translation",
        install_kind="argos_archive",
        destination_parts=("argos", "packages", "translate-en_zh-1_9"),
        assets=(
            DownloadAsset(
                "translate-en_zh-1_9.argosmodel",
                "https://argos-net.com/v1/translate-en_zh-1_9.argosmodel",
                70_743_021,
                "433e7c4f034d87fbe2353161e05f18646d7999452f801a4e1f0378522b9850ab",
            ),
        ),
        archive_root="translate-en_zh-1_9",
        from_code="en",
        to_code="zh",
    ),
    "argos-ru-en": ModelSpec(
        id="argos-ru-en",
        name="Русский → English 离线翻译模型",
        purpose="offline_translation",
        install_kind="argos_archive",
        destination_parts=("argos", "packages", "translate-ru_en-1_9"),
        assets=(
            DownloadAsset(
                "translate-ru_en-1_9.argosmodel",
                "https://argos-net.com/v1/translate-ru_en-1_9.argosmodel",
                156_239_112,
                "e9ba8bf722d10a4a4c39f74289d5938fd47eac08dbe4ed0afd22d89445a5c3ac",
            ),
        ),
        archive_root="translate-ru_en-1_9",
        from_code="ru",
        to_code="en",
    ),
}


def model_destination(model_id: str) -> Path:
    spec = _get_spec(model_id)
    return get_model_root().joinpath(*spec.destination_parts)


def is_model_installed(model_id: str) -> bool:
    return _valid_install(_get_spec(model_id), model_destination(model_id))


class ModelManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._states: dict[str, ModelStatus] = {}
        self._threads: dict[str, threading.Thread] = {}

    def list_statuses(self) -> list[ModelStatus]:
        return [self.get_status(model_id) for model_id in MODEL_SPECS]

    def get_status(self, model_id: str) -> ModelStatus:
        spec = _get_spec(model_id)
        installed = _valid_install(spec, model_destination(model_id))
        with self._lock:
            current = self._states.get(model_id)
            active = current is not None and current.state in {"downloading", "installing"}
            if active:
                return current.model_copy()
            if installed:
                ready = self._make_status(spec, "ready", installed=True)
                self._states[model_id] = ready
                return ready.model_copy()
            if current is not None and current.state == "error":
                return current.model_copy(update={"installed": False})
            missing = self._make_status(spec, "missing", installed=False)
            self._states[model_id] = missing
            return missing.model_copy()

    def start_install(self, model_id: str) -> ModelStatus:
        spec = _get_spec(model_id)
        with self._lock:
            current = self.get_status(model_id)
            if current.installed or current.state in {"downloading", "installing"}:
                return current
            self._states[model_id] = self._make_status(
                spec,
                "downloading",
                installed=False,
                downloaded_bytes=0,
            )
            thread = threading.Thread(
                target=self._install_worker,
                args=(spec,),
                name=f"model-install-{model_id}",
                daemon=True,
            )
            self._threads[model_id] = thread
            thread.start()
            return self._states[model_id].model_copy()

    def install_blocking(self, model_id: str) -> ModelStatus:
        """Install a whitelisted model synchronously for setup/maintenance tools."""

        spec = _get_spec(model_id)
        with self._lock:
            if _valid_install(spec, model_destination(model_id)):
                ready = self._make_status(spec, "ready", installed=True)
                self._states[model_id] = ready
                return ready.model_copy()
            self._states[model_id] = self._make_status(spec, "downloading", installed=False)
        self._install_worker(spec)
        return self.get_status(model_id)

    def reset_for_tests(self) -> None:
        with self._lock:
            active = list(self._threads.values())
        for thread in active:
            thread.join(timeout=5)
        with self._lock:
            if any(thread.is_alive() for thread in active):
                raise RuntimeError("cannot reset model manager while an install is active")
            self._states.clear()
            self._threads.clear()

    def _install_worker(self, spec: ModelSpec) -> None:
        try:
            _install_model(spec, lambda value: self._set_progress(spec, value))
        except Exception as error:
            safe_error = _safe_install_error(error)
            with self._lock:
                self._states[spec.id] = self._make_status(
                    spec,
                    "error",
                    installed=False,
                    error=safe_error,
                )
        else:
            with self._lock:
                self._states[spec.id] = self._make_status(spec, "ready", installed=True)
        finally:
            with self._lock:
                self._threads.pop(spec.id, None)

    def _set_progress(self, spec: ModelSpec, downloaded_bytes: int) -> None:
        with self._lock:
            state: ModelInstallState = (
                "installing" if downloaded_bytes >= spec.estimated_size_bytes else "downloading"
            )
            self._states[spec.id] = self._make_status(
                spec,
                state,
                installed=False,
                downloaded_bytes=min(downloaded_bytes, spec.estimated_size_bytes),
            )

    @staticmethod
    def _make_status(
        spec: ModelSpec,
        state: ModelInstallState,
        *,
        installed: bool,
        downloaded_bytes: int | None = None,
        error: str | None = None,
    ) -> ModelStatus:
        if downloaded_bytes is None:
            downloaded_bytes = spec.estimated_size_bytes if installed else 0
        return ModelStatus(
            id=spec.id,
            name=spec.name,
            purpose=spec.purpose,
            state=state,
            installed=installed,
            estimated_size_bytes=spec.estimated_size_bytes,
            downloaded_bytes=downloaded_bytes,
            total_bytes=spec.estimated_size_bytes,
            error=error,
        )


MODEL_MANAGER = ModelManager()


def list_model_statuses() -> list[ModelStatus]:
    return MODEL_MANAGER.list_statuses()


def get_model_status(model_id: str) -> ModelStatus:
    return MODEL_MANAGER.get_status(model_id)


def start_model_install(model_id: str) -> ModelStatus:
    return MODEL_MANAGER.start_install(model_id)


def install_model_blocking(model_id: str) -> ModelStatus:
    return MODEL_MANAGER.install_blocking(model_id)


def reset_model_manager_for_tests() -> None:
    MODEL_MANAGER.reset_for_tests()


def _get_spec(model_id: str) -> ModelSpec:
    try:
        return MODEL_SPECS[model_id]
    except KeyError as error:
        raise UnknownModelError(f"未知模型：{model_id}") from error


def _install_model(spec: ModelSpec, progress: Callable[[int], None]) -> None:
    staging_parent = get_model_staging_root()
    staging_parent.mkdir(parents=True, exist_ok=True)
    staging_root = Path(tempfile.mkdtemp(prefix=f"{spec.id}-", dir=staging_parent))
    downloaded = 0

    def asset_progress(asset_bytes: int) -> None:
        progress(downloaded + asset_bytes)

    try:
        downloaded_assets: list[Path] = []
        for asset in spec.assets:
            destination = staging_root / asset.file_name
            _download_asset(asset, destination, asset_progress)
            downloaded_assets.append(destination)
            downloaded += asset.size_bytes
            progress(downloaded)

        progress(spec.estimated_size_bytes)
        if spec.install_kind == "files":
            source = staging_root / "install"
            source.mkdir()
            for asset, downloaded_path in zip(spec.assets, downloaded_assets):
                downloaded_path.replace(source / asset.file_name)
        elif spec.install_kind == "argos_archive":
            source = _extract_argos_archive(spec, downloaded_assets[0], staging_root)
        else:
            raise ModelInstallError("模型安装类型不受支持")

        if not _valid_install(spec, source):
            raise ModelInstallError("模型安装内容校验失败")
        _atomic_install_directory(source, model_destination(spec.id))
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)


def _download_asset(
    asset: DownloadAsset,
    destination: Path,
    progress: Callable[[int], None],
) -> None:
    partial = destination.with_name(f"{destination.name}.partial")
    partial.unlink(missing_ok=True)
    digest = hashlib.sha256()
    downloaded = 0
    request = urllib.request.Request(
        asset.url,
        headers={"User-Agent": "TikTok-Daren-Assistant/0.1.28"},
    )
    try:
        with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            with partial.open("wb") as output:
                while chunk := response.read(DOWNLOAD_CHUNK_BYTES):
                    downloaded += len(chunk)
                    if downloaded > asset.size_bytes:
                        raise ModelInstallError("模型文件超过预期大小")
                    digest.update(chunk)
                    output.write(chunk)
                    progress(downloaded)
        if downloaded != asset.size_bytes:
            raise ModelInstallError("模型文件大小校验失败")
        if digest.hexdigest().lower() != asset.sha256.lower():
            raise ModelInstallError("模型文件 SHA256 校验失败")
        os.replace(partial, destination)
    finally:
        partial.unlink(missing_ok=True)


def _extract_argos_archive(spec: ModelSpec, archive: Path, staging_root: Path) -> Path:
    if spec.archive_root is None:
        raise ModelInstallError("离线翻译模型缺少根目录定义")
    extraction_root = staging_root / "extracted"
    extraction_root.mkdir()
    try:
        with zipfile.ZipFile(archive) as bundle:
            bad_file = bundle.testzip()
            if bad_file:
                raise ModelInstallError("离线翻译模型压缩包 CRC 校验失败")
            members = bundle.infolist()
            if len(members) > MAX_ARGOS_FILES:
                raise ModelInstallError("离线翻译模型文件数量异常")
            if sum(member.file_size for member in members) > MAX_ARGOS_EXPANDED_BYTES:
                raise ModelInstallError("离线翻译模型解压后超过允许大小")
            roots: set[str] = set()
            for member in members:
                member_path = Path(member.filename)
                if member_path.is_absolute() or ".." in member_path.parts:
                    raise ModelInstallError("离线翻译模型包含不安全路径")
                if _zip_member_is_symlink(member):
                    raise ModelInstallError("离线翻译模型包含不安全链接")
                if member_path.parts:
                    roots.add(member_path.parts[0])
            if roots != {spec.archive_root}:
                raise ModelInstallError("离线翻译模型根目录不符合预期")
            bundle.extractall(extraction_root)
    except (OSError, zipfile.BadZipFile) as error:
        raise ModelInstallError("离线翻译模型压缩包无效") from error
    return extraction_root / spec.archive_root


def _zip_member_is_symlink(member: zipfile.ZipInfo) -> bool:
    mode = member.external_attr >> 16
    return stat.S_IFMT(mode) == stat.S_IFLNK


def _valid_install(spec: ModelSpec, path: Path) -> bool:
    if spec.install_kind == "files":
        return all(
            (path / asset.file_name).is_file()
            and (path / asset.file_name).stat().st_size == asset.size_bytes
            for asset in spec.assets
        )
    if spec.install_kind == "argos_archive":
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
    return False


def _atomic_install_directory(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    backup: Path | None = None
    if destination.exists():
        backup = destination.with_name(f"{destination.name}.backup-{uuid4().hex}")
        destination.replace(backup)
    try:
        source.replace(destination)
    except Exception:
        if backup is not None and backup.exists() and not destination.exists():
            backup.replace(destination)
        raise
    if backup is not None:
        shutil.rmtree(backup, ignore_errors=True)


def _safe_install_error(error: Exception) -> str:
    if isinstance(error, urllib.error.HTTPError):
        return f"模型下载失败（HTTP {error.code}）"
    if isinstance(error, urllib.error.URLError):
        return "无法连接模型下载服务"
    if isinstance(error, TimeoutError):
        return "模型下载超时"
    if isinstance(error, ModelInstallError):
        return str(error)
    return "模型安装失败"
