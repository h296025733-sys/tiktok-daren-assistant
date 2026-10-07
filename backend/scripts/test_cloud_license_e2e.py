from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.request
from pathlib import Path

from scripts.cloud_license_admin import call as admin_call
from scripts.cloud_license_admin import load_config


EXTENSION_ID = "kpdocbejchofflefehdlphffcbdmphij"
EXTENSION_ORIGIN = f"chrome-extension://{EXTENSION_ID}"
KEY_PATTERN = re.compile(r"TDA(?:-?[A-Z0-9]){32}")


def main() -> int:
    parser = argparse.ArgumentParser(description="真实公网设备授权回归测试")
    parser.add_argument("key_file", type=Path)
    args = parser.parse_args()
    activation_key = read_first_key(args.key_file)
    device_a = identity("a", "A")
    device_b = identity("b", "B")
    key_id: int | None = None
    try:
        status, first = public_call(
            "/api/v1/license/activate",
            {"activation_key": activation_key, **device_a},
        )
        assert status == 200 and first.get("authorized") is True, (status, first)
        key_id = int(first["key_id"])

        status, validated = public_call("/api/v1/license/validate", device_a)
        assert status == 200 and validated.get("authorized") is True, (status, validated)

        status, rejected = public_call(
            "/api/v1/license/activate",
            {"activation_key": activation_key, **device_b},
        )
        assert status == 409 and rejected.get("ok") is False, (status, rejected)

        status, foreign = public_call(
            "/api/v1/license/validate",
            device_a,
            origin="https://attacker.example",
        )
        assert status == 403 and foreign.get("ok") is False, (status, foreign)
        print("公网测试通过：首次绑定、同机验证、第二台拦截、来源限制均符合预期")
    finally:
        if key_id is not None:
            admin_call("POST", f"/api/v1/admin/licenses/{key_id}/reset", {})
            status, invalid_after_reset = public_call("/api/v1/license/validate", device_a)
            assert status == 200 and invalid_after_reset.get("authorized") is False
            print(f"测试密钥 #{key_id} 已自动解绑并恢复为可用状态")
    return 0


def identity(device_character: str, secret_character: str) -> dict[str, str]:
    return {
        "device_id": device_character * 32,
        "device_secret": secret_character * 43,
        "extension_id": EXTENSION_ID,
        "extension_version": "0.1.28",
    }


def public_call(path: str, payload: dict, origin: str = EXTENSION_ORIGIN) -> tuple[int, dict]:
    api_base = load_config()["api_base"].rstrip("/")
    request = urllib.request.Request(
        f"{api_base}{path}",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Origin": origin,
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
            ),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, decode_response(response.read())
    except urllib.error.HTTPError as error:
        return error.code, decode_response(error.read())


def decode_response(raw: bytes) -> dict:
    text = raw.decode("utf-8", errors="replace")
    try:
        value = json.loads(text)
        return value if isinstance(value, dict) else {"raw": text[:200]}
    except json.JSONDecodeError:
        return {"raw": text[:200]}


def read_first_key(path: Path) -> str:
    text = path.read_text(encoding="utf-8-sig").upper()
    match = KEY_PATTERN.search(text)
    if not match:
        raise SystemExit(f"文件中没有找到激活码：{path}")
    return re.sub(r"[^A-Z0-9]", "", match.group(0))


if __name__ == "__main__":
    raise SystemExit(main())
