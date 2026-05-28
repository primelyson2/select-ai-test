"""기능요구사항02 (메뉴 [3] AI Agent Team Test) — 실제 DB 호출.

조회:
- /agents/teams                                    팀 목록
- /agents/teams/{name}                             팀 상세 (Agents + Tasks)
- /agents/{name}, /agents/tasks/{name}, /agents/tools/{name}  속성 그리드용 상세

실행:
- POST /agents/teams/run                           CREATE_CONVERSATION + RUN_TEAM (CLOB OUT)
- GET  /agents/conversations/{conv_id}/timeline    실행 이력 기반 단계별 타임라인 + raw 로그

스키마 메모 (ailakehouse 실제 컬럼 기준):
  USER_AI_AGENT_TEAMS         AGENT_TEAM_ID, AGENT_TEAM_NAME, STATUS, DESCRIPTION (CLOB)
  USER_AI_AGENT_TEAM_ATTRIBUTES   ATTRIBUTE_NAME='agents' → JSON [{"name":"A","task":"T"}]
                                  ATTRIBUTE_NAME='process'
  USER_AI_AGENT_TEAM_HISTORY  TEAM_EXEC_ID, TEAM_NAME, STATE, START_DATE, END_DATE, CONVERSATION_ID
  USER_AI_AGENTS              AGENT_ID, AGENT_NAME, STATUS, DESCRIPTION
  USER_AI_AGENT_ATTRIBUTES    'profile_name', 'role' 등
  USER_AI_AGENT_TASKS         TASK_ID, TASK_NAME
  USER_AI_AGENT_TASK_ATTRIBUTES   'tools' → JSON ["TOOL", ...], 'instruction', 'input'
  USER_AI_AGENT_TASK_HISTORY  TEAM_EXEC_ID, TASK_ORDER, AGENT_NAME, TASK_NAME, STATE, START_DATE, END_DATE
  USER_AI_AGENT_TOOLS         TOOL_ID, TOOL_NAME
  USER_AI_AGENT_TOOL_ATTRIBUTES
  USER_AI_AGENT_TOOL_HISTORY  INVOCATION_ID, TEAM_EXEC_ID, TASK_ORDER, TOOL_NAME, AGENT_NAME, TASK_NAME,
                              START_DATE, END_DATE
  USER_CLOUD_AI_CONVERSATION_PROMPTS  CONVERSATION_PROMPT_ID, CONVERSATION_ID, PROFILE_NAME,
                              PROMPT_ACTION, PROMPT (CLOB), PROMPT_RESPONSE (CLOB), CREATED
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import oracledb
from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.deps import current_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agents", tags=["agents"])


def _first_line(exc: Exception) -> str:
    s = str(exc).strip()
    return s.splitlines()[0] if s else "execution failed"


def _safe_parse_json(raw: Any) -> Any:
    if raw is None or raw == "":
        return None
    if not isinstance(raw, str):
        return raw
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


# ====================================================================
# 조회: 트리
# ====================================================================

@router.get("/teams")
async def list_teams(database: str = Depends(current_db)) -> list[dict]:
    return await db.fetch_all(
        database,
        "SELECT agent_team_name AS name, status, description "
        "FROM USER_AI_AGENT_TEAMS ORDER BY agent_team_name",
    )


# 트리 한 번에 — 5개 쿼리 병렬 실행으로 N×roundtrip 회피
@router.get("/tree")
async def tree(database: str = Depends(current_db)) -> dict:
    teams_rows, team_attr_rows, agent_rows, task_rows, tool_rows = await asyncio.gather(
        db.fetch_all(
            database,
            "SELECT agent_team_name AS name, status, description "
            "FROM USER_AI_AGENT_TEAMS ORDER BY agent_team_name",
        ),
        db.fetch_all(
            database,
            "SELECT agent_team_name AS team_name, attribute_value "
            "FROM USER_AI_AGENT_TEAM_ATTRIBUTES WHERE attribute_name = 'agents'",
        ),
        db.fetch_all(
            database,
            "SELECT agent_name, attribute_name, attribute_value "
            "FROM USER_AI_AGENT_ATTRIBUTES "
            "WHERE attribute_name IN ('role', 'profile_name')",
        ),
        db.fetch_all(
            database,
            "SELECT task_name, attribute_name, attribute_value "
            "FROM USER_AI_AGENT_TASK_ATTRIBUTES "
            "WHERE attribute_name IN ('tools', 'instruction')",
        ),
        db.fetch_all(
            database,
            "SELECT tool_name, attribute_name, attribute_value "
            "FROM USER_AI_AGENT_TOOL_ATTRIBUTES "
            "WHERE attribute_name IN ('tool_type', 'instruction')",
        ),
    )

    team_agents_raw = {r["team_name"]: r["attribute_value"] for r in team_attr_rows}

    agent_attr_map: dict[str, dict] = {}
    for r in agent_rows:
        agent_attr_map.setdefault(r["agent_name"], {})[r["attribute_name"]] = r["attribute_value"]

    task_attr_map: dict[str, dict] = {}
    for r in task_rows:
        task_attr_map.setdefault(r["task_name"], {})[r["attribute_name"]] = r["attribute_value"]

    tool_attr_map: dict[str, dict] = {}
    for r in tool_rows:
        tool_attr_map.setdefault(r["tool_name"], {})[r["attribute_name"]] = r["attribute_value"]

    teams_out: list[dict] = []
    for t in teams_rows:
        name = t["name"]
        agents_json = _safe_parse_json(team_agents_raw.get(name)) or []
        agents: list[dict] = []
        seen_task: set[str] = set()
        task_names: list[str] = []
        for item in agents_json if isinstance(agents_json, list) else []:
            if not isinstance(item, dict):
                continue
            a_name = item.get("name") or ""
            task = item.get("task") or ""
            am = agent_attr_map.get(a_name, {})
            agents.append({
                "name": a_name,
                "tasks": [task] if task else [],
                "role": am.get("role") or "",
                "profile_name": am.get("profile_name") or "",
            })
            if task and task not in seen_task:
                seen_task.add(task)
                task_names.append(task)

        tasks: list[dict] = []
        for tn in task_names:
            tm = task_attr_map.get(tn, {})
            tools_val = _safe_parse_json(tm.get("tools"))
            tools = [str(x) for x in tools_val] if isinstance(tools_val, list) else []
            tasks.append({
                "name": tn,
                "tools": tools,
                "instruction": tm.get("instruction") or "",
            })

        teams_out.append({
            "name": name,
            "status": t.get("status"),
            "description": t.get("description") or "",
            "agents": agents,
            "tasks": tasks,
        })

    tools_meta = {
        n: {
            "tool_type": m.get("tool_type") or "",
            "instruction": m.get("instruction") or "",
        }
        for n, m in tool_attr_map.items()
    }
    return {"teams": teams_out, "tools_meta": tools_meta}


@router.get("/teams/{name}")
async def team_detail(name: str, database: str = Depends(current_db)) -> dict:
    """팀 상세 — 상세 패널용 head + attributes 만.

    트리 빌딩(agents/tasks/tools_meta)은 /api/agents/tree 가 담당한다.
    """
    head_rows, attr_rows = await asyncio.gather(
        db.fetch_all(
            database,
            "SELECT agent_team_name, status, description "
            "FROM USER_AI_AGENT_TEAMS WHERE agent_team_name = :name",
            name=name,
        ),
        db.fetch_all(
            database,
            "SELECT attribute_name, attribute_value FROM USER_AI_AGENT_TEAM_ATTRIBUTES "
            "WHERE agent_team_name = :name ORDER BY attribute_name",
            name=name,
        ),
    )
    if not head_rows:
        raise HTTPException(status_code=404, detail={"error": "team not found", "team": name})
    head = head_rows[0]
    return {
        "name": head["agent_team_name"],
        "status": head.get("status"),
        "description": head.get("description") or "",
        "attributes": attr_rows,
    }


@router.get("/{name}")
async def agent_detail(name: str, database: str = Depends(current_db)) -> dict:
    head_rows, attrs = await asyncio.gather(
        db.fetch_all(
            database,
            "SELECT agent_name, status, description FROM USER_AI_AGENTS WHERE agent_name = :name",
            name=name,
        ),
        db.fetch_all(
            database,
            "SELECT attribute_name, attribute_value FROM USER_AI_AGENT_ATTRIBUTES "
            "WHERE agent_name = :name ORDER BY attribute_name",
            name=name,
        ),
    )
    head = head_rows[0] if head_rows else {"agent_name": name, "status": None, "description": ""}
    return {
        "name": head.get("agent_name"),
        "status": head.get("status"),
        "description": head.get("description") or "",
        "attributes": attrs,
    }


@router.get("/tasks/{name}")
async def task_detail(name: str, database: str = Depends(current_db)) -> dict:
    head_rows, attrs = await asyncio.gather(
        db.fetch_all(
            database,
            "SELECT task_name, status, description FROM USER_AI_AGENT_TASKS WHERE task_name = :name",
            name=name,
        ),
        db.fetch_all(
            database,
            "SELECT attribute_name, attribute_value FROM USER_AI_AGENT_TASK_ATTRIBUTES "
            "WHERE task_name = :name ORDER BY attribute_name",
            name=name,
        ),
    )
    head = head_rows[0] if head_rows else {"task_name": name, "status": None, "description": ""}
    return {
        "name": head.get("task_name"),
        "status": head.get("status"),
        "description": head.get("description") or "",
        "attributes": attrs,
    }


@router.get("/tools/{name}")
async def tool_detail(name: str, database: str = Depends(current_db)) -> dict:
    head_rows, attrs = await asyncio.gather(
        db.fetch_all(
            database,
            "SELECT tool_name, status, description FROM USER_AI_AGENT_TOOLS WHERE tool_name = :name",
            name=name,
        ),
        db.fetch_all(
            database,
            "SELECT attribute_name, attribute_value FROM USER_AI_AGENT_TOOL_ATTRIBUTES "
            "WHERE tool_name = :name ORDER BY attribute_name",
            name=name,
        ),
    )
    head = head_rows[0] if head_rows else {"tool_name": name, "status": None, "description": ""}
    return {
        "name": head.get("tool_name"),
        "status": head.get("status"),
        "description": head.get("description") or "",
        "attributes": attrs,
    }


# ====================================================================
# 속성 수정 — DBMS_CLOUD_AI_AGENT.SET_ATTRIBUTE(object_name, object_type, attribute_name, attribute_value)
# ====================================================================

_SET_ATTR_PLSQL = (
    "BEGIN DBMS_CLOUD_AI_AGENT.SET_ATTRIBUTE("
    "object_name => :on, object_type => :ot, "
    "attribute_name => :an, attribute_value => :av); END;"
)


async def _set_attribute(database: str, object_type: str, object_name: str,
                         attribute_name: str, value: Any) -> dict:
    if value is None:
        value = ""
    if not isinstance(value, str):
        value = str(value)
    try:
        await db.execute(
            database,
            _SET_ATTR_PLSQL,
            on=object_name, ot=object_type, an=attribute_name, av=value,
        )
    except Exception as exc:
        msg = _first_line(exc)
        logger.warning("SET_ATTRIBUTE failed: db=%s type=%s name=%s attr=%s: %s",
                       database, object_type, object_name, attribute_name, msg)
        raise HTTPException(status_code=400, detail={"error": msg})
    return {"ok": True, "object_type": object_type, "object_name": object_name,
            "attribute_name": attribute_name}


@router.put("/teams/{name}/attributes/{attribute_name}")
async def set_team_attribute(name: str, attribute_name: str, payload: dict,
                              database: str = Depends(current_db)) -> dict:
    return await _set_attribute(database, "TEAM", name, attribute_name, payload.get("value", ""))


@router.put("/{name}/attributes/{attribute_name}")
async def set_agent_attribute(name: str, attribute_name: str, payload: dict,
                               database: str = Depends(current_db)) -> dict:
    return await _set_attribute(database, "AGENT", name, attribute_name, payload.get("value", ""))


@router.put("/tasks/{name}/attributes/{attribute_name}")
async def set_task_attribute(name: str, attribute_name: str, payload: dict,
                              database: str = Depends(current_db)) -> dict:
    return await _set_attribute(database, "TASK", name, attribute_name, payload.get("value", ""))


@router.put("/tools/{name}/attributes/{attribute_name}")
async def set_tool_attribute(name: str, attribute_name: str, payload: dict,
                              database: str = Depends(current_db)) -> dict:
    return await _set_attribute(database, "TOOL", name, attribute_name, payload.get("value", ""))


# ====================================================================
# 실행
# ====================================================================

_RUN_PLSQL = """
DECLARE
    v_result  CLOB;
    v_conv_id VARCHAR2(4000);
BEGIN
    v_conv_id := DBMS_CLOUD_AI.CREATE_CONVERSATION();
    v_result := DBMS_CLOUD_AI_AGENT.RUN_TEAM(
        team_name   => :team_name,
        user_prompt => :user_prompt,
        params      => '{"conversation_id": "' || v_conv_id || '"}'
    );
    :out_conv := v_conv_id;
    :out_result := v_result;
END;
"""


@router.post("/teams/run")
async def run_team(payload: dict, database: str = Depends(current_db)) -> dict:
    team_name = (payload.get("team_name") or "").strip()
    user_prompt = (payload.get("user_prompt") or "").strip()
    if not team_name:
        raise HTTPException(status_code=400, detail={"error": "team_name required"})
    if not user_prompt:
        raise HTTPException(status_code=400, detail={"error": "user_prompt required"})

    pool = db.get_pool(database)
    t0 = time.perf_counter()
    conv_id = ""
    result_str = ""
    try:
        async with pool.acquire() as conn:
            with conn.cursor() as cur:
                out_conv = cur.var(str, size=4000)
                out_result = cur.var(oracledb.DB_TYPE_CLOB)
                await cur.execute(
                    _RUN_PLSQL,
                    {
                        "team_name": team_name,
                        "user_prompt": user_prompt,
                        "out_conv": out_conv,
                        "out_result": out_result,
                    },
                )
                conv_id = out_conv.getvalue() or ""
                lob = out_result.getvalue()
                if lob is None:
                    result_str = ""
                elif hasattr(lob, "read"):
                    r = lob.read()
                    if hasattr(r, "__await__"):
                        result_str = await r
                    else:
                        result_str = r
                else:
                    result_str = str(lob)
            await conn.commit()
    except Exception as exc:
        logger.warning("RUN_TEAM failed: db=%s team=%s: %s", database, team_name, _first_line(exc))
        raise HTTPException(status_code=400, detail={"error": _first_line(exc), "team": team_name})

    total_ms = int((time.perf_counter() - t0) * 1000)
    timeline_payload = await _build_timeline_and_logs(database, conv_id)
    return {
        "conversation_id": conv_id,
        "total_elapsed_ms": total_ms,
        "result": result_str or "",
        "timeline": timeline_payload["timeline"],
        "raw_logs": timeline_payload["raw_logs"],
    }


@router.get("/conversations/{conv_id}/timeline")
async def conversation_timeline(conv_id: str, database: str = Depends(current_db)) -> dict:
    return await _build_timeline_and_logs(database, conv_id)


# ====================================================================
# 타임라인 + raw 로그 빌더
# ====================================================================

def _to_ms(td) -> int:
    """timedelta → 정수 ms."""
    if td is None:
        return 0
    return int(td.total_seconds() * 1000)


async def _build_timeline_and_logs(database: str, conv_id: str) -> dict:
    """conversation_id 로 team_exec_id 를 찾아 task/tool 이력을 시간축에 맞춤."""
    if not conv_id:
        return {"timeline": [], "raw_logs": {
            "conversation_prompts": [], "task_history": [], "tool_history": [],
        }}

    # 1. team_history: conversation_id → team_exec_id, start_date
    #    TIMESTAMP WITH TIME ZONE 은 thin mode 미지원 → CAST AS TIMESTAMP 로 (UTC) 변환
    th = await db.fetch_all(
        database,
        "SELECT team_exec_id, team_name, state, "
        "       CAST(SYS_EXTRACT_UTC(start_date) AS TIMESTAMP) AS start_date, "
        "       CAST(SYS_EXTRACT_UTC(end_date)   AS TIMESTAMP) AS end_date "
        "  FROM USER_AI_AGENT_TEAM_HISTORY WHERE conversation_id = :cid "
        " ORDER BY start_date",
        cid=conv_id,
    )
    timeline: list[dict] = []
    task_history: list[dict] = []
    tool_history: list[dict] = []

    if th:
        team_exec_ids = [r["team_exec_id"] for r in th]
        base_start = th[0]["start_date"]

        # team 자체를 timeline 최상단에 추가
        for r in th:
            sd = r.get("start_date")
            ed = r.get("end_date")
            if sd is not None:
                timeline.append({
                    "step": f"TEAM {r.get('team_name') or ''}",
                    "type": "team",
                    "start_ms": _to_ms(sd - base_start),
                    "end_ms": _to_ms((ed or sd) - base_start),
                })

        # 2. task_history — 동일 conversation 에 여러 team_exec 가 있을 수 있어 모두 합침
        exec_ids_payload = json.dumps(team_exec_ids)
        tasks = await db.fetch_all(
            database,
            "SELECT th.task_order, th.agent_name, th.task_name, th.state, "
            "       CAST(SYS_EXTRACT_UTC(th.start_date) AS TIMESTAMP) AS start_date, "
            "       CAST(SYS_EXTRACT_UTC(th.end_date)   AS TIMESTAMP) AS end_date "
            "  FROM USER_AI_AGENT_TASK_HISTORY th "
            "  JOIN JSON_TABLE(:payload, '$[*]' COLUMNS (eid VARCHAR2(64) PATH '$')) j "
            "    ON th.team_exec_id = j.eid "
            " ORDER BY th.start_date, th.task_order",
            payload=exec_ids_payload,
        )
        for r in tasks:
            sd = r.get("start_date")
            ed = r.get("end_date")
            if sd is None:
                continue
            timeline.append({
                "step": f"{r.get('agent_name') or '?'}.{r.get('task_name') or '?'}",
                "type": "task",
                "start_ms": _to_ms(sd - base_start),
                "end_ms": _to_ms((ed or sd) - base_start),
            })
            elapsed = _to_ms((ed - sd)) if ed and sd else None
            task_history.append({
                "task_name": r.get("task_name") or "",
                "status": r.get("state") or "",
                "elapsed_ms": elapsed,
            })

        # 3. tool_history (개별 invocation)
        tools = await db.fetch_all(
            database,
            "SELECT toh.invocation_id, toh.task_order, toh.tool_name, toh.agent_name, toh.task_name, "
            "       CAST(SYS_EXTRACT_UTC(toh.start_date) AS TIMESTAMP) AS start_date, "
            "       CAST(SYS_EXTRACT_UTC(toh.end_date)   AS TIMESTAMP) AS end_date "
            "  FROM USER_AI_AGENT_TOOL_HISTORY toh "
            "  JOIN JSON_TABLE(:payload, '$[*]' COLUMNS (eid VARCHAR2(64) PATH '$')) j "
            "    ON toh.team_exec_id = j.eid "
            " ORDER BY toh.start_date, toh.task_order",
            payload=exec_ids_payload,
        )
        tool_agg: dict[str, dict] = {}
        for r in tools:
            sd = r.get("start_date")
            ed = r.get("end_date")
            if sd is None:
                continue
            timeline.append({
                "step": f"{r.get('agent_name') or '?'}.{r.get('task_name') or '?'} ▶ {r.get('tool_name') or '?'}",
                "type": "tool",
                "start_ms": _to_ms(sd - base_start),
                "end_ms": _to_ms((ed or sd) - base_start),
            })
            # tool_history 는 도구별 집계
            tname = r.get("tool_name") or ""
            entry = tool_agg.setdefault(tname, {"tool_name": tname, "calls": 0, "elapsed_ms": 0})
            entry["calls"] += 1
            if ed and sd:
                entry["elapsed_ms"] += _to_ms(ed - sd)
        tool_history = list(tool_agg.values())

    # 4. conversation_prompts → role/content 펼치기 (user + assistant)
    raw_prompts = await db.fetch_all(
        database,
        "SELECT conversation_prompt_id, prompt_action, prompt, prompt_response, "
        "       CAST(SYS_EXTRACT_UTC(created) AS TIMESTAMP) AS created "
        "  FROM USER_CLOUD_AI_CONVERSATION_PROMPTS "
        " WHERE conversation_id = :cid "
        " ORDER BY created",
        cid=conv_id,
    )
    convo: list[dict] = []
    for p in raw_prompts:
        pid = p.get("conversation_prompt_id") or ""
        ts = str(p.get("created")) if p.get("created") is not None else ""
        if p.get("prompt"):
            convo.append({
                "prompt_id": pid,
                "role": "user",
                "content": p.get("prompt") or "",
                "ts": ts,
            })
        if p.get("prompt_response"):
            convo.append({
                "prompt_id": pid,
                "role": f"assistant ({p.get('prompt_action') or ''})".strip(" ()"),
                "content": p.get("prompt_response") or "",
                "ts": ts,
            })

    return {
        "timeline": timeline,
        "raw_logs": {
            "conversation_prompts": convo,
            "task_history": task_history,
            "tool_history": tool_history,
        },
    }
