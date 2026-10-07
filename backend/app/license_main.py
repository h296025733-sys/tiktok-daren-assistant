from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.license.api import router as license_router
from app.license.storage import initialize_license_database


SERVICE_NAME = "tiktok-daren-assistant-license"
VERSION = "1"
EXTENSION_ID = "kpdocbejchofflefehdlphffcbdmphij"


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_license_database()
    yield


app = FastAPI(
    title="TikTok 达人助手设备授权",
    version=VERSION,
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"chrome-extension://{EXTENSION_ID}"],
    allow_credentials=False,
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)

public_host = os.environ.get("TDA_LICENSE_PUBLIC_HOST", "").strip().lower()
allowed_hosts = ["localhost", "127.0.0.1", "testserver"]
if public_host:
    allowed_hosts.append(public_host)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts, www_redirect=False)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": SERVICE_NAME, "version": VERSION}


app.include_router(license_router)
