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
        for key in ("rows", "results", "players", "workers", "data"):
            value = payload.get(key)
            if isinstance(value, list):
                return [x for x in value if isinstance(x, dict)]

    return []


def import_hof_workers_from_payload(payload: Any) -> int:
    rows = _extract_rows(payload)
    imported = 0

    for row in rows:
        player_id = str(
            row.get("id")
            or row.get("player_id")
            or row.get("torn_id")
            or ""
        ).strip()
        if not player_id:
            continue

        name = str(row.get("name") or row.get("player_name") or "").strip()
        manual_labor = _to_int(row.get("manual_labor") or row.get("man"))
        intelligence = _to_int(row.get("intelligence") or row.get("int"))
        endurance = _to_int(row.get("endurance") or row.get("end"))
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
