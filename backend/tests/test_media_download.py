from __future__ import annotations

import ipaddress
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

from app.models.download import SingleDownloadRequest
from app.services import media_download
from app.services.media_download import (
    MediaDownloadError,
    build_media_filename,
    download_url_to_path,
    extract_audio_track,
    has_audio_and_video_streams,
    has_video_stream,
    infer_tiktok_created_at,
    is_allowed_media_url,
    media_publish_date,
    sanitize_filename_component,
    validate_media_url,
)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def public_resolver(_: str, __: int) -> list[ipaddress.IPv4Address]:
    return [ipaddress.ip_address("1.1.1.1")]


@pytest.mark.anyio
async def test_media_url_rejects_non_tiktok_host_and_private_dns() -> None:
    with pytest.raises(MediaDownloadError, match="允许"):
        await validate_media_url("https://example.com/video.mp4", public_resolver)

    async def private_resolver(_: str, __: int) -> list[ipaddress.IPv4Address]:
        return [ipaddress.ip_address("127.0.0.1")]

    with pytest.raises(MediaDownloadError, match="内网"):
        await validate_media_url("https://v16.tiktokcdn.com/video.mp4", private_resolver)


@pytest.mark.anyio
async def test_direct_media_url_rejects_mixed_public_and_nonpublic_dns() -> None:
    async def mixed_resolver(_: str, __: int):
        return [ipaddress.ip_address("2001::1"), ipaddress.ip_address("23.212.62.74")]

    with pytest.raises(MediaDownloadError, match="本机|内网|保留"):
        await validate_media_url("https://v16m-default.akamaized.net/video.mp4", mixed_resolver)


@pytest.mark.anyio
async def test_proxy_mode_does_not_pre_resolve_remote_media_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    async def should_not_resolve(_: str, __: int):
        raise AssertionError("proxy mode must not use poisoned local DNS")

    monkeypatch.setattr("app.services.media_download.resolve_public_addresses", should_not_resolve)
    await validate_media_url(
        "https://v16.tiktokcdn.com/video.mp4",
        proxy_url="http://127.0.0.1:9567",
    )


@pytest.mark.anyio
async def test_proxy_mode_still_rejects_non_allowlisted_host() -> None:
    with pytest.raises(MediaDownloadError, match="允许"):
        await validate_media_url(
            "https://example.com/video.mp4",
            proxy_url="http://127.0.0.1:9567",
        )


@pytest.mark.anyio
async def test_proxy_mode_rejects_non_loopback_proxy() -> None:
    with pytest.raises(MediaDownloadError, match="代理"):
        await validate_media_url(
            "https://v16.tiktokcdn.com/video.mp4",
            proxy_url="http://192.0.2.10:8080",
        )


def test_ytdlp_url_validator_keeps_direct_dns_strict_and_proxy_dns_remote(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        media_download.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (2, 1, 6, "", ("23.212.62.74", 443)),
            (10, 1, 6, "", ("2001::1", 443, 0, 0)),
        ],
    )

    url = "https://v16.tiktokcdn.com/video.mp4"
    assert is_allowed_media_url(url) is False
    assert is_allowed_media_url(url, proxy_url="http://127.0.0.1:9567") is True


@pytest.mark.anyio
async def test_download_streams_valid_video_without_writing_empty_file(tmp_path: Path) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("authorization") is None
        assert request.headers.get("cookie") is None
        return httpx.Response(200, headers={"content-type": "video/mp4"}, content=b"valid-video")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
    destination = tmp_path / "video.mp4"
    try:
        await download_url_to_path(
            "https://v16.tiktokcdn.com/video.mp4?signature=secret",
            destination,
            media_kind="video",
            client=client,
            resolver=public_resolver,
        )
    finally:
        await client.aclose()

    assert destination.read_bytes() == b"valid-video"
    assert not list(tmp_path.glob("*.partial.*"))


@pytest.mark.anyio
async def test_download_validates_every_redirect_target(tmp_path: Path) -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://127.0.0.1/private.mp4"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
    try:
        with pytest.raises(MediaDownloadError, match="允许"):
            await download_url_to_path(
                "https://v16.tiktokcdn.com/video.mp4",
                tmp_path / "video.mp4",
                media_kind="video",
                client=client,
                resolver=public_resolver,
            )
    finally:
        await client.aclose()


@pytest.mark.anyio
async def test_download_rejects_wrong_mime_and_empty_body(tmp_path: Path) -> None:
    responses = iter(
        [
            httpx.Response(200, headers={"content-type": "text/html"}, content=b"not media"),
            httpx.Response(200, headers={"content-type": "video/mp4"}, content=b""),
        ]
    )

    async def handler(_: httpx.Request) -> httpx.Response:
        return next(responses)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
    try:
        with pytest.raises(MediaDownloadError, match="类型"):
            await download_url_to_path(
                "https://v16.tiktokcdn.com/a.mp4",
                tmp_path / "a.mp4",
                media_kind="video",
                client=client,
                resolver=public_resolver,
            )
        with pytest.raises(MediaDownloadError, match="空文件"):
            await download_url_to_path(
                "https://v16.tiktokcdn.com/b.mp4",
                tmp_path / "b.mp4",
                media_kind="video",
                client=client,
                resolver=public_resolver,
            )
    finally:
        await client.aclose()


@pytest.mark.anyio
async def test_captured_video_without_audio_falls_back_for_audio_operation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls: list[str] = []

    async def fake_direct(_: str, destination: Path, **__: object) -> None:
        calls.append("direct")
        destination.write_bytes(b"video-only")

    def fake_fallback(_: str, __: str | None, destination: Path, **options: object) -> None:
        calls.append("fallback")
        assert options["require_audio"] is True
        destination.write_bytes(b"video-and-audio")

    monkeypatch.setattr(media_download, "resolve_outbound_proxy", lambda: None)
    monkeypatch.setattr(media_download, "download_url_to_path", fake_direct)
    monkeypatch.setattr(media_download, "has_audio_and_video_streams", lambda _: False)
    monkeypatch.setattr(media_download, "download_tiktok_video", fake_fallback)
    destination = tmp_path / "audio-source.mp4"
    request = SingleDownloadRequest(
        video_id="7654207540028394774",
        media_url="https://v16.tiktokcdn.com/video-only.mp4",
        download_video=False,
        extract_audio=True,
    )

    await media_download.download_video_with_fallback(request, destination)

    assert calls == ["direct", "fallback"]
    assert destination.read_bytes() == b"video-and-audio"


@pytest.mark.anyio
async def test_invalid_captured_url_never_blocks_safe_canonical_fallback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    async def fake_direct(*_: object, **__: object) -> None:
        raise MediaDownloadError("captured URL is unusable", recoverable=False)

    def fake_fallback(_: str, __: str | None, destination: Path, **options: object) -> None:
        assert options["require_audio"] is False
        assert options["media_validator"] is media_download.has_video_stream
        destination.write_bytes(b"canonical-video")

    monkeypatch.setattr(media_download, "resolve_outbound_proxy", lambda: None)
    monkeypatch.setattr(media_download, "download_url_to_path", fake_direct)
    monkeypatch.setattr(media_download, "download_tiktok_video", fake_fallback)
    destination = tmp_path / "video.mp4"
    request = SingleDownloadRequest(
        video_id="7654207540028394774",
        media_url="https://example.com/not-allowed.mp4",
    )

    await media_download.download_video_with_fallback(request, destination)

    assert destination.read_bytes() == b"canonical-video"


@pytest.mark.anyio
async def test_transient_tiktok_failure_is_retried(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    attempts = 0

    def flaky_fallback(_: str, __: str | None, destination: Path, **___: object) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise media_download.TikTokResolveError("TikTok 页面解析失败，请确认视频仍公开可访问")
        destination.write_bytes(b"retry-success")

    async def no_delay(_: float) -> None:
        return None

    monkeypatch.setattr(media_download, "resolve_outbound_proxy", lambda: None)
    monkeypatch.setattr(media_download, "download_tiktok_video", flaky_fallback)
    monkeypatch.setattr(media_download.asyncio, "sleep", no_delay)
    destination = tmp_path / "video.mp4"
    request = SingleDownloadRequest(video_id="7654207540028394774")

    await media_download.download_video_with_fallback(request, destination)

    assert attempts == 2
    assert destination.read_bytes() == b"retry-success"


def test_windows_filename_uses_date_author_id_title_order_and_removes_illegal_characters() -> None:
    request = SingleDownloadRequest(
        video_id="7654207540028394774",
        media_url="https://v16.tiktokcdn.com/video.mp4",
        author_unique_id="创作者:@name",
        description='emoji 🎣 / <非法> : "标题" ? *',
        created_at=1_720_000_000,
    )
    file_name = build_media_filename(request, "video", ".mp4")

    assert file_name.startswith("20240703_创作者_@name_7654207540028394774_emoji 🎣")
    assert file_name.endswith(".mp4")
    assert not any(character in file_name for character in '<>:"/\\|?*')
    assert sanitize_filename_component("CON", 20) == "_CON"


def test_filename_derives_missing_publish_date_from_tiktok_video_id() -> None:
    request = SingleDownloadRequest(
        video_id="7482885001348336918",
        author_unique_id="herocat2309",
        description="Kittens try to rescue their mother",
    )

    assert infer_tiktok_created_at(
        request.video_id,
        now=datetime(2026, 7, 21, tzinfo=timezone.utc),
    ) == 1_742_244_931
    assert media_publish_date(
        request,
        now=datetime(2026, 7, 21, tzinfo=timezone.utc),
    ) == "20250317"
    assert build_media_filename(request, "video", ".mp4") == (
        "20250317_herocat2309_7482885001348336918_"
        "Kittens try to rescue their mother.mp4"
    )


def test_filename_uses_unknown_date_when_video_id_timestamp_is_unreasonable() -> None:
    request = SingleDownloadRequest(
        video_id="1234567890",
        author_unique_id="creator",
        description="title",
    )

    assert infer_tiktok_created_at(
        request.video_id,
        now=datetime(2026, 7, 21, tzinfo=timezone.utc),
    ) is None
    assert media_publish_date(
        request,
        now=datetime(2026, 7, 21, tzinfo=timezone.utc),
    ) == "00000000"


def test_audio_track_filename_has_no_redundant_suffix() -> None:
    request = SingleDownloadRequest(
        video_id="7482885001348336918",
        author_unique_id="herocat2309",
        description="Kittens try to rescue their mother",
        download_video=False,
        extract_audio=True,
    )

    file_name = build_media_filename(request, "audio_track", ".m4a")

    assert file_name == (
        "20250317_herocat2309_7482885001348336918_"
        "Kittens try to rescue their mother.m4a"
    )
    assert "音轨" not in file_name


@pytest.mark.anyio
async def test_video_action_returns_only_video(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    video_dir = tmp_path / "视频"
    audio_dir = tmp_path / "音频"
    temp_dir = tmp_path / ".temp"

    async def fake_download(_: SingleDownloadRequest, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"video")

    monkeypatch.setattr(media_download, "SINGLE_VIDEO_DIR", video_dir)
    monkeypatch.setattr(media_download, "AUDIO_DIR", audio_dir)
    monkeypatch.setattr(media_download, "TEMP_DIR", temp_dir)
    monkeypatch.setattr(media_download, "download_video_with_fallback", fake_download)

    result = await media_download.execute_single_download(
        SingleDownloadRequest(
            video_id="7482885001348336918",
            author_unique_id="herocat2309",
            description="A title",
            download_video=True,
            extract_audio=False,
        )
    )

    assert [item.kind for item in result.files] == ["video"]
    assert result.files[0].file_name == "20250317_herocat2309_7482885001348336918_A title.mp4"
    assert not list(audio_dir.glob("*"))
    assert not list(temp_dir.glob("*"))


@pytest.mark.anyio
async def test_audio_action_returns_one_audio_and_removes_temporary_video(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    video_dir = tmp_path / "视频"
    audio_dir = tmp_path / "音频"
    temp_dir = tmp_path / ".temp"
    source_paths: list[Path] = []

    async def fake_download(_: SingleDownloadRequest, destination: Path) -> None:
        source_paths.append(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"temporary-video")

    def fake_extract(source: Path, destination: Path) -> None:
        assert source.is_file()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"audio")

    monkeypatch.setattr(media_download, "SINGLE_VIDEO_DIR", video_dir)
    monkeypatch.setattr(media_download, "AUDIO_DIR", audio_dir)
    monkeypatch.setattr(media_download, "TEMP_DIR", temp_dir)
    monkeypatch.setattr(media_download, "download_video_with_fallback", fake_download)
    monkeypatch.setattr(media_download, "extract_audio_track", fake_extract)

    result = await media_download.execute_single_download(
        SingleDownloadRequest(
            video_id="7482885001348336918",
            author_unique_id="herocat2309",
            description="A title",
            download_video=False,
            extract_audio=True,
        )
    )

    assert [item.kind for item in result.files] == ["audio_track"]
    assert result.files[0].file_name == "20250317_herocat2309_7482885001348336918_A title.m4a"
    assert len(source_paths) == 1
    assert not source_paths[0].exists()
    assert not list(video_dir.glob("*"))
    assert not list(temp_dir.glob("*"))


def test_extract_audio_track_with_project_ffmpeg(tmp_path: Path) -> None:
    imageio_ffmpeg = pytest.importorskip("imageio_ffmpeg")
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    source = tmp_path / "source.mp4"
    audio = tmp_path / "track.m4a"
    generated = subprocess.run(
        [
            ffmpeg,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=160x90:d=0.5",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.5",
            "-shortest",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-y",
            str(source),
        ],
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert generated.returncode == 0, generated.stderr.decode(errors="replace")
    assert has_audio_and_video_streams(source) is True

    extract_audio_track(source, audio)

    assert audio.is_file()
    assert audio.stat().st_size > 100


def test_media_probe_rejects_video_without_audio(tmp_path: Path) -> None:
    imageio_ffmpeg = pytest.importorskip("imageio_ffmpeg")
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    source = tmp_path / "video-only.mp4"
    generated = subprocess.run(
        [
            ffmpeg,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=160x90:d=0.2",
            "-c:v",
            "libx264",
            "-an",
            "-y",
            str(source),
        ],
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert generated.returncode == 0, generated.stderr.decode(errors="replace")

    assert has_audio_and_video_streams(source) is False
    assert has_video_stream(source) is True
