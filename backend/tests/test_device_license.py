from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.license_main import app
from app.license.storage import (
    ActivationAlreadyUsedError,
    bind_device,
    generate_activation_keys,
    list_license_records,
    revoke_key,
    validate_device,
)


EXTENSION_ID = "kpdocbejchofflefehdlphffcbdmphij"
DEVICE_A = "a" * 32
DEVICE_B = "b" * 32
SECRET_A = "A" * 43
SECRET_B = "B" * 43


def test_key_binds_once_and_validates(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv("TIKTOK_ASSISTANT_HOME", str(tmp_path))
    key = generate_activation_keys(1)[0]
    record = bind_device(key, DEVICE_A, SECRET_A, EXTENSION_ID, "0.1.28")
    assert record.state == "bound"
    assert validate_device(DEVICE_A, SECRET_A, EXTENSION_ID, "0.1.28") is not None
    assert validate_device(DEVICE_A, SECRET_B, EXTENSION_ID, "0.1.28") is None
    with pytest.raises(ActivationAlreadyUsedError):
        bind_device(key, DEVICE_B, SECRET_B, EXTENSION_ID, "0.1.28")


def test_retry_from_same_device_is_idempotent(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv("TIKTOK_ASSISTANT_HOME", str(tmp_path))
    key = generate_activation_keys(1)[0]
    first = bind_device(key, DEVICE_A, SECRET_A, EXTENSION_ID, "0.1.28")
    retried = bind_device(key, DEVICE_A, SECRET_A, EXTENSION_ID, "0.1.28")
    assert retried.key_id == first.key_id


def test_revoked_device_cannot_validate(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv("TIKTOK_ASSISTANT_HOME", str(tmp_path))
    key = generate_activation_keys(1)[0]
    record = bind_device(key, DEVICE_A, SECRET_A, EXTENSION_ID, "0.1.28")
    revoke_key(record.key_id)
    assert validate_device(DEVICE_A, SECRET_A, EXTENSION_ID, "0.1.28") is None
    assert list_license_records()[0].state == "revoked"


def test_public_api_binds_once_and_never_returns_secret(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setenv("TIKTOK_ASSISTANT_HOME", str(tmp_path))
    key = generate_activation_keys(1)[0]
    with TestClient(app) as client:
        payload = {
            "activation_key": key,
            "device_id": DEVICE_A,
            "device_secret": SECRET_A,
            "extension_id": EXTENSION_ID,
            "extension_version": "0.1.28",
        }
        response = client.post("/api/v1/license/activate", json=payload)
        assert response.status_code == 200
        assert response.json()["authorized"] is True
        assert "device_secret" not in response.text
        second = client.post(
            "/api/v1/license/activate",
            json={**payload, "device_id": DEVICE_B, "device_secret": SECRET_B},
        )
        assert second.status_code == 409
