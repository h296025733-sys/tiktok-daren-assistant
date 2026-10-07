from __future__ import annotations

import json
import os
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

from app.models.snapshot import SnapshotCreate
from app.storage.paths import get_data_root


def get_database_path() -> Path:
    configured = os.environ.get("TIKTOK_ASSISTANT_DB_PATH")
    return Path(configured).resolve() if configured else get_data_root() / "data" / "tiktok_assistant.db"


def connect() -> sqlite3.Connection:
    database_path = get_database_path()
    database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def initialize_database() -> None:
    with closing(connect()) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                page_url TEXT NOT NULL,
                page_type TEXT NOT NULL,
                video_id TEXT,
                author_json TEXT NOT NULL,
                description TEXT,
                created_at INTEGER,
                publish_time_text TEXT,
                duration_seconds INTEGER,
                metrics_json TEXT NOT NULL,
                extraction_json TEXT NOT NULL,
                field_evidence_json TEXT NOT NULL,
                raw_data_json TEXT NOT NULL
            )
            """
        )
        columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(snapshots)").fetchall()
        }
        if "publish_time_text" not in columns:
            connection.execute("ALTER TABLE snapshots ADD COLUMN publish_time_text TEXT")
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_snapshots_saved_at ON snapshots(saved_at DESC)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_snapshots_video_id ON snapshots(video_id)"
        )
        connection.commit()


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "saved_at": row["saved_at"],
        "page_url": row["page_url"],
        "page_type": row["page_type"],
        "video_id": row["video_id"],
        "author": json.loads(row["author_json"]),
        "description": row["description"],
        "created_at": row["created_at"],
        "publish_time_text": row["publish_time_text"],
        "duration_seconds": row["duration_seconds"],
        "metrics": json.loads(row["metrics_json"]),
        "extraction": json.loads(row["extraction_json"]),
        "field_evidence": json.loads(row["field_evidence_json"]),
        "raw_data": json.loads(row["raw_data_json"]),
    }


def insert_snapshot(snapshot: SnapshotCreate) -> dict[str, Any]:
    payload = snapshot.model_dump(mode="json")
    with closing(connect()) as connection:
        cursor = connection.execute(
            """
            INSERT INTO snapshots (
                page_url, page_type, video_id, author_json, description,
                created_at, publish_time_text, duration_seconds, metrics_json, extraction_json,
                field_evidence_json, raw_data_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(payload["page_url"]),
                payload["page_type"],
                payload["video_id"],
                _dump(payload["author"]),
                payload["description"],
                payload["created_at"],
                payload["publish_time_text"],
                payload["duration_seconds"],
                _dump(payload["metrics"]),
                _dump(payload["extraction"]),
                _dump(payload["field_evidence"]),
                _dump(payload["raw_data"]),
            ),
        )
        row = connection.execute(
            "SELECT * FROM snapshots WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
        connection.commit()
    if row is None:
        raise RuntimeError("数据写入后未能读取")
    return _row_to_dict(row)


def get_latest_snapshot() -> dict[str, Any] | None:
    with closing(connect()) as connection:
        row = connection.execute(
            "SELECT * FROM snapshots ORDER BY id DESC LIMIT 1"
        ).fetchone()
    return _row_to_dict(row) if row else None


def list_snapshots(limit: int, offset: int) -> tuple[list[dict[str, Any]], int]:
    with closing(connect()) as connection:
        total = int(connection.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0])
        rows = connection.execute(
            "SELECT * FROM snapshots ORDER BY id DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    return [_row_to_dict(row) for row in rows], total
