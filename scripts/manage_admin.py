"""Create, update, or remove a local administrator without hardcoding passwords."""

from __future__ import annotations

import argparse
import getpass
import os
from pathlib import Path
import sys

from sqlalchemy import select

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "server"))

from app.main import SessionLocal, User, hash_password, setup_database  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="AI数字人面试管理员账号工具")
    parser.add_argument("--username", default=os.getenv("ADMIN_USERNAME", "admin"))
    parser.add_argument("--display-name", default="管理员")
    parser.add_argument("--password-env", default="ADMIN_INITIAL_PASSWORD")
    parser.add_argument("--delete", action="store_true")
    args = parser.parse_args()

    setup_database()
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username == args.username))
        if args.delete:
            if not user:
                print("账号不存在，无需删除。")
                return 0
            db.delete(user)
            db.commit()
            print(f"已删除测试管理员账号：{args.username}")
            return 0

        password = os.getenv(args.password_env, "")
        if not password:
            password = getpass.getpass("请输入管理员密码（输入不会显示）: ")
        if len(password) < 6:
            raise SystemExit("管理员密码至少需要 6 位。")

        if user:
            user.display_name = args.display_name
            user.password_hash = hash_password(password)
            user.role = "admin"
            action = "已更新"
        else:
            db.add(User(
                username=args.username,
                display_name=args.display_name,
                password_hash=hash_password(password),
                role="admin",
            ))
            action = "已创建"
        db.commit()
        print(f"{action}管理员账号：{args.username}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
