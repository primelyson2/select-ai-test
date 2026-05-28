"""config.yaml 로더 — 다중 ADB 설정.

구조 예시는 config.yaml.example 참조. 상대 경로(wallet_location/config_dir)는
project/ 루트 기준으로 절대경로화하여 oracledb 에 전달한다.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

# project/ 루트 — app/ 의 부모 (config.yaml 이 여기에 놓인다)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config.yaml"


@dataclass
class DatabaseConfig:
    name: str
    label: str
    user: str
    password: str
    dsn: str
    wallet_location: str
    wallet_password: str
    config_dir: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "DatabaseConfig":
        required = ("name", "user", "password", "dsn")
        missing = [k for k in required if not d.get(k)]
        if missing:
            raise ValueError(
                f"config.yaml databases 항목에 필수키 누락: {missing} (name={d.get('name')!r})"
            )

        def _abs(p: str | None) -> str:
            if not p:
                return ""
            pp = Path(p)
            if not pp.is_absolute():
                pp = (PROJECT_ROOT / pp).resolve()
            return str(pp)

        return cls(
            name=d["name"],
            label=d.get("label") or d["name"],
            user=d["user"],
            password=d["password"],
            dsn=d["dsn"],
            wallet_location=_abs(d.get("wallet_location")),
            wallet_password=d.get("wallet_password", "") or "",
            config_dir=_abs(d.get("config_dir") or d.get("wallet_location")),
        )


@dataclass
class AppConfig:
    default_database: str
    databases: list[DatabaseConfig]

    def get(self, name: str) -> DatabaseConfig | None:
        return next((d for d in self.databases if d.name == name), None)

    def names(self) -> list[str]:
        return [d.name for d in self.databases]


def load_config(path: str | Path = DEFAULT_CONFIG_PATH) -> AppConfig:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(
            f"config.yaml 이 존재하지 않습니다: {p}. config.yaml.example 을 참고해 작성하세요."
        )
    with p.open("r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    items = raw.get("databases") or []
    if not items:
        raise ValueError("config.yaml 의 databases 가 비어 있습니다")
    dbs = [DatabaseConfig.from_dict(d) for d in items]
    default = raw.get("default_database") or dbs[0].name
    if not any(d.name == default for d in dbs):
        default = dbs[0].name
    return AppConfig(default_database=default, databases=dbs)
