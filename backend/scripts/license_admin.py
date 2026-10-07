from __future__ import annotations

import argparse
import json

from app.license.storage import (
    generate_activation_keys,
    initialize_license_database,
    list_license_records,
    reset_key,
    revoke_key,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="TikTok 达人助手设备授权管理")
    commands = parser.add_subparsers(dest="command", required=True)
    generate = commands.add_parser("generate", help="生成一次性设备激活码")
    generate.add_argument("--count", type=int, default=1)
    generate.add_argument("--label-prefix", default="员工设备")
    commands.add_parser("list", help="查看激活码绑定状态")
    revoke = commands.add_parser("revoke", help="停用一个激活码")
    revoke.add_argument("key_id", type=int)
    reset = commands.add_parser("reset", help="清除旧设备绑定，使激活码可重新使用")
    reset.add_argument("key_id", type=int)
    args = parser.parse_args()
    initialize_license_database()
    if args.command == "generate":
        print("\n".join(generate_activation_keys(args.count, args.label_prefix)))
    elif args.command == "list":
        print(json.dumps([record.__dict__ for record in list_license_records()], ensure_ascii=False, indent=2))
    elif args.command == "revoke":
        revoke_key(args.key_id)
        print(f"已停用授权 #{args.key_id}")
    elif args.command == "reset":
        reset_key(args.key_id)
        print(f"已清除授权 #{args.key_id} 的旧设备绑定")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

