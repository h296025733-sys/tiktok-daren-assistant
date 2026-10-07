import os
import sys
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


def pytest_configure() -> None:
    os.environ.setdefault(
        "TIKTOK_ASSISTANT_DB_PATH",
        str(BACKEND_ROOT.parent / "data" / "automated_test.db"),
    )
