import base64
import hashlib
import json
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import EXTENSION_ID, app
from app.storage.database import get_database_path


@pytest.fixture(autouse=True)
def isolated_database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """所有自动测试使用临时 SQLite，绝不删除 data 中的真实业务数据库。"""
    monkeypatch.setenv("TIKTOK_ASSISTANT_DB_PATH", str(tmp_path / "test_assistant.db"))


def sample_snapshot() -> dict:
    return {
        "page_type": "video_detail",
        "page_url": "https://www.tiktok.com/@example/video/1234567890123456789",
        "video_id": "1234567890123456789",
        "author": {"nickname": "测试作者", "unique_id": "example"},
        "description": "自动测试记录，不来自真实 TikTok 页面",
        "created_at": None,
        "publish_time_text": "5小时前",
        "duration_seconds": None,
        "metrics": {
            "play_count": None,
            "like_count": 12,
            "comment_count": None,
            "collect_count": None,
            "share_count": None,
        },
        "extraction": {"source": "automated_test", "confidence": "high"},
        "field_evidence": {
            "metrics.like_count": {
                "value": 12,
                "source": "automated_test",
                "confidence": "high",
                "raw_value": "12",
            }
        },
        "raw_data": {"test_marker": True},
    }


def test_health() -> None:
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "tiktok-daren-assistant",
        "version": "0.1.28",
    }


def test_manifest_key_matches_the_only_trusted_extension_origin() -> None:
    manifest_path = Path(__file__).resolve().parents[2] / "extension" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    public_key = base64.b64decode(manifest["key"], validate=True)
    digest = hashlib.sha256(public_key).digest()[:16]
    alphabet = "abcdefghijklmnop"
    derived_id = "".join(
        alphabet[nibble]
        for byte in digest
        for nibble in (byte >> 4, byte & 0x0F)
    )
    assert derived_id == EXTENSION_ID


def test_chrome_extension_private_network_cors_preflight() -> None:
    origin = f"chrome-extension://{EXTENSION_ID}"
    with TestClient(app) as client:
        response = client.options(
            "/api/v1/snapshots",
            headers={
                "Host": "localhost:8765",
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
                "Access-Control-Request-Private-Network": "true",
            },
        )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert response.headers["access-control-allow-private-network"] == "true"
    assert "Access-Control-Request-Private-Network" in response.headers["vary"]


def test_regular_cors_preflight_does_not_claim_private_network_access() -> None:
    origin = f"chrome-extension://{EXTENSION_ID}"
    with TestClient(app) as client:
        response = client.options(
            "/api/v1/translations/batch",
            headers={
                "Host": "127.0.0.1:8765",
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert "access-control-allow-private-network" not in response.headers


@pytest.mark.parametrize(
    "origin",
    [
        "https://www.tiktok.com",
        f"chrome-extension://{EXTENSION_ID}.evil.example",
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        "chrome-extension://short",
    ],
)
def test_private_network_preflight_rejects_non_extension_origins(origin: str) -> None:
    with TestClient(app) as client:
        response = client.options(
            "/api/v1/translations/batch",
            headers={
                "Host": "localhost:8765",
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
                "Access-Control-Request-Private-Network": "true",
            },
        )
    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers
    assert "access-control-allow-private-network" not in response.headers


def test_local_service_rejects_non_loopback_host_header() -> None:
    origin = f"chrome-extension://{EXTENSION_ID}"
    with TestClient(app) as client:
        response = client.options(
            "/api/v1/translations/batch",
            headers={
                "Host": "service.example.com",
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Private-Network": "true",
            },
        )
    assert response.status_code == 400
    assert response.text == "Invalid host header"
    assert "access-control-allow-private-network" not in response.headers


def test_snapshot_is_persisted_to_sqlite() -> None:
    database_path = get_database_path()
    if database_path.exists():
        database_path.unlink()

    with TestClient(app) as client:
        created = client.post("/api/v1/snapshots", json=sample_snapshot())
        latest = client.get("/api/v1/snapshots/latest")
        history = client.get("/api/v1/snapshots", params={"limit": 10, "offset": 0})

    assert created.status_code == 201
    assert created.json()["id"] >= 1
    assert latest.status_code == 200
    assert latest.json()["video_id"] == "1234567890123456789"
    assert latest.json()["publish_time_text"] == "5小时前"
    assert history.status_code == 200
    assert history.json()["total"] == 1

    assert database_path.exists()
    with closing(sqlite3.connect(database_path)) as connection:
        row = connection.execute(
            "SELECT video_id, metrics_json, raw_data_json FROM snapshots"
        ).fetchone()
    assert row is not None
    assert row[0] == "1234567890123456789"
    assert json.loads(row[1])["like_count"] == 12
    assert json.loads(row[2])["test_marker"] is True
    database_path.unlink()
