from __future__ import annotations

import hashlib
import secrets
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from app.storage.paths import get_data_root


KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


@dataclass(frozen=True)
class LicenseRecord:
    key_id: int
    label: str
    state: str
    device_id: str | None
    bound_at: str | None
    last_seen_at: str | None


class ActivationAlreadyUsedError(RuntimeError):
    pass


class ActivationUnavailableError(RuntimeError):
    pass


def get_license_database_path() -> Path:
    return get_data_root() / "data" / "device_licenses.db"


def connect_license_database() -> sqlite3.Connection:
    path = get_license_database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=10000")
    return connection


def initialize_license_database() -> None:
    with closing(connect_license_database()) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS activation_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key_hash TEXT NOT NULL UNIQUE,
                label TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'available'
                    CHECK (state IN ('available', 'bound', 'revoked')),
                created_at TEXT NOT NULL,
                device_id TEXT UNIQUE,
                device_secret_hash TEXT,
                extension_id TEXT,
                extension_version TEXT,
                bound_at TEXT,
                last_seen_at TEXT,
                revoked_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_activation_keys_state
                ON activation_keys(state, id);
            """
        )
        connection.commit()


def generate_activation_keys(count: int, label_prefix: str = "员工设备") -> list[str]:
    if count < 1 or count > 100:
        raise ValueError("count must be between 1 and 100")
    initialize_license_database()
    generated: list[str] = []
    with closing(connect_license_database()) as connection:
        connection.execute("BEGIN IMMEDIATE")
        for index in range(count):
            while True:
                raw = "".join(secrets.choice(KEY_ALPHABET) for _ in range(32))
                normalized = f"TDA{raw}"
                digest = _digest(normalized)
                exists = connection.execute(
                    "SELECT 1 FROM activation_keys WHERE key_hash = ?", (digest,)
                ).fetchone()
                if exists is None:
                    break
            connection.execute(
                """
                INSERT INTO activation_keys (key_hash, label, created_at)
                VALUES (?, ?, ?)
                """,
                (digest, f"{label_prefix}{index + 1:02d}", _now()),
            )
            generated.append(format_activation_key(normalized))
        connection.commit()
    return generated


def bind_device(
    activation_key: str,
    device_id: str,
    device_secret: str,
    extension_id: str,
    extension_version: str,
) -> LicenseRecord:
    initialize_license_database()
    normalized_key = normalize_activation_key(activation_key)
    secret_hash = _digest(device_secret)
    now = _now()
    with closing(connect_license_database()) as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT * FROM activation_keys WHERE key_hash = ?", (_digest(normalized_key),)
        ).fetchone()
        if row is None:
            connection.rollback()
            raise ActivationUnavailableError("activation key not found")
        if row["state"] == "revoked":
            connection.rollback()
            raise ActivationUnavailableError("activation key revoked")
        if row["state"] == "bound":
            if row["device_id"] == device_id and secrets.compare_digest(
                row["device_secret_hash"] or "", secret_hash
            ):
                connection.execute(
                    "UPDATE activation_keys SET last_seen_at = ?, extension_version = ? WHERE id = ?",
                    (now, extension_version, row["id"]),
                )
                connection.commit()
                return _record(connection, int(row["id"]))
            connection.rollback()
            raise ActivationAlreadyUsedError("activation key already bound")
        conflicting = connection.execute(
            "SELECT id FROM activation_keys WHERE device_id = ?", (device_id,)
        ).fetchone()
        if conflicting is not None:
            connection.rollback()
            raise ActivationAlreadyUsedError("device already bound")
        connection.execute(
            """
            UPDATE activation_keys
            SET state = 'bound', device_id = ?, device_secret_hash = ?,
                extension_id = ?, extension_version = ?, bound_at = ?, last_seen_at = ?
            WHERE id = ? AND state = 'available'
            """,
            (device_id, secret_hash, extension_id, extension_version, now, now, row["id"]),
        )
        connection.commit()
        return _record(connection, int(row["id"]))


def validate_device(
    device_id: str,
    device_secret: str,
    extension_id: str,
    extension_version: str,
) -> LicenseRecord | None:
    initialize_license_database()
    with closing(connect_license_database()) as connection:
        row = connection.execute(
            "SELECT * FROM activation_keys WHERE device_id = ?", (device_id,)
        ).fetchone()
        if row is None or row["state"] != "bound" or row["extension_id"] != extension_id:
            return None
        if not secrets.compare_digest(row["device_secret_hash"] or "", _digest(device_secret)):
            return None
        now = _now()
        connection.execute(
            "UPDATE activation_keys SET last_seen_at = ?, extension_version = ? WHERE id = ?",
            (now, extension_version, row["id"]),
        )
        connection.commit()
        return _record(connection, int(row["id"]))


def list_license_records() -> list[LicenseRecord]:
    initialize_license_database()
    with closing(connect_license_database()) as connection:
        rows = connection.execute("SELECT * FROM activation_keys ORDER BY id").fetchall()
    return [_row_to_record(row) for row in rows]


def revoke_key(key_id: int) -> None:
    initialize_license_database()
    with closing(connect_license_database()) as connection:
        connection.execute(
            "UPDATE activation_keys SET state = 'revoked', revoked_at = ? WHERE id = ?",
            (_now(), key_id),
        )
        connection.commit()


def reset_key(key_id: int) -> None:
    initialize_license_database()
    with closing(connect_license_database()) as connection:
        connection.execute(
            """
            UPDATE activation_keys
            SET state = 'available', device_id = NULL, device_secret_hash = NULL,
                extension_id = NULL, extension_version = NULL, bound_at = NULL,
                last_seen_at = NULL, revoked_at = NULL
            WHERE id = ?
            """,
            (key_id,),
        )
        connection.commit()


def normalize_activation_key(value: str) -> str:
    return "".join(character for character in value.upper() if character.isalnum())


def format_activation_key(value: str) -> str:
    normalized = normalize_activation_key(value)
    return "-".join(normalized[index:index + 5] for index in range(0, len(normalized), 5))


def _record(connection: sqlite3.Connection, key_id: int) -> LicenseRecord:
    row = connection.execute("SELECT * FROM activation_keys WHERE id = ?", (key_id,)).fetchone()
    if row is None:
        raise RuntimeError("license record disappeared")
    return _row_to_record(row)


def _row_to_record(row: sqlite3.Row) -> LicenseRecord:
    return LicenseRecord(
        key_id=int(row["id"]),
        label=str(row["label"]),
        state=str(row["state"]),
        device_id=str(row["device_id"]) if row["device_id"] else None,
        bound_at=str(row["bound_at"]) if row["bound_at"] else None,
        last_seen_at=str(row["last_seen_at"]) if row["last_seen_at"] else None,
    )


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")

