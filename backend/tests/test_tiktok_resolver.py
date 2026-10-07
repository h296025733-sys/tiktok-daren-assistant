from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from app.services import tiktok_resolver


def test_build_canonical_url_matches_tiktok_video_shape() -> None:
    assert (
        tiktok_resolver.build_canonical_tiktok_url("7654207540028394774", "@creator name")
        == "https://www.tiktok.com/@creator%20name/video/7654207540028394774"
    )
    assert (
        tiktok_resolver.build_canonical_tiktok_url("7654207540028394774")
        == "https://www.tiktok.com/@_/video/7654207540028394774"
    )


def test_resolver_uses_pinned_extractor_without_cookies_and_avoids_watermark(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: dict[str, Any] = {}

    class FakeYoutubeDL:
        def __init__(self, options: dict[str, Any]) -> None:
            observed.update(options)

        def __enter__(self) -> "FakeYoutubeDL":
            return self

        def __exit__(self, *_: object) -> None:
            pass

        def extract_info(self, url: str, download: bool) -> dict[str, Any]:
            assert url.endswith("/@creator/video/7654207540028394774")
            assert download is False
            return {
                "id": "7654207540028394774",
                "formats": [
                    {
                        "format_id": "download",
                        "format_note": "watermarked",
                        "url": "https://v16.tiktokcdn.com/watermarked.mp4?secret=1",
                        "vcodec": "h264",
                        "acodec": "aac",
                        "height": 1920,
                    },
                    {
                        "format_id": "play",
                        "format_note": "Direct video",
                        "url": "https://v16.tiktokcdn.com/play.mp4?secret=2",
                        "vcodec": "h264",
                        "acodec": "aac",
                        "height": 1280,
                    },
                ],
            }

    monkeypatch.setattr(tiktok_resolver, "YoutubeDL", FakeYoutubeDL)
    result = tiktok_resolver.resolve_tiktok_video_url("7654207540028394774", "creator")

    assert result == "https://v16.tiktokcdn.com/play.mp4?secret=2"
    assert observed["ignoreconfig"] is True
    assert observed["cookiefile"] is None
    assert observed["cookiesfrombrowser"] is None
    assert observed["skip_download"] is True


def test_resolver_rejects_mismatched_video_id(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeYoutubeDL:
        def __init__(self, _: dict[str, Any]) -> None:
            pass

        def __enter__(self) -> "FakeYoutubeDL":
            return self

        def __exit__(self, *_: object) -> None:
            pass

        def extract_info(self, _: str, download: bool) -> dict[str, Any]:
            assert download is False
            return {"id": "7000000000000000000", "url": "https://v16.tiktokcdn.com/a.mp4"}

    monkeypatch.setattr(tiktok_resolver, "YoutubeDL", FakeYoutubeDL)
    with pytest.raises(tiktok_resolver.TikTokResolveError, match="不匹配"):
        tiktok_resolver.resolve_tiktok_video_url("7654207540028394774")


def test_video_only_candidate_is_allowed_only_for_video_downloads() -> None:
    info = {
        "formats": [
            {
                "format_id": "silent-video",
                "url": "https://v16.tiktokcdn.com/video-only.mp4",
                "vcodec": "h264",
                "acodec": "none",
            }
        ]
    }

    assert tiktok_resolver._video_candidates(info, require_audio=True) == []
    assert tiktok_resolver._video_candidates(info, require_audio=False) == info["formats"]


def test_download_extracts_and_streams_with_same_ytdlp_session(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    observed: dict[str, Any] = {}

    class FakeResponse:
        status = 200
        url = "https://v16.tiktokcdn.com/final.mp4"
        headers = {"content-type": "video/mp4", "content-length": "11"}

        def __init__(self) -> None:
            self._chunks = iter([b"same-", b"session", b""])

        def __enter__(self) -> "FakeResponse":
            return self

        def __exit__(self, *_: object) -> None:
            pass

        def read(self, _: int) -> bytes:
            return next(self._chunks)

    class FakeYoutubeDL:
        def __init__(self, options: dict[str, Any]) -> None:
            observed.update(options)
            self.extracted = False

        def __enter__(self) -> "FakeYoutubeDL":
            return self

        def __exit__(self, *_: object) -> None:
            pass

        def extract_info(self, _: str, download: bool) -> dict[str, Any]:
            assert download is False
            self.extracted = True
            return {
                "id": "7654207540028394774",
                "http_headers": {"User-Agent": "yt-dlp-test", "Cookie": "must-not-copy"},
                "formats": [
                    {
                        "format_id": "video-only",
                        "url": "https://v16.tiktokcdn.com/video-only.mp4",
                        "vcodec": "h264",
                        "acodec": "none",
                        "height": 2160,
                    },
                    {
                        "format_id": "play",
                        "url": "https://v16.tiktokcdn.com/play.mp4",
                        "vcodec": "h264",
                        "acodec": "aac",
                    }
                ],
            }

        def urlopen(self, request: Any) -> FakeResponse:
            assert self.extracted, "media request must use the extractor's YoutubeDL instance"
            assert request.url == "https://v16.tiktokcdn.com/play.mp4"
            assert request.headers["User-Agent"] == "yt-dlp-test"
            assert "Cookie" not in request.headers
            return FakeResponse()

    monkeypatch.setattr(tiktok_resolver, "YoutubeDL", FakeYoutubeDL)
    destination = tmp_path / "video.mp4"

    tiktok_resolver.download_tiktok_video(
        "7654207540028394774",
        "creator",
        destination,
        proxy_url="http://127.0.0.1:9567",
        max_bytes=100,
        url_validator=lambda value: value.startswith("https://v16.tiktokcdn.com/"),
        media_validator=lambda path: path.read_bytes() == b"same-session",
    )

    assert destination.read_bytes() == b"same-session"
    assert observed["proxy"] == "http://127.0.0.1:9567"
    assert not list(tmp_path.glob("*.partial.*"))


def test_download_rejects_oversized_response_and_cleans_partial(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakeResponse:
        status = 200
        url = "https://v16.tiktokcdn.com/final.mp4"
        headers = {"content-type": "video/mp4", "content-length": "101"}

        def __enter__(self) -> "FakeResponse":
            return self

        def __exit__(self, *_: object) -> None:
            pass

    class FakeYoutubeDL:
        def __init__(self, _: dict[str, Any]) -> None:
            pass

        def __enter__(self) -> "FakeYoutubeDL":
            return self

        def __exit__(self, *_: object) -> None:
            pass

        def extract_info(self, _: str, download: bool) -> dict[str, Any]:
            assert download is False
            return {
                "id": "7654207540028394774",
                "url": "https://v16.tiktokcdn.com/play.mp4",
                "vcodec": "h264",
                "acodec": "aac",
            }

        def urlopen(self, _: Any) -> FakeResponse:
            return FakeResponse()

    monkeypatch.setattr(tiktok_resolver, "YoutubeDL", FakeYoutubeDL)
    destination = tmp_path / "video.mp4"

    with pytest.raises(tiktok_resolver.TikTokResolveError, match="500MB"):
        tiktok_resolver.download_tiktok_video(
            "7654207540028394774",
            None,
            destination,
            proxy_url=None,
            max_bytes=100,
            url_validator=lambda _: True,
            media_validator=lambda _: True,
        )

    assert not destination.exists()
    assert not list(tmp_path.glob("*.partial.*"))
