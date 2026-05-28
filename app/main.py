"""FastAPI 엔트리 — 다중 ADB 풀 초기화 + static / API 라우팅."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import db, deps
from app.config import load_config
from app.routers import agents, databases, objects, profiles

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")

# 프로젝트 루트(project/) — app/ 의 부모
PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = PROJECT_ROOT / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = load_config()
    deps.set_config(cfg)
    # 풀 병렬 초기화 — 한 항목 실패가 다른 항목을 막지 않음
    await asyncio.gather(*(db.init_pool(d) for d in cfg.databases))
    try:
        yield
    finally:
        await db.close_all()


app = FastAPI(title="Oracle AI Database Test Tool", lifespan=lifespan)

app.include_router(databases.router, prefix="/api")
app.include_router(profiles.router, prefix="/api")
app.include_router(agents.router, prefix="/api")
app.include_router(objects.router, prefix="/api")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
