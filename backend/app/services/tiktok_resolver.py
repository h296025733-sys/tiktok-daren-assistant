from __future__ import annotations

import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit


# yt-dlp supports third-party extractor plugins. This service deliberately uses
# only the extractor bundled with the pinned yt-dlp package.
os.environ["YTDLP_NO_PLUGINS"] = "1"

from yt_dlp import YoutubeDL
from yt_dlp.networking import Request
from yt_dlp.networking.exceptions import RequestError
from yt_dlp.utils import DownloadError

from app.services.outbound_proxy import normalize_outbound_proxy


_VIDEO_ID = re.compile(r"^\d{10,25}$")
_ALLOWED_VIDEO_MIME = {"video/mp4", "video/quicktime", "application/octet-stream"}
_CHUNK_BYTES = 1024 * 1024


class TikTokResolveError(RuntimeError):
    pass


@dataclass(frozen=True)
class ResolvedTikTokVideo:
    url: str
    headers: dict[str, str]


class _SilentLogger:
    def debug(self, _: str) -> None:
        pass

    def info(self, _: str) -> None:
        pass

    def warning(self, _: str) -> None:
        pass

    def error(self, _: str) -> None:
        pass


def build_canonical_tiktok_url(video_id: str, author_unique_id: str | None = None) -> str:
    if not _VIDEO_ID.fullmatch(video_id):
        raise TikTokResolveError("TikTok 视频 ID 无效")
    author = (author_unique_id or "_").strip().lstrip("@") or "_"
    return f"https://www.tiktok.com/@{quote(author, safe='._-')}/video/{video_id}"


def resolve_tiktok_video_url(
    video_id: str,
    author_unique_id: str | None = None,
    *,
    proxy_url: str | None = None,
) -> str:
    return resolve_tiktok_video(video_id, author_unique_id, proxy_url=proxy_url).url


def resolve_tiktok_video(
    video_id: str,
    author_unique_id: str | None = None,
    *,
    proxy_url: str | None = None,
) -> ResolvedTikTokVideo:
    """Resolve an ephemeral non-watermarked playback URL.

    This compatibility helper intentionally does not persist cookies or URLs.
    Production downloads use :func:`download_tiktok_video`, which keeps the
    extractor and media request in one YoutubeDL session.
    """

    canonical_url = build_canonical_tiktok_url(video_id, author_unique_id)
    options = _youtube_dl_options(proxy_url)
    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(canonical_url, download=False)
    except (DownloadError, RequestError, OSError, ValueError) as error:
        raise TikTokResolveError("TikTok 页面解析失败，请确认视频仍公开可访问") from error

    validated = _validated_info(info, video_id)
    candidates = _video_candidates(validated, require_audio=True)
    if not candidates:
        raise TikTokResolveError("TikTok 页面没有返回可下载的无水印视频流")
    best = candidates[0]
    return ResolvedTikTokVideo(
        url=str(best["url"]),
        headers=_candidate_headers(validated, best),
    )


def download_tiktok_video(
    video_id: str,
    author_unique_id: str | None,
    destination: Path,
    *,
    proxy_url: str | None,
    max_bytes: int,
    url_validator: Callable[[str], bool],
    media_validator: Callable[[Path], bool],
    require_audio: bool = True,
) -> None:
    """Extract and stream a TikTok video in one in-memory yt-dlp session.

    TikTok sets short-lived cookies while extracting the page. Reusing the same
    YoutubeDL instance for ``urlopen`` preserves those cookies and avoids the 403
    produced when a signed URL is handed to a fresh HTTP client.
    """

    if max_bytes <= 0:
        raise TikTokResolveError("媒体文件大小限制无效")
    canonical_url = build_canonical_tiktok_url(video_id, author_unique_id)
    options = _youtube_dl_options(proxy_url)
    partial = destination.with_name(f"{destination.stem}.partial{destination.suffix}")
    partial.unlink(missing_ok=True)

    try:
        with YoutubeDL(options) as ydl:
            try:
                info = ydl.extract_info(canonical_url, download=False)
            except (DownloadError, RequestError, OSError, ValueError) as error:
                raise TikTokResolveError("TikTok 页面解析失败，请确认视频仍公开可访问") from error

            validated = _validated_info(info, video_id)
            candidates = _video_candidates(validated, require_audio=require_audio)
            if not candidates:
                raise TikTokResolveError("TikTok 页面没有返回可下载的无水印视频流")

            destination.parent.mkdir(parents=True, exist_ok=True)
            for candidate in candidates:
                media_url = str(candidate["url"])
                if not _url_is_allowed(media_url, url_validator):
                    continue
                partial.unlink(missing_ok=True)
                try:
                    response = ydl.urlopen(
                        Request(media_url, headers=_candidate_headers(validated, candidate))
                    )
                    with response:
                        final_url = str(response.url or "")
                        if not _url_is_allowed(final_url, url_validator):
                            raise TikTokResolveError("TikTok 媒体重定向到了不允许的主机")
                        if response.status not in {200, 206}:
                            continue
                        if not _is_video_content_type(response.headers.get("content-type")):
                            continue
                        content_length = _parse_content_length(response.headers.get("content-length"))
                        if content_length is not None and content_length > max_bytes:
                            raise TikTokResolveError("媒体文件超过 500MB 限制")

                        written = 0
                        with partial.open("wb") as output:
                            while True:
                                chunk = response.read(_CHUNK_BYTES)
                                if not chunk:
                                    break
                                written += len(chunk)
                                if written > max_bytes:
                                    raise TikTokResolveError("媒体文件超过 500MB 限制")
                                output.write(chunk)
                        if written <= 0:
                            partial.unlink(missing_ok=True)
                            continue
                        if not _media_is_valid(partial, media_validator):
                            partial.unlink(missing_ok=True)
                            continue
                        partial.replace(destination)
                        return
                except TikTokResolveError:
                    raise
                except (DownloadError, RequestError, OSError, ValueError):
                    partial.unlink(missing_ok=True)
                    continue
    finally:
        partial.unlink(missing_ok=True)

    raise TikTokResolveError("TikTok 视频下载失败，请稍后重试")


def _youtube_dl_options(proxy_url: str | None) -> dict[str, Any]:
    normalized_proxy = normalize_outbound_proxy(proxy_url) if proxy_url is not None else None
    if proxy_url is not None and normalized_proxy is None:
        raise TikTokResolveError("出站代理配置无效")
    options: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "ignoreconfig": True,
        "noplaylist": True,
        "skip_download": True,
        "socket_timeout": 20,
        "retries": 2,
        "extractor_retries": 2,
        "cachedir": False,
        "cookiefile": None,
        "cookiesfrombrowser": None,
        "logger": _SilentLogger(),
    }
    if normalized_proxy:
        options["proxy"] = normalized_proxy
    return options


def _validated_info(value: object, video_id: str) -> dict[str, Any]:
    if not isinstance(value, dict) or str(value.get("id") or "") != video_id:
        raise TikTokResolveError("TikTok 页面返回了不匹配的视频数据")
    return value


def _video_candidates(info: dict[str, Any], *, require_audio: bool) -> list[dict[str, Any]]:
    formats = info.get("formats")
    candidates = (
        [item for item in formats if _is_safe_video_candidate(item, require_audio=require_audio)]
        if isinstance(formats, list)
        else []
    )

    if _is_safe_video_candidate(info, require_audio=require_audio):
        candidates.append(info)

    candidates.sort(key=_format_rank, reverse=True)
    unique: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for candidate in candidates:
        url = str(candidate["url"])
        if url not in seen_urls:
            unique.append(candidate)
            seen_urls.add(url)
    return unique


def _is_safe_video_candidate(value: object, *, require_audio: bool = True) -> bool:
    if not isinstance(value, dict):
        return False
    url = value.get("url")
    if not isinstance(url, str) or not _is_http_url(url):
        return False
    if value.get("vcodec") == "none":
        return False
    # Audio extraction and speech recognition both depend on a progressive
    # stream. Video-only downloads may accept a genuinely silent post, but
    # audio/transcription operations must never accept a video-only format.
    acodec = str(value.get("acodec") or "").lower()
    if require_audio and (not acodec or acodec == "none"):
        return False
    descriptor = f"{value.get('format_id', '')} {value.get('format_note', '')}".lower()
    return "watermark" not in descriptor and "unplayable" not in descriptor and "bytevc2" not in descriptor


def _format_rank(value: dict[str, Any]) -> tuple[float, ...]:
    codec = str(value.get("vcodec") or "").lower()
    return (
        1.0 if codec in {"h264", "avc1"} or codec.startswith("avc1") else 0.0,
        _number(value.get("preference"), -1.0),
        _number(value.get("quality"), -1.0),
        _number(value.get("height"), 0.0),
        _number(value.get("width"), 0.0),
        _number(value.get("tbr"), 0.0),
    )


def _number(value: object, fallback: float) -> float:
    return float(value) if isinstance(value, (int, float)) else fallback


def _is_http_url(value: str) -> bool:
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.hostname)


def _url_is_allowed(value: str, validator: Callable[[str], bool]) -> bool:
    try:
        return _is_http_url(value) and bool(validator(value))
    except (TypeError, ValueError):
        return False


def _media_is_valid(path: Path, validator: Callable[[Path], bool]) -> bool:
    try:
        return bool(validator(path))
    except (OSError, TypeError, ValueError):
        return False


def _candidate_headers(info: dict[str, Any], candidate: dict[str, Any]) -> dict[str, str]:
    headers = _safe_media_headers(info.get("http_headers"))
    headers.update(_safe_media_headers(candidate.get("http_headers")))
    return headers


def _safe_media_headers(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    allowed = {"accept", "accept-language", "referer", "sec-fetch-mode", "user-agent"}
    return {
        str(key): item
        for key, item in value.items()
        if str(key).lower() in allowed and isinstance(item, str) and 0 < len(item) <= 1_000
    }


def _is_video_content_type(value: str | None) -> bool:
    mime = (value or "").split(";", 1)[0].strip().lower()
    return mime in _ALLOWED_VIDEO_MIME


def _parse_content_length(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None
