from __future__ import annotations

from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import threading


PROJECT_ROOT = Path(__file__).resolve().parents[3]
WORD_CONVERSION_SCRIPT = PROJECT_ROOT / "scripts" / "convert-docx-to-pdf.ps1"
CONVERSION_TIMEOUT_SECONDS = int(os.getenv("DOCUMENT_CONVERSION_TIMEOUT_SECONDS", "120"))
_word_conversion_lock = threading.Lock()


class DocumentConversionError(RuntimeError):
    pass


def _libreoffice_executable() -> Path | None:
    configured = os.getenv("LIBREOFFICE_EXE", "").strip()
    candidates = [
        Path(configured) if configured else None,
        Path(shutil.which("soffice") or "") if shutil.which("soffice") else None,
        Path(r"C:\Program Files\LibreOffice\program\soffice.exe"),
        Path(r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"),
    ]
    return next((item for item in candidates if item and item.is_file()), None)


def _word_is_available() -> bool:
    allow_word = os.getenv("ALLOW_MICROSOFT_WORD_PREVIEW", "0").strip().lower()
    if allow_word not in {"1", "true", "yes", "on"}:
        return False
    if os.name != "nt" or not WORD_CONVERSION_SCRIPT.is_file():
        return False
    return any(path.is_file() for path in (
        Path(r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE"),
        Path(r"C:\Program Files (x86)\Microsoft Office\root\Office16\WINWORD.EXE"),
    ))


def _run(command: list[str], *, timeout: int = CONVERSION_TIMEOUT_SECONDS) -> subprocess.CompletedProcess[str]:
    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        return subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=creation_flags,
        )
    except subprocess.TimeoutExpired as exc:
        raise DocumentConversionError("DOCX 转换超时") from exc
    except OSError as exc:
        raise DocumentConversionError("无法启动 DOCX 转换器") from exc


def _convert_with_libreoffice(executable: Path, source: Path, target: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="ai-interview-lo-profile-") as profile_dir:
        result = _run([
            str(executable),
            "--headless",
            f"-env:UserInstallation={Path(profile_dir).resolve().as_uri()}",
            "--convert-to",
            "pdf",
            "--outdir",
            str(target.parent),
            str(source),
        ])
    generated = target.parent / f"{source.stem}.pdf"
    if result.returncode != 0 or not generated.is_file():
        detail = (result.stderr or result.stdout or "未知错误").strip()[-600:]
        raise DocumentConversionError(f"LibreOffice 转换失败：{detail}")
    if generated.resolve() != target.resolve():
        generated.replace(target)


def _convert_with_word(source: Path, target: Path) -> None:
    with _word_conversion_lock:
        result = _run([
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(WORD_CONVERSION_SCRIPT),
            "-InputPath",
            str(source),
            "-OutputPath",
            str(target),
        ])
    if result.returncode != 0 or not target.is_file():
        detail = (result.stderr or result.stdout or "未知错误").strip()[-600:]
        raise DocumentConversionError(f"Microsoft Word 转换失败：{detail}")


def convert_docx_to_pdf(source: Path, target: Path) -> str:
    """Convert the actual DOCX to PDF and return the renderer identity."""
    source = source.resolve()
    target = target.resolve()
    if not source.is_file():
        raise DocumentConversionError("待预览的 DOCX 文件不存在")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.unlink(missing_ok=True)

    if executable := _libreoffice_executable():
        _convert_with_libreoffice(executable, source, target)
        renderer = "libreoffice"
    elif _word_is_available():
        _convert_with_word(source, target)
        renderer = "microsoft-word"
    else:
        raise DocumentConversionError(
            "未找到 LibreOffice，无法生成真实 Word 预览；Microsoft Word 后台转换默认关闭"
        )

    if target.stat().st_size < 1_000:
        target.unlink(missing_ok=True)
        raise DocumentConversionError("DOCX 转换结果无效")
    return renderer
