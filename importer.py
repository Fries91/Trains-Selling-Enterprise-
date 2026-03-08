import json
import os
from typing import Any, Dict, List

from db import upsert_hof_worker


def _normalize_status(raw_status: str, company_name: str = "") -> str:
    s = str(raw_status or "").strip().lower()

    if s in {"none", "no company", "unemployed"}:
        return "none"
    if s in {"company", "working", "employed"}:
        return "company"
    if s in {"cityjob", "city job", "city_job"}:
        return "cityjob"
    if company_name:
        return "company"
    return "unknown"


def _to_int(v: Any) -> int:
    try:
        return int(float(v))
    except Exception:
        return 0


def _extract_rows(payload: Any) -> List[Dict[str, Any]]:
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]

    if isinstance(payload, dict):
        for key in ("rows", "results", "players", "workers", "data", "items", "entries"):
            value = payload.get(key)
            if isinstance(value, list):
                return [x for x in value if isinstance(x, dict)]

        for value in payload.values():
            if isinstance(value, dict):
                for subkey in ("rows", "results", "players", "workers", "data", "items", "entries"):
                    subval = value.get(subkey)
                    if isinstance(subval, list):
                        return [x for x in subval if isinstance(x, dict)]

    return []


def _pick_player_id(row: Dict[str, Any]) -> str:
    for key in ("id", "player_id", "torn_id", "user_id"):
        val = str(row.get(key) or "").strip()
        if val:
            return val
    return ""


def _pick_name(row: Dict[str, Any]) -> str:
    for key in ("name", "player_name", "username"):
        val = str(row.get(key) or "").strip()
        if val:
            return val
    return ""


def _pick_stats(row: Dict[str, Any]):
    manual_labor = _to_int(row.get("manual_labor") or row.get("man"))
    intelligence = _to_int(row.get("intelligence") or row.get("int"))
    endurance = _to_int(row.get("endurance") or row.get("end"))

    if manual_labor or intelligence or endurance:
        return manual_labor, intelligence, endurance

    total = _to_int(
        row.get("total")
        or row.get("value")
        or row.get("score")
        or row.get("stat")
        or row.get("amount")
    )

    if total > 0:
        return total, 0, 0

    return 0, 0, 0


def import_hof_workers_from_payload(payload: Any) -> int:
    rows = _extract_rows(payload)
    imported = 0

    for row in rows:
        if not isinstance(row, dict):
            continue

        player_id = _pick_player_id(row)
        if not player_id:
            continue

        name = _pick_name(row)
        manual_labor, intelligence, endurance = _pick_stats(row)
        company_name = str(row.get("company_name") or row.get("company") or "").strip()
        job_status = _normalize_status(row.get("job_status") or row.get("status"), company_name)

        upsert_hof_worker(
            player_id=player_id,
            name=name,
            manual_labor=manual_labor,
            intelligence=intelligence,
            endurance=endurance,
            job_status=job_status,
            company_name=company_name,
        )
        imported += 1

    return imported


def import_hof_workers_from_json_file(filepath: str) -> int:
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"HoF data file not found: {filepath}")

    with open(filepath, "r", encoding="utf-8") as f:
        payload = json.load(f)

    return import_hof_workers_from_payload(payload)
