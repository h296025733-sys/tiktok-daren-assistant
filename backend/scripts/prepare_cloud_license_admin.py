from __future__ import annotations

import argparse
import hashlib
import json
import secrets
from pathlib import Path


CONFIG_PATH = Path(__file__).resolve().parents[2] / "data" / "cloud_license_admin.json"


def main() -> int:
    parser = argparse.ArgumentParser(description="准备 TikTok 达人助手云端授权主控配置")
    parser.add_argument("--api-base", default="")
    args = parser.parse_args()

    current: dict[str, str] = {}
    if CONFIG_PATH.exists():
        loaded = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            current = {str(key): str(value) for key, value in loaded.items()}

    token = current.get("admin_token") or secrets.token_urlsafe(48)
    api_base = args.api_base.rstrip("/") or current.get("api_base", "")
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(
        json.dumps({"api_base": api_base, "admin_token": token}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(hashlib.sha256(token.encode("utf-8")).hexdigest())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
