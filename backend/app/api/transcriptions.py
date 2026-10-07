from fastapi import APIRouter, HTTPException, status

from app.models.transcription import TranscriptionRequest, TranscriptionResponse
from app.services.file_delivery import expose_files
from app.services.model_manager import get_model_status
from app.services.transcription import (
    TranscriptionError,
    TranscriptionModelRequiredError,
    TranscriptionRuntimeUnavailableError,
    execute_transcription,
)


router = APIRouter(prefix="/api/v1/transcriptions", tags=["transcriptions"])


@router.post("", response_model=TranscriptionResponse, status_code=status.HTTP_200_OK)
async def transcribe(request: TranscriptionRequest) -> TranscriptionResponse:
    try:
        result = await execute_transcription(request)
    except TranscriptionModelRequiredError as error:
        models = [get_model_status(model_id) for model_id in error.model_ids]
        raise HTTPException(
            status_code=409,
            detail={
                "code": "MODEL_REQUIRED",
                "model_ids": error.model_ids,
                "message": str(error),
                "models": [model.model_dump() for model in models],
            },
        ) from error
    except TranscriptionRuntimeUnavailableError as error:
        raise HTTPException(
            status_code=503,
            detail={
                "code": error.code,
                "message": str(error),
                "browser_fallback": True,
                "policy_blocked": error.policy_blocked,
            },
        ) from error
    except TranscriptionError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return result.model_copy(
        update={"transcript_files": expose_files(result.transcript_files)},
        deep=True,
    )
