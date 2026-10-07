import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask

from app.models.download import BatchDownloadRequest, BatchJobResponse, SingleDownloadRequest, SingleDownloadResponse
from app.services.batch_download import (
    BatchJobNotFoundError,
    cancel_batch_job,
    get_batch_job,
    start_batch_job,
)
from app.services.media_download import DOWNLOAD_ROOT, MediaDownloadError, execute_single_download
from app.services.file_delivery import (
    FileDeliveryError,
    claim_file,
    expose_batch_download,
    expose_single_download,
)


router = APIRouter(prefix="/api/v1/downloads", tags=["downloads"])


@router.post("", response_model=SingleDownloadResponse, status_code=status.HTTP_200_OK)
async def download_single(request: SingleDownloadRequest) -> SingleDownloadResponse:
    try:
        return expose_single_download(await execute_single_download(request))
    except MediaDownloadError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.post("/batches", response_model=BatchJobResponse, status_code=status.HTTP_202_ACCEPTED)
async def create_batch(request: BatchDownloadRequest) -> BatchJobResponse:
    return expose_batch_download(start_batch_job(request))


@router.get("/batches/{job_id}", response_model=BatchJobResponse)
async def batch_status(job_id: str) -> BatchJobResponse:
    try:
        return expose_batch_download(get_batch_job(job_id))
    except BatchJobNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get("/batches/{job_id}/archive")
async def batch_archive(job_id: str) -> StreamingResponse:
    """Start an attachment response immediately, then stream the ZIP when ready.

    Chrome can show its native Save As dialog as soon as the response headers arrive,
    while the existing background job continues to fill the archive.
    """
    try:
        get_batch_job(job_id)
    except BatchJobNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return StreamingResponse(
        _stream_batch_archive(job_id),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="TikTok_batch_{job_id[:8]}.zip"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/batches/{job_id}/cancel", response_model=BatchJobResponse)
async def cancel_batch(job_id: str) -> BatchJobResponse:
    try:
        return cancel_batch_job(job_id)
    except BatchJobNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get("/files/{token}", response_class=FileResponse)
async def get_staged_file(token: str) -> FileResponse:
    try:
        claimed = claim_file(token)
    except FileDeliveryError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return FileResponse(
        path=claimed.path,
        filename=claimed.file_name,
        media_type=claimed.media_type,
        headers={"Cache-Control": "no-store"},
        background=BackgroundTask(claimed.cleanup),
    )


async def _stream_batch_archive(job_id: str) -> AsyncIterator[bytes]:
    try:
        while True:
            job = get_batch_job(job_id)
            if job.status in {"queued", "running"}:
                await asyncio.sleep(0.35)
                continue
            if job.status not in {"completed", "partial"} or job.zip_file is None:
                raise RuntimeError("批量任务未生成可下载的 ZIP")

            root = DOWNLOAD_ROOT.resolve()
            archive = Path(job.zip_file.path).resolve(strict=True)
            if not archive.is_file() or not archive.is_relative_to(root):
                raise RuntimeError("批量 ZIP 不在允许的输出目录")
            cleanup_paths = {
                archive,
                *(
                    path
                    for item in job.files
                    if (path := Path(item.path).resolve()).is_relative_to(root)
                ),
            }
            try:
                with archive.open("rb") as source:
                    while chunk := await asyncio.to_thread(source.read, 1024 * 1024):
                        yield chunk
            finally:
                for path in cleanup_paths:
                    path.unlink(missing_ok=True)
            return
    except asyncio.CancelledError:
        try:
            cancel_batch_job(job_id)
        except BatchJobNotFoundError:
            pass
        raise
