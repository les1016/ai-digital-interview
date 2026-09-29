"""Verify and restore a local backup while keeping a rollback snapshot."""

from __future__ import annotations

from contextlib import closing
from datetime import datetime
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import uuid

try:
    from scripts.backup_data import (
        BACKUP_ROOT,
        DATA_DIR,
        ROOT,
        configured_database_path,
        ensure_service_stopped,
        sha256_file,
    )
except ModuleNotFoundError:
    from backup_data import (
        BACKUP_ROOT,
        DATA_DIR,
        ROOT,
        configured_database_path,
        ensure_service_stopped,
        sha256_file,
    )


def resolve_backup(argument: str | None) -> Path:
    backup_root = BACKUP_ROOT.resolve()
    if argument:
        candidate = Path(argument)
        if not candidate.is_absolute():
            candidate = BACKUP_ROOT / candidate
        candidate = candidate.resolve()
    else:
        choices = sorted(
            (
                path.resolve()
                for path in BACKUP_ROOT.glob("*")
                if path.is_dir() and not path.name.startswith(".")
            ),
            reverse=True,
        )
        if not choices:
            raise SystemExit("没有找到可恢复的备份。")
        candidate = choices[0]
    if candidate == backup_root or backup_root not in candidate.parents:
        raise SystemExit("恢复路径必须位于项目 backups 目录内。")
    if not candidate.is_dir():
        raise SystemExit(f"备份目录不存在：{candidate}")
    return candidate


def verified_manifest(backup: Path) -> list[tuple[Path, Path]]:
    manifest_path = backup / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit("备份 manifest.json 缺失或损坏。") from exc
    entries = manifest.get("files")
    if not isinstance(entries, list):
        raise SystemExit("备份清单缺少 files 数组。")

    verified: list[tuple[Path, Path]] = []
    seen: set[str] = set()
    backup_resolved = backup.resolve()
    for entry in entries:
        if not isinstance(entry, dict):
            raise SystemExit("备份清单包含无效条目。")
        relative_text = entry.get("path")
        expected_size = entry.get("size")
        expected_hash = entry.get("sha256")
        if (
            not isinstance(relative_text, str)
            or not isinstance(expected_size, int)
            or expected_size < 0
            or not isinstance(expected_hash, str)
            or len(expected_hash) != 64
        ):
            raise SystemExit("备份清单包含无效字段。")
        relative = Path(relative_text)
        if relative.is_absolute() or ".." in relative.parts or relative_text in seen:
            raise SystemExit(f"备份清单路径不安全或重复：{relative_text}")
        source_path = backup / relative
        source = source_path.resolve()
        if backup_resolved not in source.parents or source_path.is_symlink() or not source.is_file():
            raise SystemExit(f"备份文件缺失或路径不安全：{relative_text}")
        if source.stat().st_size != expected_size or sha256_file(source) != expected_hash:
            raise SystemExit(f"备份文件校验失败：{relative_text}")
        if not relative.parts or relative.parts[0] != "data":
            raise SystemExit(f"恢复工具拒绝清单中的非 data 文件：{relative_text}")
        seen.add(relative_text)
        verified.append((source, Path(*relative.parts[1:])))
    if "data/ai_interview.db" not in seen:
        raise SystemExit("备份清单缺少 data/ai_interview.db。")
    return verified


def verify_sqlite(path: Path) -> None:
    with closing(sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)) as connection:
        result = connection.execute("PRAGMA integrity_check").fetchone()[0]
    if result != "ok":
        raise SystemExit(f"恢复数据库完整性校验失败：{result}")


def main(argument: str | None = None) -> int:
    ensure_service_stopped()
    backup = resolve_backup(argument)
    entries = verified_manifest(backup)

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    stage = ROOT / f".data-restore-{uuid.uuid4().hex}.tmp"
    previous_data = ROOT / f"data.before-restore-{stamp}"
    if stage.resolve().parent != ROOT.resolve() or previous_data.resolve().parent != ROOT.resolve():
        raise SystemExit("恢复临时目录解析异常。")
    if stage.exists() or previous_data.exists():
        raise SystemExit("恢复临时目录已经存在。")

    required = sum(source.stat().st_size for source, _ in entries)
    if shutil.disk_usage(ROOT).free < required + 512 * 1024 * 1024:
        raise SystemExit("磁盘空间不足，无法保留可回滚快照并恢复。")

    stage.mkdir()
    try:
        for source, relative in entries:
            destination = stage / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            if destination.stat().st_size != source.stat().st_size or sha256_file(destination) != sha256_file(source):
                raise RuntimeError(f"恢复暂存文件校验失败：{relative.as_posix()}")
        staged_database = stage / "ai_interview.db"
        verify_sqlite(staged_database)

        configured_database = configured_database_path().resolve()
        default_database = (DATA_DIR / "ai_interview.db").resolve()
        external_database = configured_database != default_database
        external_stage = None
        previous_external = None
        if external_database:
            configured_database.parent.mkdir(parents=True, exist_ok=True)
            external_stage = configured_database.with_name(
                f".{configured_database.name}.restore-{uuid.uuid4().hex}.tmp"
            )
            previous_external = configured_database.with_name(
                f"{configured_database.name}.before-restore-{stamp}"
            )
            shutil.copy2(staged_database, external_stage)
            verify_sqlite(external_stage)
            staged_database.unlink()

        data_moved = False
        external_moved = False
        try:
            if DATA_DIR.exists():
                DATA_DIR.replace(previous_data)
                data_moved = True
            stage.replace(DATA_DIR)
            if external_database:
                if configured_database.exists():
                    configured_database.replace(previous_external)
                    external_moved = True
                external_stage.replace(configured_database)
        except Exception:
            if external_database and external_moved and previous_external.exists():
                configured_database.unlink(missing_ok=True)
                previous_external.replace(configured_database)
            if DATA_DIR.exists():
                failed_restore = ROOT / f".data-restore-failed-{uuid.uuid4().hex}"
                DATA_DIR.replace(failed_restore)
                shutil.rmtree(failed_restore, ignore_errors=True)
            if data_moved and previous_data.exists():
                previous_data.replace(DATA_DIR)
            raise

        verify_sqlite(configured_database)
    except Exception:
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)
        raise

    print(f"恢复完成：{backup}")
    if previous_data.exists():
        print(f"恢复前数据保留在：{previous_data}")
    print("请运行一键启动并检查 /api/health；确认无误后再手动清理恢复前快照。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else None))
