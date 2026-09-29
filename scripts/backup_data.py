"""Create a consistent local backup without copying secrets."""

from __future__ import annotations

from contextlib import closing
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from dotenv import load_dotenv
from sqlalchemy.engine import make_url


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
BACKUP_ROOT = ROOT / "backups"
load_dotenv(ROOT / ".env")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def copy_runtime_files(source_dir: Path, destination_dir: Path) -> None:
    """Copy stable runtime files, excluding hidden state and symlinks."""
    if not source_dir.exists():
        return

    for source in source_dir.rglob("*"):
        relative = source.relative_to(source_dir)
        if any(part.startswith(".") for part in relative.parts):
            continue
        if source.is_symlink() or not source.is_file():
            continue

        destination = destination_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(2):
            hash_before = sha256_file(source)
            shutil.copy2(source, destination)
            hash_after = sha256_file(source)
            if hash_before == hash_after == sha256_file(destination):
                break
            destination.unlink(missing_ok=True)
            if attempt:
                raise RuntimeError(f"文件在备份过程中持续变化：{source.name}")


def backup_sqlite(source_path: Path, destination_path: Path) -> None:
    """Use SQLite's online backup API and close handles before renaming."""
    with (
        closing(sqlite3.connect(source_path, timeout=30)) as source,
        closing(sqlite3.connect(destination_path)) as target,
    ):
        source.backup(target)
        integrity = target.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise RuntimeError(f"数据库备份完整性校验失败：{integrity}")

def configured_database_path() -> Path:
    configured = os.getenv("DATABASE_URL", "").strip()
    if not configured:
        return DATA_DIR / "ai_interview.db"
    url = make_url(configured)
    if url.get_backend_name() != "sqlite" or not url.database or url.database == ":memory:":
        raise SystemExit("备份工具当前只支持文件型 SQLite DATABASE_URL。")
    database = Path(url.database)
    return database if database.is_absolute() else (ROOT / "apps" / "server" / database).resolve()

def ensure_service_stopped() -> None:
    try:
        with urlopen("http://127.0.0.1:8000/api/health", timeout=0.8):
            pass
    except HTTPError as exc:
        raise SystemExit("为保证录像与数据库一致，请先运行“一键停止”，再创建备份。") from exc
    except URLError:
        return
    raise SystemExit("为保证录像与数据库一致，请先运行“一键停止”，再创建备份。")


def main() -> int:
    ensure_service_stopped()
    source_database = configured_database_path()
    if not source_database.exists():
        raise SystemExit("尚未找到 data/ai_interview.db，没有可备份的数据。")

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
    staging = BACKUP_ROOT / f".{stamp}.tmp"
    destination = BACKUP_ROOT / stamp
    backup_root_resolved = BACKUP_ROOT.resolve()
    if (
        staging.resolve().parent != backup_root_resolved
        or destination.resolve().parent != backup_root_resolved
    ):
        raise SystemExit("备份目录解析异常，已停止操作。")
    if staging.exists() or destination.exists():
        raise SystemExit(f"备份目录已经存在：{destination}")

    estimated = sum(
        path.stat().st_size
        for path in DATA_DIR.rglob("*")
        if path.is_file() and not path.is_symlink()
    )
    if shutil.disk_usage(BACKUP_ROOT).free < estimated + 256 * 1024 * 1024:
        raise SystemExit("磁盘空间不足，无法安全创建备份。")

    try:
        backup_data = staging / "data"
        backup_data.mkdir(parents=True)
        backup_sqlite(source_database, backup_data / "ai_interview.db")

        copy_runtime_files(DATA_DIR / "uploads", backup_data / "uploads")
        copy_runtime_files(DATA_DIR / "recordings", backup_data / "recordings")

        files = []
        for path in sorted(staging.rglob("*")):
            if path.is_file():
                files.append(
                    {
                        "path": path.relative_to(staging).as_posix(),
                        "size": path.stat().st_size,
                        "sha256": sha256_file(path),
                    }
                )
        (staging / "manifest.json").write_text(
            json.dumps(
                {
                    "created_at": datetime.now().astimezone().isoformat(),
                    "project": "AI数字人面试",
                    "contains_credentials": False,
                    "contains_personal_data": True,
                    "source_database": source_database.name,
                    "files": files,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        staging.replace(destination)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        raise

    print(f"备份完成：{destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
