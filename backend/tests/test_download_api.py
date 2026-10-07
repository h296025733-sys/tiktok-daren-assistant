import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.download import BatchJobResponse, DownloadedFile, SingleDownloadResponse
from app.services.media_download import MediaDownloadError
from app.services import file_delivery
from app.services.file_delivery import FileDeliveryError, expose_file


def test_download_api_returns_real_file_metadata(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    staged = tmp_path / "sample.mp4"
    staged.write_bytes(b"x" * 1234)
    monkeypatch.setattr(file_delivery, "OUTPUT_ROOT", tmp_path)
    file_delivery.clear_file_deliveries_for_tests()

    async def fake_execute(request):
        assert request.video_id == "7654207540028394774"
        return SingleDownloadResponse(
            video_id=request.video_id,
            status="completed",
            files=[
                DownloadedFile(
                    kind="video",
                    file_name="sample.mp4",
                    path=str(staged),
                    size_bytes=1234,
                )
            ],
        )

    monkeypatch.setattr("app.api.downloads.execute_single_download", fake_execute)
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/downloads",
            json={
                "video_id": "7654207540028394774",
                "media_url": "https://v16.tiktokcdn.com/video.mp4",
            },
        )

    assert response.status_code == 200
    assert response.json()["files"][0]["size_bytes"] == 1234
    assert "path" not in response.json()["files"][0]


def test_download_api_reports_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_execute(_):
        raise MediaDownloadError("媒体服务器返回 HTTP 403")

    monkeypatch.setattr("app.api.downloads.execute_single_download", fake_execute)
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/downloads",
            json={
                "video_id": "7654207540028394774",
                "media_url": "https://v16.tiktokcdn.com/video.mp4",
            },
        )

    assert response.status_code == 502
    assert response.json() == {"detail": "媒体服务器返回 HTTP 403"}


def test_download_api_requires_background_source_when_selected() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/downloads",
            json={
                "video_id": "7654207540028394774",
                "media_url": "https://v16.tiktokcdn.com/video.mp4",
                "download_video": False,
                "download_background_music": True,
            },
        )
    assert response.status_code == 422


def test_batch_download_api_starts_job(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_start(request):
        assert len(request.items) == 2
        assert request.items[0].media_url is None
        return BatchJobResponse(
            job_id="12345678123456781234567812345678",
            status="queued",
            total=2,
            processed=0,
            succeeded=0,
            failed=0,
        )

    monkeypatch.setattr("app.api.downloads.start_batch_job", fake_start)
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/downloads/batches",
            json={
                "items": [
                    {"video_id": "7654207540028394774"},
                    {"video_id": "7654207540028394775"},
                ]
            },
        )

    assert response.status_code == 202
    assert response.json()["status"] == "queued"
    assert response.json()["total"] == 2


def test_batch_download_api_accepts_all_70_items_in_request_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    video_ids = [str(7654207540028394000 + index) for index in range(70)]

    def fake_start(request):
        assert [item.video_id for item in request.items] == video_ids
        return BatchJobResponse(
            job_id="12345678123456781234567812345678",
            status="queued",
            total=len(request.items),
            processed=0,
            succeeded=0,
            failed=0,
        )

    monkeypatch.setattr("app.api.downloads.start_batch_job", fake_start)
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/downloads/batches",
            json={"items": [{"video_id": video_id} for video_id in video_ids]},
        )

    assert response.status_code == 202
    assert response.json()["total"] == 70


def test_batch_download_api_rejects_more_than_100_items() -> None:
    video_ids = [str(7654207540028394000 + index) for index in range(101)]
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/downloads/batches",
            json={"items": [{"video_id": video_id} for video_id in video_ids]},
        )

    assert response.status_code == 422


def test_download_api_streams_controlled_file_by_one_time_token(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    staged = tmp_path / "downloads" / "single" / "sample.mp4"
    staged.parent.mkdir(parents=True)
    staged.write_bytes(b"real-video-bytes")
    monkeypatch.setattr(file_delivery, "OUTPUT_ROOT", tmp_path)
    file_delivery.clear_file_deliveries_for_tests()

    async def fake_execute(request):
        return SingleDownloadResponse(
            video_id=request.video_id,
            status="completed",
            files=[DownloadedFile(kind="video", file_name=staged.name, path=str(staged), size_bytes=16)],
        )

    monkeypatch.setattr("app.api.downloads.execute_single_download", fake_execute)
    with TestClient(app) as client:
        response = client.post("/api/v1/downloads", json={"video_id": "7654207540028394774"})
        body = response.json()
        assert "path" not in body["files"][0]
        download_url = body["files"][0]["download_url"]
        assert download_url.startswith("/api/v1/downloads/files/")
        downloaded = client.get(download_url)
        repeated = client.get(download_url)

    assert downloaded.status_code == 200
    assert downloaded.content == b"real-video-bytes"
    assert repeated.status_code == 404
    assert not staged.exists()


def test_file_delivery_rejects_file_outside_controlled_output(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output = tmp_path / "controlled"
    output.mkdir()
    outside = tmp_path / "secret.txt"
    outside.write_text("secret", encoding="utf-8")
    monkeypatch.setattr(file_delivery, "OUTPUT_ROOT", output)
    record = DownloadedFile(
        kind="transcript_text",
        file_name=outside.name,
        path=str(outside),
        size_bytes=outside.stat().st_size,
    )
    with pytest.raises(FileDeliveryError, match="允许的输出目录"):
        expose_file(record)


def test_batch_archive_streams_completed_zip_and_cleans_staging(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "single.mp4"
    archive = tmp_path / "batch.zip"
    source.write_bytes(b"video")
    archive.write_bytes(b"PK\x03\x04batch-archive")
    job_id = "12345678123456781234567812345678"

    def fake_status(requested_job_id: str) -> BatchJobResponse:
        assert requested_job_id == job_id
        return BatchJobResponse(
            job_id=job_id,
            status="completed",
            total=1,
            processed=1,
            succeeded=1,
            failed=0,
            files=[DownloadedFile(
                kind="video",
                file_name=source.name,
                path=str(source),
                size_bytes=source.stat().st_size,
            )],
            zip_file=DownloadedFile(
                kind="zip",
                file_name=archive.name,
                path=str(archive),
                size_bytes=archive.stat().st_size,
            ),
        )

    monkeypatch.setattr("app.api.downloads.DOWNLOAD_ROOT", tmp_path)
    monkeypatch.setattr("app.api.downloads.get_batch_job", fake_status)
    with TestClient(app) as client:
        response = client.get(f"/api/v1/downloads/batches/{job_id}/archive")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert response.content == b"PK\x03\x04batch-archive"
    assert not archive.exists()
    assert not source.exists()
