"""Serve the local rehearsal script only after administrator authentication."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import JSONResponse


MAX_DEMO_SCRIPT_BYTES = 2 * 1024 * 1024


def _validated_script(value: object) -> dict:
    if not isinstance(value, dict):
        raise ValueError("Expected script object")
    if any(not isinstance(value.get(key), str) or not value[key].strip()
           for key in ("title", "candidate", "target_role")):
        raise ValueError("Missing script metadata")
    turns = value.get("turns")
    if not isinstance(turns, list) or not 1 <= len(turns) <= 100:
        raise ValueError("Invalid script turns")
    for turn in turns:
        if not isinstance(turn, dict):
            raise ValueError("Invalid turn object")
        if any(not isinstance(turn.get(key), str) or not turn[key].strip()
               for key in ("question", "answer")):
            raise ValueError("Missing turn text")
        if "answer_summary" in turn and not isinstance(turn["answer_summary"], str):
            raise ValueError("Invalid answer summary")
    return value


def install_admin_demo_routes(
    app: FastAPI,
    admin_dependency: Callable,
    script_path: Path,
) -> None:
    """The caller supplies its normal administrator authentication dependency."""
    @app.get("/api/admin/demo-script")
    def admin_demo_script(admin=Depends(admin_dependency)):
        if getattr(admin, "role", None) != "admin":
            raise HTTPException(403, "需要管理员权限")
        try:
            with script_path.open("rb") as source:
                content = source.read(MAX_DEMO_SCRIPT_BYTES + 1)
            if len(content) > MAX_DEMO_SCRIPT_BYTES:
                raise ValueError("Script exceeds local size limit")
            script = _validated_script(json.loads(content.decode("utf-8-sig")))
        except (OSError, ValueError, UnicodeError):
            # Do not reveal local paths, private text or parser exception details.
            raise HTTPException(503, "管理员剧本暂不可用，请检查本机剧本配置") from None
        return JSONResponse(script, headers={
            "Cache-Control": "no-store",
            "Vary": "Authorization",
            "X-Content-Type-Options": "nosniff",
        })
