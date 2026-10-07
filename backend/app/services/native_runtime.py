from __future__ import annotations

import os
import threading
from typing import Any


APPLICATION_CONTROL_MARKERS = (
    "application control policy",
    "app control policy",
    "windows defender application control",
    "wdac",
    "smart app control",
    "应用程序控制策略已阻止",
    "应用控制策略已阻止",
    "组织的安全策略阻止",
)


class NativeRuntimeUnavailableError(RuntimeError):
    def __init__(self, error: BaseException) -> None:
        self.original_error = error
        self.policy_blocked = is_application_control_block(error)
        self.code = (
            "APPLICATION_CONTROL_BLOCKED"
            if self.policy_blocked
            else "NATIVE_RUNTIME_UNAVAILABLE"
        )
        if self.policy_blocked:
            message = (
                "Windows 企业应用控制策略阻止了本地 AI 运行库；"
                "字幕可改用浏览器兼容模式，在线翻译和下载功能不受影响"
            )
        else:
            message = (
                "本地 AI 运行库无法加载；字幕可改用浏览器兼容模式，"
                "在线翻译和下载功能不受影响"
            )
        super().__init__(f"{message}（{type(error).__name__}: {error}）")


_runtime_lock = threading.Lock()
_ctranslate2_runtime: Any | None = None


def ensure_ctranslate2_runtime() -> Any:
    global _ctranslate2_runtime
    with _runtime_lock:
        if _ctranslate2_runtime is not None:
            return _ctranslate2_runtime
        if os.environ.get("TIKTOK_ASSISTANT_DIAGNOSTIC_AI_POLICY_BLOCK") == "1":
            raise NativeRuntimeUnavailableError(
                ImportError(
                    "DLL load failed while importing _ext: "
                    "应用程序控制策略已阻止此文件。"
                )
            )
        try:
            import ctranslate2
        except (ImportError, OSError, RuntimeError) as error:
            raise NativeRuntimeUnavailableError(error) from error
        _ctranslate2_runtime = ctranslate2
        return _ctranslate2_runtime


def is_application_control_block(error: BaseException | str) -> bool:
    detail = _exception_chain_text(error) if isinstance(error, BaseException) else error
    normalized = detail.casefold()
    return any(marker.casefold() in normalized for marker in APPLICATION_CONTROL_MARKERS)


def _exception_chain_text(error: BaseException) -> str:
    parts: list[str] = []
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        parts.append(f"{type(current).__name__}: {current}")
        current = current.__cause__ or current.__context__
    return " | ".join(parts)


def reset_native_runtime_for_tests() -> None:
    global _ctranslate2_runtime
    with _runtime_lock:
        _ctranslate2_runtime = None
