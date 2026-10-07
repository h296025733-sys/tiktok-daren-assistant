from pathlib import Path

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
    copy_metadata,
)


repository_root = Path(SPECPATH).parent
backend_root = repository_root / "backend"
entry_point = repository_root / "packaging" / "backend_entry.py"

datas = []
binaries = []
hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
]

# imageio-ffmpeg ships the Windows FFmpeg executable as package data. It is
# required for media validation and audio extraction, but no AI model is
# bundled into the application.
datas += collect_data_files("imageio_ffmpeg", includes=["binaries/*"])
# faster-whisper's small Silero VAD asset is runtime code data, not the
# downloadable speech model. Keep it so vad_filter works on a clean machine.
datas += collect_data_files("faster_whisper", includes=["assets/*"])

for distribution in (
    "fastapi",
    "faster-whisper",
    "huggingface-hub",
    "imageio-ffmpeg",
    "pydantic",
    "uvicorn",
    "yt-dlp",
):
    try:
        datas += copy_metadata(distribution)
    except Exception:
        pass

for package in ("ctranslate2", "av", "onnxruntime"):
    try:
        binaries += collect_dynamic_libs(package)
    except Exception:
        pass

# yt-dlp resolves extractors dynamically. Explicit collection avoids a build
# that appears healthy but cannot resolve TikTok on a clean colleague PC.
for package in (
    "faster_whisper",
    "huggingface_hub",
    "yt_dlp.extractor",
    "yt_dlp.networking",
    "yt_dlp.postprocessor",
):
    hiddenimports += collect_submodules(package)

a = Analysis(
    [str(entry_point)],
    pathex=[str(backend_root), str(repository_root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "pytest",
        "unittest.mock",
        "tkinter",
    ],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="TikTokDarenAssistantBackend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="TikTokDarenAssistantBackend",
)
