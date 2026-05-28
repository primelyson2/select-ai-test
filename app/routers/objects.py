"""기능요구사항03 (메뉴 [1] Profile Object Comment & Annotation) — 실제 DDL 호출.

- GET  /api/objects/{owner}/{table}/metadata         조회
- PUT  /api/objects/{owner}/{table}/comment          테이블 코멘트 수정
- PUT  /api/objects/{owner}/{table}/columns/{column}/comment
- PUT  /api/objects/{owner}/{table}/annotation       테이블 annotation 수정 (23ai)
- PUT  /api/objects/{owner}/{table}/columns/{column}/annotation
- POST /api/objects/{owner}/{table}/columns/bulk     컬럼 메타데이터 일괄 저장

> identifier (owner/table/column/annotation name) 는 bind 불가 → whitelist 정규식 검증 후 직접 보간.
> COMMENT / Annotation 의 텍스트 값은 반드시 bind (또는 single-quote 이스케이프).
> Oracle DDL 은 auto-commit 이므로 bulk 실패 시 ROLLBACK 불가 — 어디서 멈췄는지 응답에 명시.
"""
from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.deps import current_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/objects", tags=["objects"])

# Oracle unquoted identifier: 영문자로 시작, A-Z 0-9 _ $ # 만 허용 (대문자 변환 후 검증)
IDENT_RE = re.compile(r"^[A-Z][A-Z0-9_$#]*$")
# Annotation 이름은 mixed-case 허용
ANNOT_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_$#]*$")


def _ident(name: str, label: str) -> str:
    """대문자로 정규화 + whitelist 검증. 통과한 식별자를 반환."""
    if not name:
        raise HTTPException(status_code=400, detail={"error": f"{label} required"})
    u = name.upper()
    if not IDENT_RE.match(u):
        raise HTTPException(status_code=400, detail={"error": f"invalid {label}: {name}"})
    return u


def _annot_name(name: str) -> str:
    if not name or not ANNOT_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail={"error": f"invalid annotation name: {name}"})
    return name


def _first_line(exc: Exception) -> str:
    s = str(exc).strip()
    return s.splitlines()[0] if s else "execution failed"


def _sql_literal(value: str | None) -> str:
    """문자열 리터럴 — single-quote 이스케이프. None 은 빈 문자열로."""
    if value is None:
        value = ""
    if not isinstance(value, str):
        value = str(value)
    return "'" + value.replace("'", "''") + "'"


# === 메타데이터 조회 ===

@router.get("/{owner}/{table}/metadata")
async def object_metadata(
    owner: str, table: str, database: str = Depends(current_db)
) -> dict:
    o = _ident(owner, "owner")
    t = _ident(table, "table")

    # 1. USER_ANNOTATIONS_USAGE 뷰 존재 여부 (23ai 지원 판별)
    annot_view_rows = await db.fetch_all(
        database,
        "SELECT 1 AS x FROM ALL_VIEWS "
        "WHERE view_name = 'USER_ANNOTATIONS_USAGE' AND ROWNUM <= 1",
    )
    annotations_supported = bool(annot_view_rows)

    # 2. 테이블 코멘트
    tbl_rows = await db.fetch_all(
        database,
        "SELECT comments FROM ALL_TAB_COMMENTS "
        "WHERE UPPER(owner) = :owner AND UPPER(table_name) = :tbl",
        owner=o, tbl=t,
    )
    table_comment = (tbl_rows[0].get("comments") if tbl_rows else None) or ""

    # 3. 컬럼 + 컬럼 코멘트 (LEFT JOIN — 코멘트 없어도 컬럼은 반환)
    col_rows = await db.fetch_all(
        database,
        "SELECT c.column_name, c.data_type, cc.comments "
        "  FROM ALL_TAB_COLUMNS c "
        "  LEFT JOIN ALL_COL_COMMENTS cc "
        "    ON cc.owner = c.owner "
        "   AND cc.table_name = c.table_name "
        "   AND cc.column_name = c.column_name "
        " WHERE UPPER(c.owner) = :owner AND UPPER(c.table_name) = :tbl "
        " ORDER BY c.column_id",
        owner=o, tbl=t,
    )

    # 4. Annotations (테이블 + 컬럼) 일괄
    table_annotations: dict[str, str] = {}
    column_annotations: dict[str, dict[str, str]] = {}
    if annotations_supported:
        try:
            # USER_ANNOTATIONS_USAGE: column_name 이 NULL 이면 테이블 레벨, 값이 있으면 컬럼 레벨
            # (OBJECT_TYPE 은 둘 다 'TABLE' 로 들어옴)
            ann_rows = await db.fetch_all(
                database,
                "SELECT column_name, annotation_name, annotation_value "
                "  FROM USER_ANNOTATIONS_USAGE "
                " WHERE UPPER(object_name) = :tbl",
                tbl=t,
            )
            for r in ann_rows:
                an = r.get("annotation_name")
                av = r.get("annotation_value") or ""
                col = r.get("column_name")
                if col:
                    column_annotations.setdefault(col, {})[an] = av
                else:
                    table_annotations[an] = av
        except Exception as e:
            logger.warning("USER_ANNOTATIONS_USAGE query failed: %s", _first_line(e))
            annotations_supported = False

    columns = [
        {
            "name": r.get("column_name"),
            "data_type": r.get("data_type"),
            "comment": r.get("comments") or "",
            "annotations": column_annotations.get(r.get("column_name"), {}),
        }
        for r in col_rows
    ]

    return {
        "annotations_supported": annotations_supported,
        "table": {"comment": table_comment, "annotations": table_annotations},
        "columns": columns,
    }


# === 단건 수정 ===

@router.put("/{owner}/{table}/comment")
async def update_table_comment(
    owner: str, table: str, body: dict,
    database: str = Depends(current_db),
) -> dict:
    o = _ident(owner, "owner")
    t = _ident(table, "table")
    text = body.get("text") or ""
    try:
        await db.execute(database, f"COMMENT ON TABLE {o}.{t} IS {_sql_literal(text)}")
    except Exception as exc:
        logger.warning("table comment DDL failed: %s", _first_line(exc))
        raise HTTPException(status_code=400, detail={"error": _first_line(exc)})
    return {"ok": True, "owner": o, "table": t}


@router.put("/{owner}/{table}/columns/{column}/comment")
async def update_column_comment(
    owner: str, table: str, column: str, body: dict,
    database: str = Depends(current_db),
) -> dict:
    o = _ident(owner, "owner")
    t = _ident(table, "table")
    c = _ident(column, "column")
    text = body.get("text") or ""
    try:
        await db.execute(database, f"COMMENT ON COLUMN {o}.{t}.{c} IS {_sql_literal(text)}")
    except Exception as exc:
        logger.warning("column comment DDL failed: %s", _first_line(exc))
        raise HTTPException(status_code=400, detail={"error": _first_line(exc)})
    return {"ok": True, "owner": o, "table": t, "column": c}


@router.put("/{owner}/{table}/annotation")
async def update_table_annotation(
    owner: str, table: str, body: dict,
    database: str = Depends(current_db),
) -> dict:
    o = _ident(owner, "owner")
    t = _ident(table, "table")
    an = _annot_name(body.get("name", ""))
    av = body.get("value", "") or ""
    if not isinstance(av, str):
        av = str(av)
    av_esc = av.replace("'", "''")
    sql = f"ALTER TABLE {o}.{t} ANNOTATIONS (ADD OR REPLACE {an} '{av_esc}')"
    try:
        await db.execute(database, sql)
    except Exception as exc:
        logger.warning("table annotation DDL failed: %s", _first_line(exc))
        raise HTTPException(status_code=400, detail={"error": _first_line(exc)})
    return {"ok": True, "owner": o, "table": t, "name": an}


@router.put("/{owner}/{table}/columns/{column}/annotation")
async def update_column_annotation(
    owner: str, table: str, column: str, body: dict,
    database: str = Depends(current_db),
) -> dict:
    o = _ident(owner, "owner")
    t = _ident(table, "table")
    c = _ident(column, "column")
    an = _annot_name(body.get("name", ""))
    av = body.get("value", "") or ""
    if not isinstance(av, str):
        av = str(av)
    av_esc = av.replace("'", "''")
    sql = f"ALTER TABLE {o}.{t} MODIFY ({c} ANNOTATIONS (ADD OR REPLACE {an} '{av_esc}'))"
    try:
        await db.execute(database, sql)
    except Exception as exc:
        logger.warning("column annotation DDL failed: %s", _first_line(exc))
        raise HTTPException(status_code=400, detail={"error": _first_line(exc)})
    return {"ok": True, "owner": o, "table": t, "column": c, "name": an}


# === Annotation 삭제 ===

@router.delete("/{owner}/{table}/annotation/{annotation_name}")
async def delete_table_annotation(
    owner: str, table: str, annotation_name: str,
    database: str = Depends(current_db),
) -> dict:
    o = _ident(owner, "owner")
    t = _ident(table, "table")
    an = _annot_name(annotation_name)
    try:
        await db.execute(database, f"ALTER TABLE {o}.{t} ANNOTATIONS (DROP {an})")
    except Exception as exc:
        logger.warning("table annotation DROP failed: %s", _first_line(exc))
        raise HTTPException(status_code=400, detail={"error": _first_line(exc)})
    return {"ok": True, "owner": o, "table": t, "name": an}


@router.delete("/{owner}/{table}/columns/{column}/annotation/{annotation_name}")
async def delete_column_annotation(
    owner: str, table: str, column: str, annotation_name: str,
    database: str = Depends(current_db),
) -> dict:
    o = _ident(owner, "owner")
    t = _ident(table, "table")
    c = _ident(column, "column")
    an = _annot_name(annotation_name)
    try:
        await db.execute(
            database,
            f"ALTER TABLE {o}.{t} MODIFY ({c} ANNOTATIONS (DROP {an}))",
        )
    except Exception as exc:
        logger.warning("column annotation DROP failed: %s", _first_line(exc))
        raise HTTPException(status_code=400, detail={"error": _first_line(exc)})
    return {"ok": True, "owner": o, "table": t, "column": c, "name": an}


# === 컬럼 메타데이터 일괄 저장 ===
# 동일 connection 으로 순차 실행. Oracle DDL 은 auto-commit 이므로 실패시 이전 DDL 은 유지된다 —
# 응답에 어디서 멈췄는지(failed_column) 명시.

@router.post("/{owner}/{table}/columns/bulk")
async def bulk_update_columns(
    owner: str, table: str, body: dict,
    database: str = Depends(current_db),
) -> dict:
    o = _ident(owner, "owner")
    t = _ident(table, "table")
    cols = body.get("columns") or []
    if not isinstance(cols, list) or not cols:
        raise HTTPException(status_code=400, detail={"error": "columns required"})

    pool = db.get_pool(database)
    updated = 0
    failed_column: str | None = None
    failed_kind: str | None = None
    async with pool.acquire() as conn:
        with conn.cursor() as cur:
            for item in cols:
                if not isinstance(item, dict):
                    continue
                name = item.get("name")
                try:
                    c = _ident(name, "column")
                except HTTPException as e:
                    failed_column = str(name)
                    failed_kind = "validate"
                    raise HTTPException(
                        status_code=400,
                        detail={"error": e.detail.get("error", "invalid column"),
                                "failed_column": failed_column, "updated": updated},
                    )

                if "comment" in item:
                    txt = item.get("comment") or ""
                    try:
                        await cur.execute(
                            f"COMMENT ON COLUMN {o}.{t}.{c} IS {_sql_literal(txt)}",
                        )
                        updated += 1
                    except Exception as exc:
                        failed_column = name
                        failed_kind = "comment"
                        raise HTTPException(
                            status_code=400,
                            detail={"error": _first_line(exc),
                                    "failed_column": failed_column,
                                    "failed_kind": failed_kind,
                                    "updated": updated},
                        )

                ann = item.get("annotation")
                if ann and isinstance(ann, dict):
                    try:
                        an = _annot_name(ann.get("name", ""))
                    except HTTPException as e:
                        failed_column = name
                        failed_kind = "annotation"
                        raise HTTPException(
                            status_code=400,
                            detail={"error": e.detail.get("error", "invalid annotation"),
                                    "failed_column": failed_column,
                                    "failed_kind": failed_kind,
                                    "updated": updated},
                        )
                    av = ann.get("value", "") or ""
                    if not isinstance(av, str):
                        av = str(av)
                    av_esc = av.replace("'", "''")
                    sql = f"ALTER TABLE {o}.{t} MODIFY ({c} ANNOTATIONS (ADD OR REPLACE {an} '{av_esc}'))"
                    try:
                        await cur.execute(sql)
                        updated += 1
                    except Exception as exc:
                        failed_column = name
                        failed_kind = "annotation"
                        raise HTTPException(
                            status_code=400,
                            detail={"error": _first_line(exc),
                                    "failed_column": failed_column,
                                    "failed_kind": failed_kind,
                                    "updated": updated},
                        )
    return {"ok": True, "owner": o, "table": t, "updated": updated}
