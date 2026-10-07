from __future__ import annotations

import asyncio
import zipfile
from datetime import datetime
from pathlib import Path
from uuid import UUID, uuid4

from app.models.download import (
    BatchDownloadRequest,
    BatchJobError,
    BatchJobResponse,
    DownloadedFile,
)
from app.services.media_download import DOWNLOAD_ROOT, MediaDownloadError, execute_single_download, unique_destination


BATCH_DIR = DOWNLOAD_ROOT / "批量"
MAX_PARALLEL_DOWNLOADS = 2
_jobs: dict[str, BatchJobResponse] = {}
_tasks: dict[str, asyncio.Task[None]] = {}


class BatchJobNotFoundError(LookupError):
    pass


def start_batch_job(request: BatchDownloadRequest) -> BatchJobResponse:
    job_id = uuid4().hex
    state = BatchJobResponse(
        job_id=job_id,
        status="queued",
        total=len(request.items),
        processed=0,
        succeeded=0,
        failed=0,
    )
    _jobs[job_id] = state
    task = asyncio.create_task(_run_batch_job(job_id, request), name=f"batch-download-{job_id}")
    _tasks[job_id] = task
    task.add_done_callback(lambda _: _tasks.pop(job_id, None))
    return _copy_state(state)


def get_batch_job(job_id: str) -> BatchJobResponse:
    _validate_job_id(job_id)
    state = _jobs.get(job_id)
    if state is None:
        raise BatchJobNotFoundError("批量任务不存在或服务已重启")
    return _copy_state(state)


def cancel_batch_job(job_id: str) -> BatchJobResponse:
    state = get_batch_job(job_id)
    live = _jobs[job_id]
    if live.status not in {"completed", "partial", "failed", "cancelled"}:
        live.cancel_requested = True
    return _copy_state(live)


async def _run_batch_job(job_id: str, request: BatchDownloadRequest) -> None:
    state = _jobs[job_id]
    state.status = "running"
    semaphore = asyncio.Semaphore(MAX_PARALLEL_DOWNLOADS)
    ordered_files: list[list[DownloadedFile] | None] = [None] * len(request.items)
    ordered_errors: list[BatchJobError | None] = [None] * len(request.items)

    async def run_item(index: int) -> None:
        async with semaphore:
            if state.cancel_requested:
                return
            item = request.items[index]
            try:
                result = await execute_single_download(item)
                ordered_files[index] = result.files
                state.succeeded += 1
            except MediaDownloadError as error:
                state.failed += 1
                ordered_errors[index] = BatchJobError(video_id=item.video_id, error=str(error))
            except Exception:
                state.failed += 1
                ordered_errors[index] = BatchJobError(video_id=item.video_id, error="下载任务发生未知错误")
            finally:
                state.processed += 1

    try:
        await asyncio.gather(*(run_item(index) for index in range(len(request.items))))
        # Concurrent downloads may finish out of order. Flatten only after all
        # workers settle so the response and ZIP retain the user's filtered order.
        state.files = [file for item_files in ordered_files if item_files for file in item_files]
        state.errors = [error for error in ordered_errors if error is not None]
        if state.cancel_requested:
            state.status = "cancelled"
            return
        if request.create_zip and state.files:
            BATCH_DIR.mkdir(parents=True, exist_ok=True)
            zip_name = f"批量下载_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{job_id[:8]}.zip"
            zip_path = unique_destination(BATCH_DIR, zip_name)
            await asyncio.to_thread(_write_zip, zip_path, state.files)
            state.zip_file = DownloadedFile(
                kind="zip",
                file_name=zip_path.name,
                path=str(zip_path.resolve()),
                size_bytes=zip_path.stat().st_size,
            )
        if state.succeeded == state.total:
            state.status = "completed"
        elif state.succeeded:
            state.status = "partial"
        else:
            state.status = "failed"
    except asyncio.CancelledError:
        state.cancel_requested = True
        state.status = "cancelled"
        raise
    except Exception:
        state.status = "partial" if state.succeeded else "failed"
        state.errors.append(BatchJobError(video_id="batch", error="批量打包失败"))


def _write_zip(destination: Path, files: list[DownloadedFile]) -> None:
    partial = destination.with_suffix(".partial.zip")
    partial.unlink(missing_ok=True)
    root = DOWNLOAD_ROOT.resolve()
    try:
        with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
            used_names: set[str] = set()
            for record in files:
                source = Path(record.path).resolve()
                if not source.is_file() or not source.is_relative_to(root):
                    continue
                archive_name = _unique_archive_name(source.name, used_names)
                archive.write(source, archive_name)
        if not partial.is_file() or partial.stat().st_size <= 0:
            raise MediaDownloadError("批量 ZIP 没有生成有效文件")
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)


def _unique_archive_name(name: str, used: set[str]) -> str:
    candidate = name
    counter = 2
    path = Path(name)
    while candidate.casefold() in used:
        candidate = f"{path.stem}_{counter}{path.suffix}"
        counter += 1
    used.add(candidate.casefold())
    return candidate


def _validate_job_id(job_id: str) -> None:
    try:
        parsed = UUID(hex=job_id)
    except (ValueError, AttributeError) as error:
        raise BatchJobNotFoundError("批量任务 ID 无效") from error
    if parsed.hex != job_id.lower():
        raise BatchJobNotFoundError("批量任务 ID 无效")


def _copy_state(state: BatchJobResponse) -> BatchJobResponse:
    # DownloadedFile.path is intentionally excluded from JSON responses but is
    # still required internally for ZIP creation and controlled delivery.
    return state.model_copy(deep=True)


def clear_batch_jobs_for_tests() -> None:
    for task in _tasks.values():
        task.cancel()
    _tasks.clear()
    _jobs.clear()
