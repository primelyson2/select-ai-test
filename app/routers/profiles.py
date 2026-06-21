"""기능요구사항01 (메뉴 [2] AI Profile Test) — 실제 ADB 호출.

- /profiles, /profiles/{name}/attributes : USER_CLOUD_AI_PROFILES, USER_CLOUD_AI_PROFILE_ATTRIBUTES
- /profiles/benchmark : DBMS_CLOUD_AI.GENERATE 를 profile_name × iterations 로 반복 호출
- /profiles/{name}/objects : 메뉴 [1] (Object Meta) 용 stub — Step 4 에서 교체
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

import json

from app import db
from app.deps import current_db

logger = logging.getLogger(__name__)

router = APIRouter(tags=["profiles"])

_DATA_DIR = Path(__file__).resolve().parent.parent.parent
# region 드롭다운 후보 — project/regions.txt (한 줄 1개, '#' 주석/빈 줄 무시)
REGIONS_FILE = _DATA_DIR / "regions.txt"
# region 별 model 후보 — project/models.txt ('#region' 섹션 헤더 + 모델 줄)
MODELS_FILE = _DATA_DIR / "models.txt"


@router.get("/regions")
async def list_regions() -> list[str]:
    try:
        lines = REGIONS_FILE.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        logger.warning("regions.txt 읽기 실패: %s", exc)
        return []
    seen: list[str] = []
    for line in lines:
        r = line.strip()
        if not r or r.startswith("#") or r in seen:
            continue
        seen.append(r)
    return seen


@router.get("/models")
async def list_models() -> dict[str, list[str]]:
    """region -> 사용 가능한 model 목록. '#region' 헤더로 섹션을 구분한다."""
    try:
        lines = MODELS_FILE.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        logger.warning("models.txt 읽기 실패: %s", exc)
        return {}
    result: dict[str, list[str]] = {}
    current: list[str] | None = None
    for line in lines:
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            body = s[1:]
            # '#region' = 섹션 헤더 / '# 주석' · '##' = 주석(섹션 영향 없음)
            if body and not body[0].isspace() and not body.startswith("#"):
                current = result.setdefault(body.strip(), [])
            continue
        if current is not None and s not in current:
            current.append(s)
    return result


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


_GENERATE_SQL = (
    "SELECT DBMS_CLOUD_AI.GENERATE(prompt => :p, profile_name => :pn, action => :a) AS r "
    "FROM dual"
)
_SET_MODEL_SQL = (
    "BEGIN DBMS_CLOUD_AI.SET_ATTRIBUTE("
    "profile_name => :pn, attribute_name => 'model', attribute_value => :av); END;"
)


async def _run_iterations(database: str, prompt: str, profile_name: str,
                          action: str, iterations: int) -> list[dict]:
    """한 Profile 에 대해 iterations 회 GENERATE 를 호출하고 회차별 측정값을 반환."""
    runs: list[dict] = []
    for i in range(1, iterations + 1):
        # 회차 번호만큼 '.' 을 prompt 끝에 추가 — LLM/캐시 동일 입력 제거용
        prompt_i = prompt + ("." * i)
        t0 = time.perf_counter()
        try:
            row = await db.fetch_one(database, _GENERATE_SQL, p=prompt_i, pn=profile_name, a=action)
            t1 = time.perf_counter()
            runs.append({
                "iteration": i,
                "elapsed_ms": int((t1 - t0) * 1000),
                "response": (row or {}).get("r") or "",
                "error": None,
            })
        except Exception as exc:
            t1 = time.perf_counter()
            msg = str(exc).strip().splitlines()[0] if str(exc).strip() else "execution failed"
            logger.warning("benchmark cell failed: db=%s profile=%s iter=%d: %s",
                           database, profile_name, i, msg)
            runs.append({
                "iteration": i,
                "elapsed_ms": int((t1 - t0) * 1000),
                "response": "",
                "error": msg,
            })
    return runs


def _summarize(runs: list[dict], **extra) -> dict:
    ok = [r["elapsed_ms"] for r in runs if r["error"] is None]
    return {
        **extra,
        "runs": runs,
        "avg_ms": int(sum(ok) / len(ok)) if ok else None,
        "min_ms": min(ok) if ok else None,
        "max_ms": max(ok) if ok else None,
    }


@router.post("/profiles/benchmark")
async def benchmark(payload: dict, database: str = Depends(current_db)) -> dict:
    prompt = (payload.get("prompt") or "").strip()
    action = (payload.get("action") or "chat").strip()
    iterations = max(1, min(int(payload.get("iterations") or 1), 10))
    if not prompt:
        raise HTTPException(status_code=400, detail={"error": "prompt required"})

    profile_name = (payload.get("profile_name") or "").strip()
    models = [m for m in (payload.get("models") or []) if m]

    # 모델 비교 모드 — 단일 Profile 의 model 속성을 선택한 모델로 바꿔가며 측정
    if profile_name and models:
        # 측정 종료 후 복원할 원래 model 백업
        orig_rows = await db.fetch_all(
            database,
            "SELECT attribute_value FROM USER_CLOUD_AI_PROFILE_ATTRIBUTES "
            "WHERE profile_name = :n AND attribute_name = 'model'",
            n=profile_name,
        )
        orig_model = orig_rows[0].get("attribute_value") if orig_rows else None

        results: list[dict] = []
        try:
            for model in models:
                try:
                    await db.execute(database, _SET_MODEL_SQL, pn=profile_name, av=model)
                except Exception as exc:
                    # model 변경 자체가 실패하면 해당 모델의 모든 회차를 오류로 기록하고 계속
                    msg = str(exc).strip().splitlines()[0] if str(exc).strip() else "set model failed"
                    logger.warning("benchmark set model failed: db=%s profile=%s model=%s: %s",
                                   database, profile_name, model, msg)
                    runs = [{"iteration": i, "elapsed_ms": 0, "response": "", "error": msg}
                            for i in range(1, iterations + 1)]
                    results.append(_summarize(runs, profile_name=profile_name, model=model))
                    continue
                runs = await _run_iterations(database, prompt, profile_name, action, iterations)
                results.append(_summarize(runs, profile_name=profile_name, model=model))
        finally:
            # 원래 model 로 복원 (실패해도 측정 결과는 반환)
            if orig_model is not None:
                try:
                    await db.execute(database, _SET_MODEL_SQL, pn=profile_name, av=orig_model)
                except Exception as exc:
                    logger.error("benchmark restore model failed: db=%s profile=%s model=%s: %s",
                                 database, profile_name, orig_model, exc)
        return {"iterations": iterations, "profile_name": profile_name,
                "restored_model": orig_model, "results": results}

    # 기존 모드 — 여러 Profile 을 그대로 비교 (개별 Profile 테스트 모달이 사용)
    profile_names = payload.get("profile_names") or []
    if not profile_names:
        raise HTTPException(status_code=400, detail={"error": "profile_name+models or profile_names required"})
    results = []
    for pn in profile_names:
        runs = await _run_iterations(database, prompt, pn, action, iterations)
        results.append(_summarize(runs, profile_name=pn))
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
