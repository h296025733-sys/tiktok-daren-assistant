from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.license.models import (
    DeviceActivationRequest,
    DeviceValidationRequest,
    LicenseResponse,
)
from app.license.storage import (
    ActivationAlreadyUsedError,
    ActivationUnavailableError,
    bind_device,
    validate_device,
)


router = APIRouter(prefix="/api/v1/license", tags=["license"])


@router.post("/activate", response_model=LicenseResponse)
def activate(request: DeviceActivationRequest) -> LicenseResponse:
    try:
        record = bind_device(
            request.activation_key,
            request.device_id,
            request.device_secret,
            request.extension_id,
            request.extension_version,
        )
    except ActivationAlreadyUsedError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="这个激活码已经绑定过其他电脑",
        ) from error
    except ActivationUnavailableError as error:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="激活码无效或已被停用",
        ) from error
    return LicenseResponse(
        ok=True,
        authorized=True,
        status="active",
        message="这台电脑已经绑定成功",
        key_id=record.key_id,
        bound_at=record.bound_at,
    )


@router.post("/validate", response_model=LicenseResponse)
def validate(request: DeviceValidationRequest) -> LicenseResponse:
    record = validate_device(
        request.device_id,
        request.device_secret,
        request.extension_id,
        request.extension_version,
    )
    if record is None:
        return LicenseResponse(
            ok=True,
            authorized=False,
            status="revoked",
            message="这台电脑的授权无效或已被停用",
        )
    return LicenseResponse(
        ok=True,
        authorized=True,
        status="active",
        message="设备授权有效",
        key_id=record.key_id,
        bound_at=record.bound_at,
    )

