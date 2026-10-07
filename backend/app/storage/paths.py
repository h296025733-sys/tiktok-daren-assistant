from __future__ import annotations

import os
import sys
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[2]


def get_data_root() -> Path:
    """Return the writable per-user application directory.

    Source checkouts keep their historical layout. Packaged builds must never
    write next to a frozen executable, so they default to LocalAppData. Tests,
    managed installs and portable deployments can override the location with
    TIKTOK_ASSISTANT_HOME (with TDA_DATA_ROOT retained as a compatibility
    alias).
    """

    configured = os.environ.get("TIKTOK_ASSISTANT_HOME") or os.environ.get("TDA_DATA_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    if getattr(sys, "frozen", False):
        local_app_data = os.environ.get("LOCALAPPDATA")
        base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
        return (base / "TikTokDarenAssistant").resolve()
    return BACKEND_ROOT.parent


def get_model_root() -> Path:
    configured = os.environ.get("TIKTOK_ASSISTANT_MODEL_ROOT") or os.environ.get("TDA_MODEL_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    if (
        os.environ.get("TIKTOK_ASSISTANT_HOME")
        or os.environ.get("TDA_DATA_ROOT")
        or getattr(sys, "frozen", False)
    ):
        return get_data_root() / "models"
    return BACKEND_ROOT / "models"


def get_model_staging_root() -> Path:
    if (
        os.environ.get("TIKTOK_ASSISTANT_HOME")
        or os.environ.get("TDA_DATA_ROOT")
        or getattr(sys, "frozen", False)
    ):
        return get_data_root() / "cache" / "model-downloads"
    return get_model_root() / ".staging"


def get_output_root() -> Path:
    configured = os.environ.get("TIKTOK_ASSISTANT_OUTPUT_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    if (
        os.environ.get("TIKTOK_ASSISTANT_HOME")
        or os.environ.get("TDA_DATA_ROOT")
        or getattr(sys, "frozen", False)
    ):
        return get_data_root() / "outputs"
    return BACKEND_ROOT.parent / "outputs"
