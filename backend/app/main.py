from contextlib import asynccontextmanager

from fastapi import FastAPI
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.downloads import router as downloads_router
from app.api.models import router as models_router
from app.api.snapshots import router as snapshots_router
from app.api.translations import router as translations_router
from app.api.transcriptions import router as transcriptions_router
from app.middleware.private_network_cors import PrivateNetworkCORSMiddleware
from app.storage.database import initialize_database


SERVICE_NAME = "tiktok-daren-assistant"
VERSION = "0.1.28"
EXTENSION_ID = "kpdocbejchofflefehdlphffcbdmphij"


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    yield


app = FastAPI(
    title="TikTok 达人助手本地服务",
    version=VERSION,
    lifespan=lifespan,
)

app.add_middleware(
    PrivateNetworkCORSMiddleware,
    allow_origin_regex=rf"chrome-extension://{EXTENSION_ID}",
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["localhost", "127.0.0.1", "testserver"],
    www_redirect=False,
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": SERVICE_NAME, "version": VERSION}


app.include_router(snapshots_router)
app.include_router(translations_router)
app.include_router(downloads_router)
app.include_router(transcriptions_router)
app.include_router(models_router)
