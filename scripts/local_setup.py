"""Offline first-run configuration: no API calls, web endpoint or main import."""
from __future__ import annotations
import argparse
from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps/server"))
from app.passwords import hash_password


class SetupError(Exception):
    pass


def check_path(path: Path) -> None:
    for item in (path, *path.parents):
        if item.is_symlink() or (hasattr(item, "is_junction") and item.is_junction()):
            raise SetupError("配置目录存在链接或重定向，请在实际项目目录中配置。")


def settings(root: Path, environ=None) -> dict:
    check_path(root / ".env")
    values = dict(dotenv_values(root / ".env", interpolate=False))
    values.update(os.environ if environ is None else environ)
    return values


def database_path(root: Path, values: dict) -> Path:
    expected = root / "data/ai_interview.db"
    configured = values.get("DATABASE_URL", "")
    if configured and configured != f"sqlite:///{expected}":
        raise SetupError("已配置自定义数据库。为避免修改错误的账号库，请使用管理员命令行工具配置。")
    if values.get("APP_ENV", "development").lower() == "production":
        raise SetupError("此窗口仅用于本地开发，生产部署请按安全说明配置。")
    check_path(expected)
    return expected


def has_admin(database: Path) -> bool:
    if not database.exists():
        return False
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").fetchone():
            return False
        return connection.execute("SELECT 1 FROM users WHERE role='admin' LIMIT 1").fetchone() is not None


def setup_status(root: Path, environ=None) -> dict:
    values = settings(root, environ)
    database = database_path(root, values)
    key = (values.get("DEEPSEEK_API_KEY") or "").strip()
    legacy = root / "api/api.txt"
    check_path(legacy)
    if not key and legacy.is_file():
        key = legacy.read_text(encoding="utf-8-sig").strip().removeprefix("DEEPSEEK_API_KEY=").strip()
    return {"key_configured": bool(key), "admin_configured": has_admin(database)}


def protect_file(path: Path) -> None:
    if os.name == "nt":
        result = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        sid = re.search(rb"S-1-5-[0-9-]+", result.stdout)
        if result.returncode or not sid:
            raise SetupError("无法确认本机文件权限，未保存密钥。")
        result = subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", f"*{sid.group().decode()}:(F)", "*S-1-5-18:(F)", "*S-1-5-32-544:(F)"], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode:
            raise SetupError("无法限制配置文件权限，未保存密钥。")
    else:
        path.chmod(0o600)


def updated_env(text: str, key: str) -> str:
    lines = [line for line in text.splitlines() if not re.match(r"^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=", line)]
    return "\n".join(lines).rstrip() + f"\nDEEPSEEK_API_KEY={key}\n"


def configure(root: Path, *, key="", username="", password="", confirmation="", environ=None) -> dict:
    root = root.absolute()
    current = setup_status(root, environ)
    database = database_path(root, settings(root, environ))
    key = key.strip()
    if key and not re.fullmatch(r"sk-[A-Za-z0-9_-]{16,180}", key):
        raise SetupError("Key 格式不正确：请粘贴完整的 sk- 开头密钥，不是网址、SDK 或请求示例。")
    if key and (os.environ if environ is None else environ).get("DEEPSEEK_API_KEY"):
        raise SetupError("系统环境变量已设置 Key，优先级高于文件。请先在系统中调整；本窗口不会保存无效的覆盖配置。")
    if not current["key_configured"] and not key:
        raise SetupError("请填写你自己的 DeepSeek API Key。")
    if not current["admin_configured"]:
        if not re.fullmatch(r"[A-Za-z0-9_@.\-]{3,64}", username):
            raise SetupError("账号须为 3–64 位英文字母、数字或 _ @ . -。")
        if not 12 <= len(password) <= 128 or not re.search(r"[A-Za-z]", password) or not re.search(r"\d", password):
            raise SetupError("新管理员密码须为 12–128 位，同时包含字母和数字。")
        # The login payload trims outer whitespace. Reject instead of creating
        # an account whose saved hash can never match its login payload.
        if password != password.strip() or any(ord(char) < 32 or ord(char) == 127 for char in password):
            raise SetupError("密码首尾不能有空白，也不能包含换行或控制字符；中间可以使用普通空格。")
        if password != confirmation:
            raise SetupError("两次输入的密码不一致。")
    lock = root / ".setup.lock"
    check_path(lock)
    try:
        lock_fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise SetupError("另一个窗口正在保存。若上次异常退出，请确认没有配置进程后移除 .setup.lock。") from None
    staged = None
    try:
        if key:
            env_path = root / ".env"
            content = env_path.read_text(encoding="utf-8-sig") if env_path.exists() else "# Local private settings; never publish.\n"
            fd, name = tempfile.mkstemp(prefix=".env.setup-", dir=root)
            os.close(fd)
            staged = Path(name)
            protect_file(staged)  # Restrict ACL BEFORE writing the key.
            with staged.open("w", encoding="utf-8", newline="\n") as handle:
                handle.write(updated_env(content, key))
                handle.flush()
                os.fsync(handle.fileno())
        created = False
        if not current["admin_configured"]:
            database.parent.mkdir(parents=True, exist_ok=True)
            with closing(sqlite3.connect(database, timeout=10)) as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username VARCHAR(64) NOT NULL, display_name VARCHAR(80) NOT NULL, password_hash VARCHAR(255) NOT NULL, role VARCHAR(20) NOT NULL, created_at DATETIME NOT NULL)")
                connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username ON users (username)")
                if not connection.execute("SELECT 1 FROM users WHERE role='admin' LIMIT 1").fetchone():
                    if connection.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
                        raise SetupError("该账号已存在，配置窗口不会将普通用户提升为管理员。请换一个账号。")
                    connection.execute("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)", (username, "管理员", hash_password(password), "admin", datetime.now(timezone.utc).replace(tzinfo=None).isoformat(" ")))
                    created = True
                connection.commit()
        if staged:
            # Retry after a failed rename preserves the already created admin.
            os.replace(staged, root / ".env")
            staged = None
        return {"admin_created": created, "key_saved": bool(key)}
    finally:
        if staged:
            staged.unlink(missing_ok=True)
        os.close(lock_fd)
        lock.unlink(missing_ok=True)


def show_window(root: Path, *, preview=False) -> int:
    import tkinter as tk
    from tkinter import messagebox, ttk
    current = {"key_configured": False, "admin_configured": False} if preview else setup_status(root)
    window = tk.Tk()
    window.title("AI数字人面试 · 首次配置" + ("（只读预览）" if preview else ""))
    window.geometry("660x650")
    window.minsize(640, 630)
    window.configure(bg="#f6f3ee")
    style = ttk.Style(window)
    style.theme_use("clam")
    style.configure("TFrame", background="#f6f3ee")
    style.configure("TLabel", background="#f6f3ee", font=("Microsoft YaHei UI", 10))
    style.configure("Title.TLabel", font=("Microsoft YaHei UI", 20, "bold"), foreground="#225a50")
    style.configure("TButton", font=("Microsoft YaHei UI", 11), padding=10)
    frame = ttk.Frame(window, padding=28)
    frame.pack(fill="both", expand=True)
    ttk.Label(frame, text="欢迎建立你的面试练习空间", style="Title.TLabel").pack(anchor="w", pady=(0, 12))
    ttk.Label(frame, text="这是部署者配置窗口，不是学生登录窗口。\n只保存在这台电脑；不会联网验证，也不会产生 API 费用。", wraplength=590).pack(anchor="w", pady=(0, 16))
    variables = {}
    fields = [("key", "DeepSeek API Key" + ("（已配置；留空保留）" if current["key_configured"] else ""), True), ("username", "管理员账号" + ("（已有账号，不会重置）" if current["admin_configured"] else ""), False), ("password", "管理员密码（至少 12 位，含字母数字，首尾无空白）", True), ("confirmation", "再次输入密码", True)]
    for name, label, hidden in fields:
        ttk.Label(frame, text=label).pack(anchor="w", pady=(8, 4))
        var = tk.StringVar(value="admin" if name == "username" and not current["admin_configured"] else "")
        variables[name] = var
        entry = ttk.Entry(frame, textvariable=var, show="●" if hidden else "", font=("Microsoft YaHei UI", 11))
        entry.pack(fill="x", ipady=5)
        if name != "key" and current["admin_configured"]:
            entry.configure(state="disabled")
    ttk.Label(frame, text="Key 是服务商密钥，不是 ChatGPT 会员。真实面试按你的 API 账户计费。\n管理员密码只保存加盐哈希；请勿把 .env、数据库、简历或录像发到 GitHub。\n配置完成不代表数字人已就绪：模型与已获授权的人物素材需另行准备。", wraplength=590, foreground="#526861").pack(anchor="w", pady=16)
    result = [2]

    def save():
        if preview:
            messagebox.showinfo("只读预览", "预览模式不会写入 Key、账号或数据库。", parent=window)
            return
        try:
            configure(root, **{name: var.get() for name, var in variables.items()})
        except SetupError as exc:
            messagebox.showerror("未完成配置", str(exc), parent=window)
            return
        except Exception:
            messagebox.showerror("未完成配置", "保存失败，请检查磁盘空间、文件权限或数据库是否忙碌。已有管理员不会被覆盖，可重试。", parent=window)
            return
        for var in variables.values():
            var.set("")
        result[0] = 0
        messagebox.showinfo("配置完成", "已在本机保存。运行中的服务需要重启后读取新 Key；本次未调用付费 API。", parent=window)
        window.destroy()

    buttons = ttk.Frame(frame)
    buttons.pack(fill="x", pady=(4, 0))
    ttk.Button(buttons, text="保存并继续" if not preview else "只读预览 · 不会保存", command=save).pack(side="right")
    ttk.Button(buttons, text="取消", command=window.destroy).pack(side="right", padx=10)
    window.mainloop()
    return result[0]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--if-needed", action="store_true")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()
    try:
        if args.preview:
            return show_window(ROOT, preview=True)
        state = setup_status(ROOT)
        if args.status:
            print(json.dumps(state))  # Booleans only, NEVER values.
            return 0
        if args.if_needed and all(state.values()):
            return 0
        return show_window(ROOT)
    except SetupError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception:
        print("配置窗口无法运行。请确认 Python 带 tkinter，依赖已安装，数据库与文件权限正常。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
