from __future__ import annotations

import mimetypes
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from app.models.download import BatchJobResponse, DownloadedFile, SingleDownloadResponse
from app.services.media_download import DOWNLOAD_ROOT


OUTPUT_ROOT = DOWNLOAD_ROOT.parent
DELIVERY_URL_PREFIX = "/api/v1/downloads/files/"
DELIVERY_TTL_SECONDS = 60 * 60


class FileDeliveryError(LookupError):
    pass


@dataclass(frozen=True)
class ClaimedFile:
    path: Path
    file_name: str
    media_type: str
    cleanup_paths: tuple[Path, ...]

    def cleanup(self) -> None:
        for path in self.cleanup_paths:
            path.unlink(missing_ok=True)


@dataclass(frozen=True)
class _Delivery:
    path: Path
    file_name: str
    media_type: str
    cleanup_paths: tuple[Path, ...]
    expires_at: float


_lock = threading.Lock()
_deliveries: dict[str, _Delivery] = {}
_tokens_by_path: dict[Path, str] = {}


def expose_single_download(result: SingleDownloadResponse) -> SingleDownloadResponse:
    return result.model_copy(update={"files": expose_files(result.files)}, deep=True)


def expose_batch_download(result: BatchJobResponse) -> BatchJobResponse:
    exposed = result.model_copy(deep=True)
    if result.status in {"queued", "running"}:
        return exposed
    if result.zip_file is not None:
        cleanup = [Path(item.path) for item in result.files]
        cleanup.append(Path(result.zip_file.path))
        exposed.zip_file = expose_file(result.zip_file, cleanup_paths=cleanup)
        # A completed ZIP is the single user-facing batch artifact. Individual
        # staging files deliberately remain without public URLs.
        return exposed
    exposed.files = expose_files(result.files)
    return exposed


def expose_files(files: list[DownloadedFile]) -> list[DownloadedFile]:
    return [expose_file(item) for item in files]


def expose_file(
    item: DownloadedFile,
    *,
    cleanup_paths: list[Path] | None = None,
) -> DownloadedFile:
    path = _controlled_file(Path(item.path))
    cleanups = tuple(
        dict.fromkeys(_controlled_file(candidate) for candidate in (cleanup_paths or [path]))
    )
    now = time.monotonic()
    with _lock:
        _prune_expired_locked(now)
        token = _tokens_by_path.get(path)
        if token is None or token not in _deliveries:
            token = secrets.token_urlsafe(32)
            _tokens_by_path[path] = token
        _deliveries[token] = _Delivery(
            path=path,
            file_name=path.name,
            media_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            cleanup_paths=cleanups,
            expires_at=now + DELIVERY_TTL_SECONDS,
        )
        _schedule_expiry(token, DELIVERY_TTL_SECONDS)
    return item.model_copy(
        update={"file_name": path.name, "download_url": f"{DELIVERY_URL_PREFIX}{token}"},
        deep=True,
    )


def claim_file(token: str) -> ClaimedFile:
    if not token or len(token) > 128 or not all(char.isalnum() or char in "-_" for char in token):
        raise FileDeliveryError("下载链接无效或已经使用")
    now = time.monotonic()
    with _lock:
        _prune_expired_locked(now)
        delivery = _deliveries.pop(token, None)
        if delivery is not None:
            _tokens_by_path.pop(delivery.path, None)
    if delivery is None:
        raise FileDeliveryError("下载链接无效、已经使用或已过期")
    try:
        path = _controlled_file(delivery.path)
    except FileDeliveryError:
        delivery.cleanup_paths[0].unlink(missing_ok=True)
        raise
    return ClaimedFile(
        path=path,
        file_name=delivery.file_name,
        media_type=delivery.media_type,
        cleanup_paths=delivery.cleanup_paths,
    )


def _controlled_file(candidate: Path) -> Path:
    root = OUTPUT_ROOT.resolve()
    try:
        path = candidate.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise FileDeliveryError("暂存文件不存在或已经清理") from error
    if not path.is_file() or not path.is_relative_to(root):
        raise FileDeliveryError("暂存文件不在允许的输出目录")
    return path


def _prune_expired_locked(now: float) -> None:
    expired = [token for token, item in _deliveries.items() if item.expires_at <= now]
    for token in expired:
        delivery = _deliveries.pop(token)
        _tokens_by_path.pop(delivery.path, None)
        for path in delivery.cleanup_paths:
            path.unlink(missing_ok=True)


def _schedule_expiry(token: str, delay: float) -> None:
    timer = threading.Timer(delay, _expire_token, args=(token,))
    timer.daemon = True
    timer.start()


def _expire_token(token: str) -> None:
    cleanup_paths: tuple[Path, ...] = ()
    remaining = 0.0
    with _lock:
        delivery = _deliveries.get(token)
        if delivery is None:
            return
        remaining = delivery.expires_at - time.monotonic()
        if remaining <= 0:
            _deliveries.pop(token, None)
            _tokens_by_path.pop(delivery.path, None)
            cleanup_paths = delivery.cleanup_paths
    if remaining > 0:
        _schedule_expiry(token, remaining)
        return
    for path in cleanup_paths:
        path.unlink(missing_ok=True)


def clear_file_deliveries_for_tests() -> None:
    with _lock:
        _deliveries.clear()
        _tokens_by_path.clear()
