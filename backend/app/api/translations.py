import asyncio
from dataclasses import dataclass

from fastapi import APIRouter, HTTPException, status

from app.models.translation import (
    PublicBatchTranslationItem,
    PublicBatchTranslationRequest,
    PublicBatchTranslationResponse,
    PublicTextTranslationRequest,
    PublicTextTranslationResponse,
)
from app.services.local_translation import (
    LOCAL_TRANSLATION_PARALLELISM,
    LocalModelRequiredError,
    LocalRuntimeUnavailableError,
    LocalTranslationError,
    translate_argos_local,
)
from app.services.translation import (
    TranslationProviderError,
    translate_google_web,
    translate_google_web_batch,
)
from app.services.model_manager import get_model_status


router = APIRouter(prefix="/api/v1/translations", tags=["translations"])
LOCAL_BATCH_MAX_CONCURRENCY = LOCAL_TRANSLATION_PARALLELISM


@dataclass(frozen=True)
class _LocalTranslationAttempt:
    translated_text: str | None = None
    detected_source_language: str | None = None
    route: list[str] | None = None
    required_model_ids: list[str] | None = None
    error: LocalTranslationError | None = None


async def _translate_argos_local_batch(
    texts: list[str],
) -> list[_LocalTranslationAttempt]:
    """Run CPU-heavy fallbacks with a small, explicit concurrency ceiling."""
    semaphore = asyncio.Semaphore(LOCAL_BATCH_MAX_CONCURRENCY)

    async def translate_one(text: str) -> _LocalTranslationAttempt:
        async with semaphore:
            try:
                translated_text, detected_language, route = await asyncio.to_thread(
                    translate_argos_local,
                    text,
                )
            except LocalModelRequiredError as error:
                return _LocalTranslationAttempt(
                    required_model_ids=error.model_ids,
                    error=error,
                )
            except LocalRuntimeUnavailableError as error:
                return _LocalTranslationAttempt(error=error)
            except LocalTranslationError as error:
                return _LocalTranslationAttempt(error=error)
            return _LocalTranslationAttempt(
                translated_text=translated_text,
                detected_source_language=detected_language,
                route=route,
            )

    return list(await asyncio.gather(*(translate_one(text) for text in texts)))


@router.post(
    "/google",
    response_model=PublicTextTranslationResponse,
    response_model_exclude_none=True,
    status_code=status.HTTP_200_OK,
)
async def translate_public_text(
    request: PublicTextTranslationRequest,
) -> PublicTextTranslationResponse:
    try:
        translated_text, detected_language = await translate_google_web(
            request.text.strip(),
            request.target_language,
        )
    except TranslationProviderError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return PublicTextTranslationResponse(
        translated_text=translated_text,
        detected_source_language=detected_language,
        target_language=request.target_language,
        provider="google_translate_web",
    )


@router.post(
    "/translate",
    response_model=PublicTextTranslationResponse,
    response_model_exclude_none=True,
    status_code=status.HTTP_200_OK,
)
async def translate_text(
    request: PublicTextTranslationRequest,
) -> PublicTextTranslationResponse:
    """Use Google first; only inspect the optional local model after failure."""
    try:
        translated_text, detected_language = await translate_google_web(
            request.text.strip(),
            request.target_language,
        )
    except TranslationProviderError as online_error:
        if request.target_language != "zh-CN":
            raise HTTPException(
                status_code=502,
                detail=f"在线翻译不可用：{online_error}",
            ) from online_error
        try:
            local_text, local_language, route = await asyncio.to_thread(
                translate_argos_local,
                request.text.strip(),
            )
        except LocalModelRequiredError as model_error:
            models = [get_model_status(model_id) for model_id in model_error.model_ids]
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "LOCAL_MODEL_REQUIRED",
                    "model_ids": model_error.model_ids,
                    "message": "Google 在线翻译不可用，下载离线翻译模型后可继续",
                    "models": [model.model_dump() for model in models],
                },
            ) from model_error
        except LocalRuntimeUnavailableError as runtime_error:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": runtime_error.code,
                    "message": (
                        f"在线翻译不可用：{online_error}；{runtime_error}"
                    ),
                    "local_fallback_available": False,
                    "policy_blocked": runtime_error.policy_blocked,
                },
            ) from runtime_error
        except LocalTranslationError as local_error:
            raise HTTPException(
                status_code=502,
                detail=(
                    f"在线翻译不可用：{online_error}；"
                    f"本地翻译不可用：{local_error}"
                ),
            ) from online_error
        return PublicTextTranslationResponse(
            translated_text=local_text,
            detected_source_language=local_language,
            target_language=request.target_language,
            provider="argos_local",
            route=route,
        )
    else:
        return PublicTextTranslationResponse(
            translated_text=translated_text,
            detected_source_language=detected_language,
            target_language=request.target_language,
            provider="google_translate_web",
        )


@router.post(
    "/batch",
    response_model=PublicBatchTranslationResponse,
    response_model_exclude_none=True,
    status_code=status.HTTP_200_OK,
)
async def translate_text_batch(
    request: PublicBatchTranslationRequest,
) -> PublicBatchTranslationResponse:
    """Google 免费通道优先；简体中文目标失败时逐条回退本地模型。"""
    online_attempts = await translate_google_web_batch(
        request.texts,
        request.target_language,
    )
    local_attempts_by_index: dict[int, _LocalTranslationAttempt] = {}
    if request.target_language == "zh-CN":
        local_indexes = [
            index
            for index, attempt in enumerate(online_attempts)
            if attempt.error is not None or attempt.translated_text is None
        ]
        local_attempts = await _translate_argos_local_batch(
            [request.texts[index] for index in local_indexes]
        )
        local_attempts_by_index = dict(zip(local_indexes, local_attempts))
    results: list[PublicBatchTranslationItem] = []

    for index, (text, attempt) in enumerate(zip(request.texts, online_attempts)):
        if attempt.error is None and attempt.translated_text is not None:
            results.append(
                PublicBatchTranslationItem(
                    index=index,
                    ok=True,
                    translated_text=attempt.translated_text,
                    detected_source_language=attempt.detected_source_language,
                    provider="google_translate_web",
                )
            )
            continue

        online_error = attempt.error or TranslationProviderError(
            "Google 翻译未返回有效译文"
        )
        if request.target_language != "zh-CN":
            results.append(
                PublicBatchTranslationItem(
                    index=index,
                    ok=False,
                    error_code="ONLINE_TRANSLATION_UNAVAILABLE",
                    error_message=f"在线翻译不可用：{online_error}",
                )
            )
            continue

        local_attempt = local_attempts_by_index[index]
        if local_attempt.required_model_ids:
            results.append(
                PublicBatchTranslationItem(
                    index=index,
                    ok=False,
                    required_model_ids=local_attempt.required_model_ids,
                    error_code="LOCAL_MODEL_REQUIRED",
                    error_message=(
                        f"在线翻译不可用：{online_error}；"
                        "需要下载离线翻译模型"
                    ),
                )
            )
            continue
        if local_attempt.error is not None:
            local_error = local_attempt.error
            runtime_unavailable = isinstance(local_error, LocalRuntimeUnavailableError)
            results.append(
                PublicBatchTranslationItem(
                    index=index,
                    ok=False,
                    error_code=(
                        local_error.code
                        if runtime_unavailable
                        else "TRANSLATION_UNAVAILABLE"
                    ),
                    error_message=(
                        f"在线翻译不可用：{online_error}；"
                        f"本地翻译不可用：{local_error}"
                    ),
                )
            )
            continue

        assert local_attempt.translated_text is not None
        results.append(
            PublicBatchTranslationItem(
                index=index,
                ok=True,
                translated_text=local_attempt.translated_text,
                detected_source_language=local_attempt.detected_source_language,
                provider="argos_local",
                route=local_attempt.route,
            )
        )

    succeeded = sum(result.ok for result in results)
    return PublicBatchTranslationResponse(
        target_language=request.target_language,
        results=results,
        succeeded=succeeded,
        failed=len(results) - succeeded,
    )
