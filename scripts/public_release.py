"""Allowlisted source export and offline publication gate. Standard library only.

Never upload, rotate keys, modify Git history or delete the working project.
Diagnostics contain file paths and rule names, not matched sensitive values.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
MAX_FILE = 8 * 1024 * 1024
MAX_TOTAL = 40 * 1024 * 1024
ALLOWED_SUFFIXES = {".py", ".js", ".jsx", ".mjs", ".cjs", ".css", ".html", ".json", ".md", ".txt", ".toml", ".lock", ".yaml", ".yml", ".ps1", ".sh", ".cmd", ".bat", ".example", ".template", ".patch", ".svg"}
ALLOWED_SUFFIXES.update({".gitignore", ".service"})
ALLOWED_NAMES = {"LICENSE", ".gitignore", ".gitattributes"}
PRIVATE_PARTS = {"api", "data", "logs", "backups", "outputs", "output", "tmp", "packages", "node_modules", "dist", "__pycache__", ".venv", "deliverables"}
RULES = {
    "provider-secret": re.compile(r"\b(?:sk|ghp|gho|github_pat|hf)-?[A-Za-z0-9_\-]{24,}\b"),
    "aws-access-key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "jwt-token": re.compile(r"\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}"),
    "private-key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "private-email": re.compile(r"[A-Za-z0-9_.+\-]+@(?:qq|163|126|gmail|outlook|hotmail|icloud)\.com", re.I),
    "personal-phone": re.compile(r"(?<![\dA-Za-z])1[3-9]\d{9}(?![\dA-Za-z])"),
    "personal-computer-path": re.compile(r"[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|<)[A-Za-z0-9_.\-]+", re.I),
    "literal-credential": re.compile(r'''(?im)^[ \t]*(?:DEEPSEEK_API_KEY|VIDU_API_KEY|JWT_SECRET|ADMIN_INITIAL_PASSWORD|TURN_CREDENTIAL)[ \t]*=[ \t]*["']?(?!CHANGE_|replace-)[A-Za-z0-9_./+\-]{20,}'''),
}
PATCH_FILES = ["app.py", "avatars/wav2lip/genavatar.py", "avatars/wav2lip/inference_silence.py", "avatars/wav2lip_avatar.py", "server/asr_server.py", "server/routes.py", "server/rtc_manager.py", "server/session_manager.py", "server/webrtc.py"]
UPSTREAM_COMMIT = "a5a77f4c395c8347789a16da1843cd1b08b48eea"


class ReleaseError(Exception):
    pass


def safe_path(root: Path, relative: str) -> Path:
    rel = PurePosixPath(relative)
    if not relative or "\\" in relative or ":" in relative or rel.is_absolute() or any(x in {".", ".."} for x in relative.split("/")):
        raise ReleaseError("unsafe-relative-path")
    current = root
    for part in rel.parts:
        current = current / part
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            raise ReleaseError("linked-path")
    if not current.resolve().is_relative_to(root.resolve()):
        raise ReleaseError("path-escape")
    return current


def check_name(relative: str) -> list[str]:
    path = PurePosixPath(relative)
    parts = tuple(part.casefold() for part in path.parts)
    name = path.name.casefold()
    findings = []
    # src/data contains public JSON schemas, unlike the runtime data directory.
    if parts[0] in PRIVATE_PARTS or any(x in {"node_modules", "dist", "__pycache__", ".git", ".venv"} for x in parts):
        findings.append("private-or-generated-directory")
    if name.startswith(".env") and not name.endswith(".example"):
        findings.append("private-env")
    if path.name not in ALLOWED_NAMES and path.suffix.casefold() not in ALLOWED_SUFFIXES:
        findings.append("unreviewed-file-type")
    if any(part in {".jwt_secret", ".setup.lock"} for part in parts):
        findings.append("private-runtime-file")
    return findings


def inspect_bytes(relative: str, blob: bytes, known_private=()) -> list[dict]:
    issues = [{"path": relative, "rule": rule} for rule in check_name(relative)]
    if len(blob) > MAX_FILE:
        return issues + [{"path": relative, "rule": "file-too-large-to-review"}]
    try:
        content = blob.decode("utf-8-sig")
    except UnicodeError:
        return issues + [{"path": relative, "rule": "binary-or-unknown-encoding"}]
    if "\0" in content:
        issues.append({"path": relative, "rule": "binary-content"})
    for name, pattern in RULES.items():
        for match in pattern.finditer(content):
            issues.append({"path": relative, "rule": name, "line": content.count("\n", 0, match.start()) + 1})
    if any(value and value in content for value in known_private):
        issues.append({"path": relative, "rule": "known-local-private-value"})
    return issues


def private_values(root: Path) -> set[str]:
    # Remain local/in-memory; no values or hashes are put in the publication report.
    values = set()
    for relative in ("api/api.txt", "api/vidu_api.txt", "data/.jwt_secret", ".env"):
        path = safe_path(root, relative)
        if not path.exists():
            continue
        if path.stat().st_size > MAX_FILE:
            raise ReleaseError("private-config-too-large")
        text = path.read_text(encoding="utf-8-sig")
        for line in text.splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if relative == ".env" and not re.match(r"\s*\w*(?:KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL)\w*\s*=", line, re.I):
                continue
            value = line.split("=", 1)[-1].strip().strip("\"'")
            if len(value) >= 8:
                values.add(value)
        values.update(re.findall(r"[A-Za-z0-9_-]{28,}", text))
    markers = safe_path(root, "data/release-private-markers.json")
    if markers.exists():
        values.update(value for value in json.loads(markers.read_text(encoding="utf-8")) if isinstance(value, str) and len(value) >= 3)
    demo = safe_path(root, "apps/web/src/data/adminInterviewScript.json")
    if demo.exists() and not (root / "PUBLIC_RELEASE_MANIFEST.json").exists():
        candidate = json.loads(demo.read_text(encoding="utf-8-sig")).get("candidate")
        if candidate:
            values.add(candidate)
    return values


def load_entries(root: Path) -> list[dict]:
    entries = json.loads(safe_path(root, "release/public-files.json").read_text(encoding="utf-8"))
    targets = set()
    for item in entries:
        target = item["target"]
        safe_path(root, item["source"])
        safe_path(root, target)
        if target.casefold() in targets:
            raise ReleaseError("duplicate-target")
        targets.add(target.casefold())
    return entries


def collect(root: Path) -> dict[str, bytes]:
    files = {}
    for item in load_entries(root):
        path = safe_path(root, item["source"])
        if not path.is_file() or path.stat().st_size > MAX_FILE:
            raise ReleaseError("missing-or-oversized-source: " + item["source"])
        files[item["target"]] = path.read_bytes()
    integration = root / "integrations/LiveTalking"
    if (integration / ".git").exists():
        # Include only locally modified text patches, not a third-party repository or its assets.
        for name in PATCH_FILES:
            safe_path(integration, name)
        result = subprocess.run(["git", "-C", str(integration), "rev-parse", "HEAD"], capture_output=True)
        if result.returncode or result.stdout.decode().strip() != UPSTREAM_COMMIT:
            raise ReleaseError("LiveTalking-base-changed-review-required")
        result = subprocess.run(["git", "-C", str(integration), "diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--", *PATCH_FILES], capture_output=True)
        if result.returncode:
            raise ReleaseError("LiveTalking-patch-export-failed")
        files["release/patches/livetalking-local.patch"] = result.stdout
        files["release/patches/LiveTalking-LICENSE.txt"] = safe_path(integration, "LICENSE").read_bytes()
    else:
        # Re-export of an already published source tree.
        for name in ("livetalking-local.patch", "LiveTalking-LICENSE.txt"):
            path = safe_path(root, "release/patches/" + name)
            if path.exists():
                files["release/patches/" + name] = path.read_bytes()
    return files


def validate(files: dict[str, bytes], known_private=()) -> list[dict]:
    issues = []
    if sum(map(len, files.values())) > MAX_TOTAL:
        issues.append({"path": ".", "rule": "source-export-too-large"})
    for name, blob in sorted(files.items()):
        issues.extend(inspect_bytes(name, blob, known_private))
    return issues


def export(root: Path, destination: Path | None = None) -> dict:
    files = collect(root)
    issues = validate(files, private_values(root))
    if issues:
        return {"ok": False, "issues": issues, "files": len(files)}
    report = {"ok": True, "files": len(files), "bytes": sum(map(len, files.values())), "issues": [], "scope": "allowlisted UTF-8 source; no model/media/runtime data; not a full Git history audit"}
    if destination is None:
        return report
    # Never overwrite another export or copy into the working source/dependency trees.
    destination = destination.absolute()
    for path in (destination, *destination.parents):
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            raise ReleaseError("linked-output-directory")
    if destination.exists() or destination == root or root.is_relative_to(destination):
        raise ReleaseError("output-must-be-new-directory")
    if destination.is_relative_to(root) and not destination.is_relative_to(root / "packages"):
        raise ReleaseError("in-project-exports-must-be-under-packages")
    destination.mkdir(parents=True, exist_ok=False)
    # Files already scanned in memory: a source edit during copying cannot slip through.
    for relative, blob in files.items():
        path = safe_path(destination, relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as handle:
            handle.write(blob)
    manifest = {**report, "created_at": datetime.now(timezone.utc).isoformat(), "sha256": {name: hashlib.sha256(blob).hexdigest() for name, blob in sorted(files.items())}}
    (destination / "PUBLIC_RELEASE_MANIFEST.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {**report, "destination": str(destination)}


def check_tree(root: Path) -> dict:
    if not root.is_dir() or root.is_symlink() or (hasattr(root, "is_junction") and root.is_junction()):
        return {"ok": False, "files": 0, "issues": [{"path": ".", "rule": "missing-or-linked-root"}]}
    files = {}
    issues = []
    total_bytes = 0
    def walk_error(_error):
        # os.walk otherwise silently skips unreadable directories and may report
        # a misleading clean scan. Do not echo arbitrary exception contents.
        issues.append({"path": ".", "rule": "unreadable-directory"})

    for folder, directories, filenames in os.walk(root, followlinks=False, onerror=walk_error):
        for name in list(directories):
            path = Path(folder) / name
            if name == ".git" and path.parent == root:
                directories.remove(name)
                continue  # Git history requires a separate explicit review.
            if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
                directories.remove(name)
                issues.append({"path": path.relative_to(root).as_posix(), "rule": "linked-directory"})
        for name in filenames:
            path = Path(folder) / name
            relative = path.relative_to(root).as_posix()
            try:
                checked = safe_path(root, relative)
                if checked.stat().st_size > MAX_FILE:
                    issues.append({"path": relative, "rule": "file-too-large-to-review"})
                else:
                    total_bytes += checked.stat().st_size
                    if total_bytes > MAX_TOTAL or len(files) >= 5000:
                        return {"ok": False, "files": len(files), "issues": issues + [{"path": relative, "rule": "scan-budget-exceeded"}]}
                    files[relative] = checked.read_bytes()
            except (OSError, ReleaseError):
                issues.append({"path": relative, "rule": "unreadable-or-linked-file"})
    issues += validate(files)
    return {"ok": not issues, "files": len(files), "issues": issues}


def main() -> int:
    parser = argparse.ArgumentParser(description="离线源码发布检查；不会上传或修改原始私密文件")
    parser.add_argument("--output", type=Path, help="新建精简源码目录；不覆盖已有目录")
    parser.add_argument("--check-tree", type=Path, help="扫描整个待上传源码目录（不扫描 .git 历史）")
    args = parser.parse_args()
    try:
        report = check_tree(args.check_tree.absolute()) if args.check_tree else export(ROOT, args.output)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if report["ok"] else 1
    except (ReleaseError, OSError, ValueError, KeyError):
        print(json.dumps({"ok": False, "error": "发布检查中止：文件缺失、路径不安全、目标已存在或配置不完整；未上传任何内容。"}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
