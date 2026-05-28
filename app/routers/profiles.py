"""기능요구사항01 (메뉴 [2] AI Profile Test) — 실제 ADB 호출.

- /profiles, /profiles/{name}/attributes : USER_CLOUD_AI_PROFILES, USER_CLOUD_AI_PROFILE_ATTRIBUTES
- /profiles/benchmark : DBMS_CLOUD_AI.GENERATE 를 profile_name × iterations 로 반복 호출
- /profiles/{name}/objects : 메뉴 [1] (Object Meta) 용 stub — Step 4 에서 교체
"""
from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Depends, HTTPException

import json

from app import db
from app.deps import current_db

logger = logging.getLogger(__name__)

router = APIRouter(tags=["profiles"])


@router.get("/profiles")
async def list_profiles(database: str = Depends(current_db)) -> list[dict]:
    # has_object_list: USER_CLOUD_AI_PROFILE_ATTRIBUTES 에 object_list 행이 있으면 'Y'
    return await db.fetch_all(
        database,
        "SELECT p.profile_name, p.status, p.description, "
        "       CASE WHEN EXISTS ( "
        "         SELECT 1 FROM USER_CLOUD_AI_PROFILE_ATTRIBUTES a "
        "          WHERE a.profile_name = p.profile_name "
        "            AND a.attribute_name = 'object_list' "
        "       ) THEN 'Y' ELSE 'N' END AS has_object_list "
        "  FROM USER_CLOUD_AI_PROFILES p "
        " ORDER BY p.profile_name",
    )


@router.get("/profiles/{name}/attributes")
async def profile_attributes(name: str, database: str = Depends(current_db)) -> list[dict]:
    return await db.fetch_all(
        database,
        "SELECT attribute_name, attribute_value "
        "FROM USER_CLOUD_AI_PROFILE_ATTRIBUTES "
        "WHERE profile_name = :name "
        "ORDER BY attribute_name",
        name=name,
    )


@router.put("/profiles/{name}/attributes/{attribute_name}")
async def set_profile_attribute(
    name: str,
    attribute_name: str,
    payload: dict,
    database: str = Depends(current_db),
) -> dict:
    value = payload.get("value", "")
    if value is None:
        value = ""
    if not isinstance(value, str):
        value = str(value)
    try:
        await db.execute(
            database,
            "BEGIN DBMS_CLOUD_AI.SET_ATTRIBUTE("
            "profile_name => :pn, "
            "attribute_name => :an, "
            "attribute_value => :av); END;",
            pn=name,
            an=attribute_name,
            av=value,
        )
    except Exception as exc:
        msg = str(exc).strip().splitlines()[0] if str(exc).strip() else "execution failed"
        logger.warning("SET_ATTRIBUTE failed: db=%s profile=%s attr=%s: %s",
                       database, name, attribute_name, msg)
        raise HTTPException(status_code=400, detail={"error": msg})
    return {"ok": True, "profile_name": name, "attribute_name": attribute_name}


@router.post("/profiles/benchmark")
async def benchmark(payload: dict, database: str = Depends(current_db)) -> dict:
    prompt = (payload.get("prompt") or "").strip()
    action = (payload.get("action") or "chat").strip()
    profile_names = payload.get("profile_names") or []
    iterations = int(payload.get("iterations") or 1)
    if not prompt:
        raise HTTPException(status_code=400, detail={"error": "prompt required"})
    if not profile_names:
        raise HTTPException(status_code=400, detail={"error": "profile_names required"})
    iterations = max(1, min(iterations, 10))

    sql = (
        "SELECT DBMS_CLOUD_AI.GENERATE(prompt => :p, profile_name => :pn, action => :a) AS r "
        "FROM dual"
    )

    results: list[dict] = []
    for pn in profile_names:
        runs: list[dict] = []
        for i in range(1, iterations + 1):
            # 회차 번호만큼 '.' 을 prompt 끝에 추가 — LLM/캐시 동일 입력 제거용
            prompt_i = prompt + ("." * i)
            t0 = time.perf_counter()
            try:
                row = await db.fetch_one(database, sql, p=prompt_i, pn=pn, a=action)
                t1 = time.perf_counter()
                resp = (row or {}).get("r") or ""
                runs.append({
                    "iteration": i,
                    "elapsed_ms": int((t1 - t0) * 1000),
                    "response": resp,
                    "error": None,
                })
            except Exception as exc:
                t1 = time.perf_counter()
                msg = str(exc).strip().splitlines()[0] if str(exc).strip() else "execution failed"
                logger.warning("benchmark cell failed: db=%s profile=%s iter=%d: %s",
                               database, pn, i, msg)
                runs.append({
                    "iteration": i,
                    "elapsed_ms": int((t1 - t0) * 1000),
                    "response": "",
                    "error": msg,
                })
        ok = [r["elapsed_ms"] for r in runs if r["error"] is None]
        results.append({
            "profile_name": pn,
            "runs": runs,
            "avg_ms": int(sum(ok) / len(ok)) if ok else None,
            "min_ms": min(ok) if ok else None,
            "max_ms": max(ok) if ok else None,
        })
    return {"iterations": iterations, "results": results}


# --- 메뉴 [1] (Object Meta) — Profile 의 object_list + 각 테이블 코멘트 요약 ---
@router.get("/profiles/{name}/objects")
async def profile_objects(name: str, database: str = Depends(current_db)) -> list[dict]:
    rows = await db.fetch_all(
        database,
        "SELECT attribute_value FROM USER_CLOUD_AI_PROFILE_ATTRIBUTES "
        "WHERE profile_name = :name AND attribute_name = 'object_list'",
        name=name,
    )
    if not rows:
        return []
    raw = rows[0].get("attribute_value") or ""
    try:
        items = json.loads(raw) if raw else []
    except json.JSONDecodeError as e:
        logger.warning("object_list JSON parse failed for profile=%s: %s", name, e)
        return []
    if not isinstance(items, list) or not items:
        return []

    # (owner, table) 쌍을 한 번에 JOIN — N+1 방지
    # FROM JSON_TABLE 로 클라이언트 owner/name 쌍과 ALL_TAB_COMMENTS 조인
    payload_json = json.dumps(items)
    sql = (
        "SELECT j.owner, j.name AS table_name, c.comments "
        "  FROM JSON_TABLE(:payload, '$[*]' "
        "         COLUMNS (owner VARCHAR2(128) PATH '$.owner', "
        "                  name  VARCHAR2(128) PATH '$.name')) j "
        "  LEFT JOIN ALL_TAB_COMMENTS c "
        "    ON UPPER(c.owner) = UPPER(j.owner) "
        "   AND UPPER(c.table_name) = UPPER(j.name)"
    )
    joined = await db.fetch_all(database, sql, payload=payload_json)
    return [
        {
            "owner": r.get("owner"),
            "table": r.get("table_name"),
            "table_comment": r.get("comments") or "",
        }
        for r in joined
    ]
