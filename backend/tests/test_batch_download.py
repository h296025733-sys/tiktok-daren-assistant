from __future__ import annotations

import asyncio
import zipfile
from pathlib import Path

import pytest

from app.models.download import (
    BatchDownloadRequest,
    DownloadedFile,
    SingleDownloadRequest,
    SingleDownloadResponse,
)
from app.services import batch_download


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(autouse=True)
def clean_jobs() -> None:
    batch_download.clear_batch_jobs_for_tests()
    yield
    batch_download.clear_batch_jobs_for_tests()


@pytest.mark.anyio
async def test_batch_job_downloads_files_and_creates_zip(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output_root = tmp_path / "downloads"
    monkeypatch.setattr(batch_download, "DOWNLOAD_ROOT", output_root)
    monkeypatch.setattr(batch_download, "BATCH_DIR", output_root / "批量")

    async def fake_execute(item: SingleDownloadRequest) -> SingleDownloadResponse:
        path = output_root / "单条" / f"{item.video_id}.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f"video:{item.video_id}".encode())
        return SingleDownloadResponse(
            video_id=item.video_id,
            status="completed",
            files=[
                DownloadedFile(
                    kind="video",
                    file_name=path.name,
                    path=str(path),
                    size_bytes=path.stat().st_size,
                )
            ],
        )

    monkeypatch.setattr(batch_download, "execute_single_download", fake_execute)
    request = BatchDownloadRequest(
        items=[
            SingleDownloadRequest(video_id="7654207540028394774"),
            SingleDownloadRequest(video_id="7654207540028394775"),
        ]
    )
    created = batch_download.start_batch_job(request)
    final = await wait_for_terminal(created.job_id)

    assert final.status == "completed"
    assert final.processed == final.succeeded == 2
    assert final.zip_file is not None
    with zipfile.ZipFile(final.zip_file.path) as archive:
        assert sorted(archive.namelist()) == [
            "7654207540028394774.mp4",
            "7654207540028394775.mp4",
        ]


@pytest.mark.anyio
async def test_batch_job_can_cancel_queued_items(monkeypatch: pytest.MonkeyPatch) -> None:
    release = asyncio.Event()

    async def slow_execute(item: SingleDownloadRequest) -> SingleDownloadResponse:
        await release.wait()
        return SingleDownloadResponse(
            video_id=item.video_id,
            status="completed",
            files=[DownloadedFile(kind="video", file_name="x.mp4", path="D:/x.mp4", size_bytes=1)],
        )

    monkeypatch.setattr(batch_download, "execute_single_download", slow_execute)
    request = BatchDownloadRequest(
        create_zip=False,
        items=[SingleDownloadRequest(video_id=str(7654207540028394774 + index)) for index in range(4)],
    )
    created = batch_download.start_batch_job(request)
    await asyncio.sleep(0)
    cancelled = batch_download.cancel_batch_job(created.job_id)
    release.set()
    final = await wait_for_terminal(created.job_id)

    assert cancelled.cancel_requested is True
    assert final.status == "cancelled"
    assert final.processed <= batch_download.MAX_PARALLEL_DOWNLOADS


@pytest.mark.anyio
async def test_batch_job_processes_all_70_items_and_preserves_request_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    video_ids = [str(7654207540028394000 + index) for index in range(70)]

    async def fake_execute(item: SingleDownloadRequest) -> SingleDownloadResponse:
        # Force adjacent workers to finish out of order. The public result must
        # still follow the user's filtered selection order.
        if int(item.video_id[-1]) % 2 == 0:
            await asyncio.sleep(0.001)
        return SingleDownloadResponse(
            video_id=item.video_id,
            status="completed",
            files=[
                DownloadedFile(
                    kind="video",
                    file_name=f"{item.video_id}.mp4",
                    path=f"D:/test/{item.video_id}.mp4",
                    size_bytes=1,
                )
            ],
        )

    monkeypatch.setattr(batch_download, "execute_single_download", fake_execute)
    request = BatchDownloadRequest(
        create_zip=False,
        items=[SingleDownloadRequest(video_id=video_id) for video_id in video_ids],
    )
    created = batch_download.start_batch_job(request)
    final = await wait_for_terminal(created.job_id)

    assert final.status == "completed"
    assert final.processed == final.succeeded == final.total == 70
    assert final.failed == 0
    assert [item.file_name for item in final.files] == [
        f"{video_id}.mp4" for video_id in video_ids
    ]


async def wait_for_terminal(job_id: str) -> batch_download.BatchJobResponse:
    for _ in range(100):
        state = batch_download.get_batch_job(job_id)
        if state.status in {"completed", "partial", "failed", "cancelled"}:
            return state
        await asyncio.sleep(0.01)
    raise AssertionError("batch job did not reach a terminal state")
