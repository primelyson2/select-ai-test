"""GET /api/databases — 등록된 ADB 목록 + 풀 상태.

비밀 필드 (user/password/wallet_password 등) 는 절대 응답에 포함하지 않는다.
"""
from __future__ import annotations

from fastapi import APIRouter

from app import db, deps

router = APIRouter(tags=["databases"])


@router.get("/databases")
async def list_databases() -> list[dict]:
    cfg = deps.get_config()
    if cfg is None:
        return []
    return [
        {
            "name": d.name,
            "label": d.label,
            "status": "ok" if db.statuses.get(d.name) == "ok" else "unavailable",
        }
        for d in cfg.databases
    ]
