"""다중 ADB 비동기 풀 관리 (python-oracledb Thin mode + Wallet/mTLS).

- pools: DB 이름 → AsyncConnectionPool
- statuses: DB 이름 → 'ok' | 'unavailable'   (실패한 풀도 상태로 노출)
- init_pool 한 항목 실패가 다른 항목을 막지 않는다.
- fetch_all / fetch_one / execute 헬퍼는 CLOB 을 자동으로 문자열화한다.
"""
from __future__ import annotations

import logging
from typing import Any

import oracledb

from app.config import DatabaseConfig

logger = logging.getLogger(__name__)

pools: dict[str, oracledb.AsyncConnectionPool] = {}
statuses: dict[str, str] = {}


async def _maybe_read_lob(val: Any) -> Any:
    """LOB 객체이면 read() 결과를, 아니면 원본 그대로 반환."""
    if val is None:
        return None
    read = getattr(val, "read", None)
    # str/bytes 는 read 메서드가 있어도 LOB 가 아님
    if callable(read) and not isinstance(val, (str, bytes, bytearray)):
        try:
            result = read()
            # async LOB 이면 coroutine — await
            if hasattr(result, "__await__"):
                return await result
            return result
        except Exception:
            return val
    return val


async def init_pool(db: DatabaseConfig) -> None:
    """단일 DB 풀 초기화 + ping 검증. 실패 시 status='unavailable'."""
    try:
        kwargs: dict[str, Any] = {
            "user": db.user,
            "password": db.password,
            "dsn": db.dsn,
            "min": 1,
            "max": 8,
            "increment": 1,
        }
        if db.wallet_location:
            kwargs["wallet_location"] = db.wallet_location
        if db.wallet_password:
            kwargs["wallet_password"] = db.wallet_password
        if db.config_dir:
            kwargs["config_dir"] = db.config_dir
        pool = oracledb.create_pool_async(**kwargs)
        # ping 으로 실제 연결 검증
        async with pool.acquire() as conn:
            await conn.ping()
        pools[db.name] = pool
        statuses[db.name] = "ok"
        logger.info("DB pool ready: %s", db.name)
    except Exception as exc:
        statuses[db.name] = "unavailable"
        logger.exception("DB pool init failed for %s: %s", db.name, exc)


async def close_all() -> None:
    for name, pool in list(pools.items()):
        try:
            await pool.close(force=True)
        except Exception:
            logger.exception("DB pool close failed: %s", name)
    pools.clear()
    statuses.clear()


def get_pool(db_name: str) -> oracledb.AsyncConnectionPool:
    if db_name not in pools:
        raise KeyError(db_name)
    return pools[db_name]


async def fetch_all(db_name: str, sql: str, **binds: Any) -> list[dict]:
    pool = get_pool(db_name)
    async with pool.acquire() as conn:
        with conn.cursor() as cur:
            await cur.execute(sql, binds)
            cols = [d[0].lower() for d in (cur.description or [])]
            rows = await cur.fetchall()
            out: list[dict] = []
            for row in rows:
                item: dict[str, Any] = {}
                for col, val in zip(cols, row):
                    item[col] = await _maybe_read_lob(val)
                out.append(item)
            return out


async def fetch_one(db_name: str, sql: str, **binds: Any) -> dict | None:
    pool = get_pool(db_name)
    async with pool.acquire() as conn:
        with conn.cursor() as cur:
            await cur.execute(sql, binds)
            cols = [d[0].lower() for d in (cur.description or [])]
            row = await cur.fetchone()
            if row is None:
                return None
            return {col: await _maybe_read_lob(val) for col, val in zip(cols, row)}


async def execute(db_name: str, sql: str, **binds: Any) -> None:
    pool = get_pool(db_name)
    async with pool.acquire() as conn:
        with conn.cursor() as cur:
            await cur.execute(sql, binds)
        await conn.commit()
