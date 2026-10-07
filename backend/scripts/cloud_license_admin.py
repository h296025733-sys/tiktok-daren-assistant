from __future__ import annotations

import argparse
import json
import sqlite3
import urllib.error
import urllib.request
from pathlib import Path

from app.license.storage import generate_activation_keys, get_license_database_path


CONFIG_PATH = Path(__file__).resolve().parents[2] / "data" / "cloud_license_admin.json"


def main() -> int:
    parser = argparse.ArgumentParser(description="TikTok 达人助手云端设备授权管理")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list", help="查看云端激活码状态")
    commands.add_parser("sync", help="把本机数据库里的密钥摘要同步到云端")
    generate = commands.add_parser("generate", help="本机生成新密钥并同步到云端")
    generate.add_argument("--count", type=int, default=1)
    generate.add_argument("--label-prefix", default="员工设备")
    revoke = commands.add_parser("revoke", help="停用一个云端授权")
    revoke.add_argument("key_id", type=int)
    reset = commands.add_parser("reset", help="解绑设备，让该密钥可以重新绑定")
    reset.add_argument("key_id", type=int)
    args = parser.parse_args()

    if args.command == "generate":
        keys = generate_activation_keys(args.count, args.label_prefix)
        sync_local_records()
        print("下面是新生成的密钥；明文只会在这里显示，请单独保存：")
        print("\n".join(keys))
        return 0
    if args.command == "sync":
        count = sync_local_records()
        print(f"已把本机的 {count} 个密钥摘要同步到云端（没有上传明文密钥）")
        return 0
    if args.command == "list":
        response = call("GET", "/api/v1/admin/licenses")
        print(json.dumps(response.get("licenses", []), ensure_ascii=False, indent=2))
        return 0
    if args.command in {"revoke", "reset"}:
        response = call("POST", f"/api/v1/admin/licenses/{args.key_id}/{args.command}", {})
        print(json.dumps(response, ensure_ascii=False, indent=2))
        return 0
    return 1


def sync_local_records() -> int:
    database_path = get_license_database_path()
    if not database_path.exists():
        raise SystemExit(f"本机密钥数据库不存在：{database_path}")
    with sqlite3.connect(database_path) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            "SELECT key_hash, label FROM activation_keys ORDER BY id"
        ).fetchall()
    keys = [{"key_hash": row["key_hash"], "label": row["label"]} for row in rows]
    call("POST", "/api/v1/admin/keys/import", {"keys": keys})
    return len(keys)


def call(method: str, path: str, payload: dict | None = None) -> dict:
    config = load_config()
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{config['api_base'].rstrip('/')}{path}",
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {config['admin_token']}",
            "Content-Type": "application/json",
            "User-Agent": "TDA-License-Admin/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise SystemExit(f"云端返回 HTTP {error.code}：{detail}") from error
    except OSError as error:
        raise SystemExit(f"连接云端授权服务失败：{error}") from error
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise SystemExit(f"云端返回异常：{result}")
    return result


def load_config() -> dict[str, str]:
    if not CONFIG_PATH.exists():
        raise SystemExit(f"缺少主控配置：{CONFIG_PATH}")
    value = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    api_base = str(value.get("api_base", ""))
    admin_token = str(value.get("admin_token", ""))
    if not api_base.startswith("https://") or len(admin_token) < 32:
        raise SystemExit("主控配置中的 api_base 或 admin_token 不正确")
    return {"api_base": api_base, "admin_token": admin_token}


if __name__ == "__main__":
    raise SystemExit(main())
