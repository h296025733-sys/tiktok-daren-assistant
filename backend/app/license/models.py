from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


DEVICE_ID_PATTERN = r"^[a-f0-9]{32}$"
DEVICE_SECRET_PATTERN = r"^[A-Za-z0-9_-]{43}$"
EXTENSION_ID_PATTERN = r"^[a-p]{32}$"


class DeviceIdentity(BaseModel):
    device_id: str = Field(pattern=DEVICE_ID_PATTERN)
    device_secret: str = Field(pattern=DEVICE_SECRET_PATTERN)
    extension_id: str = Field(pattern=EXTENSION_ID_PATTERN)
    extension_version: str = Field(min_length=1, max_length=32)


class DeviceActivationRequest(DeviceIdentity):
    activation_key: str = Field(min_length=20, max_length=80)

    @field_validator("activation_key")
    @classmethod
    def normalize_activation_key(cls, value: str) -> str:
        normalized = "".join(character for character in value.upper() if character.isalnum())
        if not normalized.startswith("TDA") or len(normalized) != 35:
            raise ValueError("invalid activation key")
        return normalized


class DeviceValidationRequest(DeviceIdentity):
    pass


class LicenseResponse(BaseModel):
    ok: bool
    authorized: bool
    status: str
    message: str
    key_id: int | None = None
    bound_at: str | None = None

