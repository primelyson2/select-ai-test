"""AI Chat 답변 피드백(좋음/나쁨 + 사유) — 앱 레벨 기능.

접속 사용자 스키마의 T_AICHAT_FEEDBACK 에 **team_exec_id(= RUN_TEAM 1회 = 답변 1회) 단위**로 저장한다.
멀티턴(한 대화에 답변 여럿)에서도 답변별로 구분되며, Agent History 목록(team_exec_id 단위)과 1:1 매핑된다.
Select AI 자체 DBMS_CLOUD_AI.FEEDBACK(profiles, NL2SQL 학습용)과는 **무관한 별개 기능**이다.

- POST   /api/feedback            업서트(MERGE by team_exec_id) — 신규 등록·수정 공용
- GET    /api/feedback/{teid}     단건(없으면 {})
- DELETE /api/feedback/{teid}     삭제
- POST   /api/feedback/by-execs   {ids:[team_exec_id...]} → {teid:{rating,reason}} 맵(목록 배지용, batch)

테이블은 23ai `CREATE TABLE IF NOT EXISTS` 로 멱등 자동생성(nl2sql.py 패턴). DDL 은 Prerequisites.md 에도 문서화.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.deps import current_db
from app.plsql import first_line

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/feedback", tags=["feedback"])

# 접속 스키마의 답변 피드백 테이블(멱등 생성). team_exec_id 는 UNIQUE = 관리 단위.
_ENSURE_DDL = (
    "CREATE TABLE IF NOT EXISTS T_AICHAT_FEEDBACK ("
    " ID              NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,"
    " TEAM_EXEC_ID    VARCHAR2(64) NOT NULL,"
    " CONVERSATION_ID VARCHAR2(64),"
    " RATING          VARCHAR2(10) NOT NULL,"
    " REASON          VARCHAR2(4000),"
    " INS_DTM         TIMESTAMP DEFAULT SYSTIMESTAMP,"
    " MOD_DTM         TIMESTAMP DEFAULT SYSTIMESTAMP,"
    " CONSTRAINT UQ_AICHAT_FEEDBACK UNIQUE (TEAM_EXEC_ID))"
)

_MERGE_SQL = (
    "MERGE INTO T_AICHAT_FEEDBACK t USING (SELECT :teid AS teid FROM dual) s "
    "ON (t.TEAM_EXEC_ID = s.teid) "
    "WHEN MATCHED THEN UPDATE SET RATING=:rating, REASON=:reason, "
    " CONVERSATION_ID=:cid, MOD_DTM=SYSTIMESTAMP "
    "WHEN NOT MATCHED THEN INSERT (TEAM_EXEC_ID, CONVERSATION_ID, RATING, REASON) "
    " VALUES (:teid, :cid, :rating, :reason)"
)

_GET_SQL = (
    "SELECT TEAM_EXEC_ID, CONVERSATION_ID, RATING, REASON "
    "FROM T_AICHAT_FEEDBACK WHERE TEAM_EXEC_ID = :teid"
)

_DELETE_SQL = "DELETE FROM T_AICHAT_FEEDBACK WHERE TEAM_EXEC_ID = :teid"


async def _ensure_table(database: str) -> None:
    await db.execute(database, _ENSURE_DDL)


@router.post("")
async def upsert_feedback(payload: dict, database: str = Depends(current_db)) -> dict:
    """좋음/나쁨 + 사유 업서트(team_exec_id 당 1행). 신규 등록·수정 공용."""
    teid = (payload.get("team_exec_id") or "").strip()
    rating = (payload.get("rating") or "").strip().upper()
    if not teid:
        raise HTTPException(status_code=400, detail={"error": "team_exec_id 는 필수입니다"})
    if rating not in ("GOOD", "BAD"):
        raise HTTPException(status_code=400, detail={"error": "rating 은 GOOD|BAD 여야 합니다"})
    binds = {
        "teid": teid,
        "cid": (payload.get("conversation_id") or "") or None,
        "rating": rating,
        "reason": (payload.get("reason") or "") or None,
    }
    try:
        await _ensure_table(database)
        await db.execute(database, _MERGE_SQL, **binds)
    except Exception as exc:
        raise HTTPException(status_code=400, detail={"error": first_line(exc)})
    return {"ok": True}


@router.get("/{team_exec_id}")
async def get_feedback(team_exec_id: str, database: str = Depends(current_db)) -> dict:
    """단건 조회 — 미평가/테이블 미생성이면 화면이 뜨도록 빈 dict."""
    try:
        await _ensure_table(database)
        row = await db.fetch_one(database, _GET_SQL, teid=team_exec_id)
    except Exception as exc:
        logger.warning("feedback get failed: db=%s teid=%s: %s", database, team_exec_id, first_line(exc))
        return {}
    return row or {}


@router.delete("/{team_exec_id}")
async def delete_feedback(team_exec_id: str, database: str = Depends(current_db)) -> dict:
    try:
        await _ensure_table(database)
        await db.execute(database, _DELETE_SQL, teid=team_exec_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail={"error": first_line(exc)})
    return {"ok": True}


@router.post("/by-execs")
async def feedback_by_execs(payload: dict, database: str = Depends(current_db)) -> dict:
    """목록 배지 채우기용 — team_exec_id 목록을 받아 {teid:{rating,reason}} 맵으로.
    실패(테이블 미생성 등)해도 목록은 표시되도록 빈 맵을 돌려준다."""
    ids = [str(x) for x in (payload.get("ids") or []) if x]
    if not ids:
        return {}
    # oracledb 는 IN 절 리스트 바인드를 전개하지 않으므로 :b0,:b1,... 로 펼친다.
    holders = ",".join(f":b{i}" for i in range(len(ids)))
    binds = {f"b{i}": v for i, v in enumerate(ids)}
    try:
        await _ensure_table(database)
        rows = await db.fetch_all(
            database,
            f"SELECT TEAM_EXEC_ID, RATING, REASON FROM T_AICHAT_FEEDBACK "
            f"WHERE TEAM_EXEC_ID IN ({holders})",
            **binds,
        )
    except Exception as exc:
        logger.warning("feedback by-execs failed: db=%s: %s", database, first_line(exc))
        return {}
    return {r["team_exec_id"]: {"rating": r.get("rating"), "reason": r.get("reason")} for r in rows}
