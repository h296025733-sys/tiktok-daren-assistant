from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.services.model_manager import is_model_installed
from app.services.native_runtime import (
    NativeRuntimeUnavailableError,
    ensure_ctranslate2_runtime,
)
from app.storage.paths import get_model_root


LOCAL_TRANSLATION_PARALLELISM = 2


class LocalTranslationError(RuntimeError):
    """可安全返回给本机调用方的离线翻译错误。"""


class LocalModelRequiredError(LocalTranslationError):
    def __init__(self, model_ids: list[str]) -> None:
        super().__init__("需要先下载离线翻译模型")
        self.model_ids = model_ids


class LocalRuntimeUnavailableError(LocalTranslationError):
    def __init__(self, error: NativeRuntimeUnavailableError) -> None:
        super().__init__(str(error))
        self.code = error.code
        self.policy_blocked = error.policy_blocked


@dataclass(frozen=True)
class ModelPackage:
    path: Path
    from_code: str
    to_code: str
    target_prefix: str


@dataclass
class LoadedModel:
    package: ModelPackage
    translator: Any
    tokenizer: Any


_MODEL_LOCK = threading.RLock()
_LOADED_MODELS: dict[tuple[str, str], LoadedModel] = {}


def detect_source_language(text: str) -> str:
    """按文字系统做保守检测；短视频标题通常很短，不依赖在线检测器。"""
    if re.search(r"[\u3040-\u30ff]", text):
        return "ja"
    if re.search(r"[\uac00-\ud7af]", text):
        return "ko"
    if re.search(r"[\u0400-\u04ff]", text):
        if re.search(r"[іїєґІЇЄҐ]", text):
            return "uk"
        return "ru"
    if re.search(r"[\u4e00-\u9fff]", text):
        return "zh"
    if re.search(r"[\u0600-\u06ff]", text):
        return "ar"
    if re.search(r"[\u0e00-\u0e7f]", text):
        return "th"
    if re.search(r"[A-Za-z]", text):
        return "en"
    raise LocalTranslationError("暂时无法识别原文语言")


def translate_argos_local(text: str) -> tuple[str, str, list[str]]:
    source = detect_source_language(text)
    if source == "zh":
        return text, source, ["zh"]

    # Do not prompt for offline model downloads when Windows policy prevents
    # the native engine from ever loading on this computer.
    try:
        ensure_ctranslate2_runtime()
    except NativeRuntimeUnavailableError as error:
        raise LocalRuntimeUnavailableError(error) from error

    if source == "en" and not is_model_installed("argos-en-zh"):
        raise LocalModelRequiredError(["argos-en-zh"])
    if source == "ru":
        required_model_ids = [
            model_id
            for model_id in ("argos-ru-en", "argos-en-zh")
            if not is_model_installed(model_id)
        ]
        if required_model_ids:
            raise LocalModelRequiredError(required_model_ids)

    packages = _discover_packages()
    route = _find_route(source, "zh", packages)
    if route is None:
        raise LocalTranslationError(f"尚未安装 {source}→zh 离线模型")

    translated = text
    for from_code, to_code in zip(route, route[1:]):
        package = packages[(from_code, to_code)]
        translated = _translate_with_package(translated, package)
    if not translated.strip():
        raise LocalTranslationError("离线模型未返回有效译文")
    return translated.strip(), source, route


def _discover_packages() -> dict[tuple[str, str], ModelPackage]:
    packages_dir = get_model_root() / "argos" / "packages"
    if not packages_dir.exists():
        raise LocalTranslationError("离线模型目录不存在")
    packages: dict[tuple[str, str], ModelPackage] = {}
    for metadata_path in sorted(packages_dir.glob("*/metadata.json")):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            from_code = str(metadata["from_code"])
            to_code = str(metadata["to_code"])
        except (OSError, KeyError, TypeError, ValueError):
            continue
        package_path = metadata_path.parent
        if not (package_path / "model" / "model.bin").is_file():
            continue
        if not (package_path / "sentencepiece.model").is_file():
            continue
        packages[(from_code, to_code)] = ModelPackage(
            path=package_path,
            from_code=from_code,
            to_code=to_code,
            target_prefix=str(metadata.get("target_prefix", "")),
        )
    return packages


def _find_route(
    source: str,
    target: str,
    packages: dict[tuple[str, str], ModelPackage],
) -> list[str] | None:
    if (source, target) in packages:
        return [source, target]
    if source != "en" and (source, "en") in packages and ("en", target) in packages:
        return [source, "en", target]
    return None


def _translate_with_package(text: str, package: ModelPackage) -> str:
    loaded = _load_model(package)
    tokens = loaded.tokenizer.encode(text, out_type=str)
    if not tokens:
        return text
    target_prefix = [[package.target_prefix]] if package.target_prefix else None
    try:
        result = loaded.translator.translate_batch(
            [tokens],
            target_prefix=target_prefix,
            replace_unknowns=True,
            max_batch_size=32,
            batch_type="tokens",
            beam_size=4,
            length_penalty=0.2,
        )[0]
        translated_tokens = result.hypotheses[0]
        translated = (
            loaded.tokenizer.decode_pieces(translated_tokens)
            .replace("▁", " ")
            .replace("_", " ")
        )
    except Exception as error:
        raise LocalTranslationError(
            f"{package.from_code}→{package.to_code} 离线模型推理失败"
        ) from error
    if package.target_prefix and translated.startswith(package.target_prefix):
        translated = translated[len(package.target_prefix) :]
    return translated.strip()


def _load_model(package: ModelPackage) -> LoadedModel:
    key = (package.from_code, package.to_code)
    with _MODEL_LOCK:
        cached = _LOADED_MODELS.get(key)
        if cached is not None and cached.package.path == package.path:
            return cached
        try:
            ctranslate2 = ensure_ctranslate2_runtime()
            import sentencepiece

            translator = ctranslate2.Translator(
                str(package.path / "model"),
                device="cpu",
                compute_type="auto",
                inter_threads=LOCAL_TRANSLATION_PARALLELISM,
                intra_threads=1,
            )
            tokenizer = sentencepiece.SentencePieceProcessor(
                model_file=str(package.path / "sentencepiece.model")
            )
        except NativeRuntimeUnavailableError as error:
            raise LocalRuntimeUnavailableError(error) from error
        except (ImportError, OSError, RuntimeError) as error:
            raise LocalTranslationError("离线翻译运行库或模型加载失败") from error
        loaded = LoadedModel(package=package, translator=translator, tokenizer=tokenizer)
        _LOADED_MODELS[key] = loaded
        return loaded


def reset_model_cache_for_tests() -> None:
    with _MODEL_LOCK:
        _LOADED_MODELS.clear()
