from __future__ import annotations

import asyncio
import ipaddress
import os
import re
import socket
import subprocess
import unicodedata
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from uuid import uuid4

import httpx

from app.models.download import DownloadedFile, SingleDownloadRequest, SingleDownloadResponse
from app.services.outbound_proxy import normalize_outbound_proxy, resolve_outbound_proxy
from app.services.tiktok_resolver import TikTokResolveError, build_canonical_tiktok_url, download_tiktok_video
from app.storage.paths import get_output_root


DOWNLOAD_ROOT = get_output_root() / "downloads"
SINGLE_VIDEO_DIR = DOWNLOAD_ROOT / "单条"
AUDIO_DIR = DOWNLOAD_ROOT / "音频"
TEMP_DIR = DOWNLOAD_ROOT / ".temp"
MAX_MEDIA_BYTES = 500 * 1024 * 1024
MAX_REDIRECTS = 5
DOWNLOAD_TIMEOUT = httpx.Timeout(connect=12.0, read=30.0, write=15.0, pool=10.0)
TIKTOK_FALLBACK_ATTEMPTS = 3

_WINDOWS_INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WINDOWS_RESERVED = re.compile(
    r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$",
    re.IGNORECASE,
)
_ALLOWED_EXACT_HOSTS = {"tiktok.com", "tiktokv.com", "tiktokcdn.com", "byteoversea.com", "muscdn.com"}
_ALLOWED_SUFFIXES = (
    ".tiktok.com",
    ".tiktokv.com",
    ".tiktokcdn.com",
    ".tiktokcdn-us.com",
    ".byteoversea.com",
    ".ibyteimg.com",
    ".muscdn.com",
    ".akamaized.net",
)
_ALLOWED_VIDEO_MIME = {"video/mp4", "video/quicktime", "application/octet-stream"}
_ALLOWED_AUDIO_MIME = {
    "audio/mp4",
    "audio/mpeg",
    "audio/aac",
    "audio/x-m4a",
    "application/octet-stream",
}
_TIKTOK_EARLIEST_PUBLISH_AT = int(datetime(2016, 1, 1, tzinfo=timezone.utc).timestamp())
_TIKTOK_FUTURE_TOLERANCE = timedelta(days=1)


class MediaDownloadError(RuntimeError):
    def __init__(self, message: str, *, recoverable: bool = False) -> None:
        super().__init__(message)
        self.recoverable = recoverable


Resolver = Callable[[str, int], Awaitable[list[ipaddress.IPv4Address | ipaddress.IPv6Address]]]


async def execute_single_download(request: SingleDownloadRequest) -> SingleDownloadResponse:
    for directory in (SINGLE_VIDEO_DIR, AUDIO_DIR, TEMP_DIR):
        directory.mkdir(parents=True, exist_ok=True)

    files: list[DownloadedFile] = []
    errors: list[str] = []
    video_path: Path | None = None
    temporary_video = not request.download_video

    try:
        if request.download_video or request.extract_audio:
            if temporary_video:
                temp_name = f"{request.video_id}.{uuid4().hex}.source.mp4"
                video_path = TEMP_DIR / temp_name
            else:
                video_name = build_media_filename(request, "video", ".mp4")
                video_path = unique_destination(SINGLE_VIDEO_DIR, video_name)
            await download_video_with_fallback(request, video_path)
            if request.download_video:
                files.append(file_record("video", video_path))

        if request.extract_audio:
            if video_path is None:
                raise MediaDownloadError("没有可用于提取音轨的视频文件")
            audio_name = build_media_filename(request, "audio_track", ".m4a")
            audio_path = unique_destination(AUDIO_DIR, audio_name)
            try:
                await asyncio.to_thread(extract_audio_track, video_path, audio_path)
                files.append(file_record("audio_track", audio_path))
            except MediaDownloadError as error:
                errors.append(str(error))

        if request.download_background_music and request.background_music_url:
            music_name = build_media_filename(request, "background_music", ".m4a")
            music_path = unique_destination(AUDIO_DIR, music_name)
            music_source = TEMP_DIR / f"{request.video_id}.{uuid4().hex}.music-source"
            try:
                await download_url_to_path(
                    request.background_music_url,
                    music_source,
                    media_kind="audio",
                    request_headers={"Referer": media_referer(request)},
                )
                await asyncio.to_thread(extract_audio_track, music_source, music_path)
                files.append(file_record("background_music", music_path))
            except MediaDownloadError as error:
                errors.append(str(error))
            finally:
                music_source.unlink(missing_ok=True)
    finally:
        if temporary_video and video_path is not None:
            video_path.unlink(missing_ok=True)

    if not files:
        reason = "；".join(errors) if errors else "下载没有生成有效文件"
        raise MediaDownloadError(reason)
    return SingleDownloadResponse(
        video_id=request.video_id,
        status="partial" if errors else "completed",
        files=files,
        errors=errors,
    )


async def download_video_with_fallback(
    request: SingleDownloadRequest,
    destination: Path,
) -> None:
    """Use the captured TikTok stream first, then the pinned yt-dlp extractor."""

    proxy_url = resolve_outbound_proxy()

    if request.media_url:
        try:
            await download_url_to_path(
                request.media_url,
                destination,
                media_kind="video",
                request_headers={"Referer": media_referer(request)},
                proxy_url=proxy_url,
            )
            # Captured play URLs are useful but not authoritative: TikTok may
            # expose a HEVC video-only rendition even when the post has sound.
            # Prefer it only when the actual container contains both streams.
            if has_audio_and_video_streams(destination):
                return
            destination.unlink(missing_ok=True)
        except MediaDownloadError:
            # A stale, blocked, malformed or unsafe captured URL must not stop
            # the canonical yt-dlp fallback for the already validated video ID.
            destination.unlink(missing_ok=True)

    last_error: TikTokResolveError | None = None
    for attempt in range(TIKTOK_FALLBACK_ATTEMPTS):
        try:
            await asyncio.to_thread(
                download_tiktok_video,
                request.video_id,
                request.author_unique_id,
                destination,
                proxy_url=proxy_url,
                max_bytes=MAX_MEDIA_BYTES,
                url_validator=lambda raw_url: is_allowed_media_url(raw_url, proxy_url=proxy_url),
                media_validator=(has_audio_and_video_streams if request.extract_audio else has_video_stream),
                require_audio=request.extract_audio,
            )
            return
        except TikTokResolveError as error:
            last_error = error
            if attempt + 1 >= TIKTOK_FALLBACK_ATTEMPTS or not is_transient_tiktok_error(error):
                break
            await asyncio.sleep(0.75 * (2**attempt))
    assert last_error is not None
    raise MediaDownloadError(str(last_error)) from last_error


def is_transient_tiktok_error(error: TikTokResolveError) -> bool:
    message = str(error)
    return message.startswith("TikTok 页面解析失败") or message.startswith("TikTok 视频下载失败")


async def download_url_to_path(
    raw_url: str,
    destination: Path,
    *,
    media_kind: str,
    client: httpx.AsyncClient | None = None,
    resolver: Resolver | None = None,
    request_headers: dict[str, str] | None = None,
    proxy_url: str | None = None,
) -> None:
    own_client = client is None
    selected_proxy = proxy_url
    if own_client and selected_proxy is None:
        selected_proxy = resolve_outbound_proxy()
    if selected_proxy is not None:
        selected_proxy = normalize_outbound_proxy(selected_proxy)
        if selected_proxy is None:
            raise MediaDownloadError("出站代理配置无效")
    http_client = client or httpx.AsyncClient(
        timeout=DOWNLOAD_TIMEOUT,
        follow_redirects=False,
        proxy=selected_proxy,
        trust_env=False,
    )
    resolve = resolver or resolve_public_addresses
    partial = destination.with_name(f"{destination.stem}.partial{destination.suffix}")
    partial.unlink(missing_ok=True)
    current_url = raw_url
    try:
        for redirect_count in range(MAX_REDIRECTS + 1):
            await validate_media_url(current_url, resolve, proxy_url=selected_proxy)
            try:
                async with http_client.stream(
                    "GET",
                    current_url,
                    headers=media_request_headers(request_headers),
                ) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location:
                            raise MediaDownloadError("媒体重定向缺少目标地址")
                        if redirect_count >= MAX_REDIRECTS:
                            raise MediaDownloadError("媒体重定向次数过多")
                        current_url = urljoin(current_url, location)
                        continue
                    if response.status_code != 200:
                        raise MediaDownloadError(
                            f"媒体服务器返回 HTTP {response.status_code}",
                            recoverable=response.status_code in {401, 403, 404, 410, 429, 500, 502, 503, 504},
                        )
                    validate_content_type(response.headers.get("content-type"), media_kind)
                    content_length = parse_content_length(response.headers.get("content-length"))
                    if content_length is not None and content_length > MAX_MEDIA_BYTES:
                        raise MediaDownloadError("媒体文件超过 500MB 限制")
                    written = 0
                    partial.parent.mkdir(parents=True, exist_ok=True)
                    with partial.open("wb") as output:
                        async for chunk in response.aiter_bytes(1024 * 1024):
                            if not chunk:
                                continue
                            written += len(chunk)
                            if written > MAX_MEDIA_BYTES:
                                raise MediaDownloadError("媒体文件超过 500MB 限制")
                            output.write(chunk)
                    if written <= 0:
                        raise MediaDownloadError("媒体服务器返回了空文件")
                    partial.replace(destination)
                    return
            except httpx.TimeoutException as error:
                raise MediaDownloadError("媒体下载超时", recoverable=True) from error
            except httpx.HTTPError as error:
                raise MediaDownloadError("媒体网络请求失败", recoverable=True) from error
        raise MediaDownloadError("媒体重定向次数过多")
    finally:
        partial.unlink(missing_ok=True)
        if own_client:
            await http_client.aclose()


async def validate_media_url(
    raw_url: str,
    resolver: Resolver | None = None,
    *,
    proxy_url: str | None = None,
) -> None:
    try:
        parsed = urlsplit(raw_url)
        host = (parsed.hostname or "").rstrip(".").lower()
    except ValueError as error:
        raise MediaDownloadError("媒体地址格式无效") from error
    if parsed.scheme not in {"http", "https"}:
        raise MediaDownloadError("媒体地址仅允许 http/https")
    if not host or parsed.username or parsed.password:
        raise MediaDownloadError("媒体地址主机无效")
    if not is_allowed_media_host(host):
        raise MediaDownloadError("媒体地址不属于允许的 TikTok/CDN 主机")
    if proxy_url is not None:
        if normalize_outbound_proxy(proxy_url) is None:
            raise MediaDownloadError("出站代理配置无效")
        # The loopback proxy resolves the remote hostname. Local pre-resolution
        # would be inaccurate on networks that return poisoned/fake-IP records.
        return
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    addresses = await (resolver or resolve_public_addresses)(host, port)
    if not addresses:
        raise MediaDownloadError("媒体主机无法解析")
    if not all(is_public_address(address) for address in addresses):
        raise MediaDownloadError("媒体主机解析到本机、内网或保留地址")


def is_allowed_media_url(raw_url: str, *, proxy_url: str | None = None) -> bool:
    try:
        parsed = urlsplit(raw_url)
        host = (parsed.hostname or "").rstrip(".").lower()
    except ValueError:
        return False
    allowed = (
        parsed.scheme in {"http", "https"}
        and bool(host)
        and parsed.username is None
        and parsed.password is None
        and is_allowed_media_host(host)
    )
    if not allowed:
        return False
    if proxy_url is not None:
        return normalize_outbound_proxy(proxy_url) is not None
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        records = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        addresses = {ipaddress.ip_address(record[4][0]) for record in records}
    except (OSError, ValueError):
        return False
    return bool(addresses) and all(is_public_address(address) for address in addresses)


def media_request_headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    headers = {
        "Accept": "video/*,audio/*;q=0.9,application/octet-stream;q=0.5,*/*;q=0.1",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
        ),
    }
    allowed = {"accept", "accept-language", "referer", "sec-fetch-mode", "user-agent"}
    for key, value in (extra or {}).items():
        if key.lower() in allowed and isinstance(value, str) and 0 < len(value) <= 1_000:
            headers[key] = value
    return headers


def media_referer(request: SingleDownloadRequest) -> str:
    if request.page_url:
        try:
            parsed = urlsplit(request.page_url)
            host = (parsed.hostname or "").lower()
            if parsed.scheme == "https" and (host == "tiktok.com" or host.endswith(".tiktok.com")):
                return request.page_url
        except ValueError:
            pass
    return build_canonical_tiktok_url(request.video_id, request.author_unique_id)


async def resolve_public_addresses(
    host: str,
    port: int,
) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        records = await asyncio.to_thread(socket.getaddrinfo, host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise MediaDownloadError("媒体主机 DNS 解析失败") from error
    addresses: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for record in records:
        address = ipaddress.ip_address(record[4][0])
        if address not in addresses:
            addresses.append(address)
    return addresses


def is_allowed_media_host(host: str) -> bool:
    if host in _ALLOWED_EXACT_HOSTS or any(host.endswith(suffix) for suffix in _ALLOWED_SUFFIXES):
        return True
    return bool(re.fullmatch(r"(?:[a-z0-9-]+\.)*tiktokcdn(?:-[a-z0-9-]+)?\.com", host))


def is_public_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return not (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    )


def validate_content_type(value: str | None, media_kind: str) -> None:
    mime = (value or "").split(";", 1)[0].strip().lower()
    allowed = _ALLOWED_VIDEO_MIME if media_kind == "video" else _ALLOWED_AUDIO_MIME
    if mime not in allowed:
        raise MediaDownloadError(f"媒体类型不符合预期：{mime or '未知'}")


def parse_content_length(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


def build_media_filename(
    request: SingleDownloadRequest,
    kind: str,
    extension: str,
) -> str:
    author = (request.author_unique_id or request.author_nickname or "未知作者").lstrip("@")
    date = media_publish_date(request)
    if kind == "background_music":
        title = request.music_title or "背景音乐"
        suffix = "_背景音乐"
    else:
        title = request.description or "无标题"
        suffix = ""
    safe_author = sanitize_filename_component(author, 36)
    safe_title = sanitize_filename_component(title, 90)
    base = f"{date}_{safe_author}_{request.video_id}_{safe_title}{suffix}"
    return sanitize_filename_component(base, 170) + extension


def media_publish_date(
    request: SingleDownloadRequest,
    *,
    now: datetime | None = None,
) -> str:
    """Return the UTC publish date, falling back to TikTok's snowflake timestamp."""

    timestamp = request.created_at
    if timestamp is None:
        timestamp = infer_tiktok_created_at(request.video_id, now=now)
    if timestamp is None:
        return "00000000"
    try:
        return datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y%m%d")
    except (OverflowError, OSError, ValueError):
        return "00000000"


def infer_tiktok_created_at(
    video_id: str,
    *,
    now: datetime | None = None,
) -> int | None:
    """Decode the UTC seconds stored in the high 32 bits of a TikTok video ID."""

    try:
        timestamp = int(video_id) >> 32
    except (TypeError, ValueError):
        return None
    reference = now or datetime.now(timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    latest = int((reference.astimezone(timezone.utc) + _TIKTOK_FUTURE_TOLERANCE).timestamp())
    if not _TIKTOK_EARLIEST_PUBLISH_AT <= timestamp <= latest:
        return None
    return timestamp


def sanitize_filename_component(value: str, max_length: int) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    normalized = _WINDOWS_INVALID.sub("_", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip(" ._")
    if not normalized:
        normalized = "未命名"
    if _WINDOWS_RESERVED.match(normalized):
        normalized = f"_{normalized}"
    return normalized[:max_length].rstrip(" .") or "未命名"


def unique_destination(directory: Path, file_name: str) -> Path:
    destination = directory / file_name
    counter = 2
    while destination.exists():
        destination = directory / f"{Path(file_name).stem}_{counter}{Path(file_name).suffix}"
        counter += 1
    return destination


def extract_audio_track(video_path: Path, destination: Path) -> None:
    try:
        import imageio_ffmpeg

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError) as error:
        raise MediaDownloadError("项目内 FFmpeg 不可用") from error

    partial = destination.with_name(f"{destination.stem}.partial{destination.suffix}")
    partial.unlink(missing_ok=True)
    base_command = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(video_path), "-map", "0:a:0", "-vn"]
    copy_result = run_ffmpeg([*base_command, "-c:a", "copy", "-movflags", "+faststart", str(partial)])
    if copy_result.returncode != 0 or not partial.is_file() or partial.stat().st_size <= 0:
        partial.unlink(missing_ok=True)
        encode_result = run_ffmpeg([*base_command, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(partial)])
        if encode_result.returncode != 0 or not partial.is_file() or partial.stat().st_size <= 0:
            partial.unlink(missing_ok=True)
            raise MediaDownloadError("视频没有可提取的有效音轨")
    partial.replace(destination)


def has_audio_and_video_streams(media_path: Path) -> bool:
    """Verify the downloaded container has both streams required downstream."""

    return _has_required_media_streams(media_path, require_audio=True)


def has_video_stream(media_path: Path) -> bool:
    """Verify that a downloaded fallback is a real playable video container."""

    return _has_required_media_streams(media_path, require_audio=False)


def _has_required_media_streams(media_path: Path, *, require_audio: bool) -> bool:
    maps = ["-map", "0:v:0"]
    if require_audio:
        maps.extend(["-map", "0:a:0"])

    try:
        import imageio_ffmpeg

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        result = run_ffmpeg(
            [
                ffmpeg,
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(media_path),
                *maps,
                "-t",
                "0.1",
                "-c",
                "copy",
                "-f",
                "null",
                "-",
            ]
        )
    except (ImportError, RuntimeError, MediaDownloadError):
        return False
    return result.returncode == 0


def run_ffmpeg(command: list[str]) -> subprocess.CompletedProcess[str]:
    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        return subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            check=False,
            creationflags=creation_flags,
        )
    except subprocess.TimeoutExpired as error:
        raise MediaDownloadError("音轨提取超时") from error
    except OSError as error:
        raise MediaDownloadError("项目内 FFmpeg 启动失败") from error


def file_record(kind: str, path: Path) -> DownloadedFile:
    return DownloadedFile(
        kind=kind,
        file_name=path.name,
        path=str(path.resolve()),
        size_bytes=path.stat().st_size,
    )
