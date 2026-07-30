"""Chat설정(savedConfigs) 서버 파일 저장 — 메뉴별·DB별.

각 메뉴의 Chat설정 목록을 project/chat_configs/<db_name>/<menu>.json 에 보관한다.
(localStorage 대체. 저장 형태는 프런트가 쓰던 배열 그대로.)
"""
from __future__ import annotations

import json
import re

from fastapi import APIRouter, Body, Depends, HTTPException

from app import config, deps

router = APIRouter(tags=["chat-config"])

# 파일로 관리하는 메뉴 화이트리스트 (프런트 MENU 토큰과 일치)
ALLOWED = {"nl2sql", "aiChat", "aiChatTl"}
CONFIG_DIR = config.PROJECT_ROOT / "chat_configs"
_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _path(db_name: str, menu: str):
    if menu not in ALLOWED:
        raise HTTPException(status_code=404, detail={"error": "unknown menu", "menu": menu})
    # db_name 은 current_db 가 검증하지만 경로 안전을 위해 재확인
    if not _NAME_RE.match(db_name):
        raise HTTPException(status_code=400, detail={"error": "invalid database name", "database": db_name})
    return CONFIG_DIR / db_name / f"{menu}.json"


@router.get("/chat-configs/{menu}")
async def get_configs(menu: str, db_name: str = Depends(deps.current_db)) -> list:
    p = _path(db_name, menu)
    if not p.exists():
        return []
    try:
        with p.open(encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


@router.put("/chat-configs/{menu}")
async def put_configs(menu: str, payload: list = Body(...), db_name: str = Depends(deps.current_db)) -> dict:
    p = _path(db_name, menu)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return {"ok": True}
