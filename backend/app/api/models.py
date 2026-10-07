from fastapi import APIRouter, HTTPException, status

from app.models.model_asset import ModelListResponse, ModelStatus
from app.services.model_manager import (
    UnknownModelError,
    list_model_statuses,
    start_model_install,
)


router = APIRouter(prefix="/api/v1/models", tags=["models"])


@router.get("", response_model=ModelListResponse, status_code=status.HTTP_200_OK)
def get_models() -> ModelListResponse:
    return ModelListResponse(models=list_model_statuses())


@router.post(
    "/{model_id}/install",
    response_model=ModelStatus,
    status_code=status.HTTP_202_ACCEPTED,
)
def install_model(model_id: str) -> ModelStatus:
    try:
        return start_model_install(model_id)
    except UnknownModelError as error:
        raise HTTPException(status_code=404, detail="未知模型") from error
