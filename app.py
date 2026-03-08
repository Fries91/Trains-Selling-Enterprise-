import json
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import requests
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request

from db import (
    init_db,
    upsert_user,
    get_user,
    touch_user,
    create_session,
    get_session,
    touch_session,
    add_train,
    list_trains,
    delete_train,
    set_company_ids,
    hof_count,
    save_company_key,
    list_company_keys,
    delete_company_key,
    get_company_key,
)
from torn_api import me_basic, company_profile, normalize_company
from importer import import_hof_workers_from_json_file

load_dotenv()
app = Flask(__name__)

ADMIN_KEYS = [k.strip() for k in (os.getenv("ADMIN_KEYS") or "").split(",") if k.strip()]
IMPORTER_SECRET = (os.getenv("IMPORTER_SECRET") or "").strip()
HOF_DATA_FILE = (os.getenv("HOF_DATA_FILE") or "hof_workers.json").strip()

TORN_HOF_URL = "https://api.torn.com/v2/torn/hof"
TORN_USER_V1_URL = "https://api.torn.com/user/"
HOF_PAGE_SIZE = 100
ACTIVE_DAYS_DEFAULT = 3


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ok(data: Dict[str, Any], status: int = 200):
    data.setdefault("ok", True)
    return jsonify(data), status


def fail(message: str, status: int = 400, details: Optional[str] = None):
    payload: Dict[str, Any] = {"ok": False, "error": message}
    if details:
        payload["details"] = details
    return jsonify(payload), status


def check_importer_secret(raw: str) -> bool:
    return bool(IMPORTER_SECRET) and (raw or "").strip() == IMPORTER_SECRET


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


def import_hof_workers_from_payload_local(payload: Any) -> int:
    rows = _extract_rows(payload)
    imported = 0

    from db import upsert_hof_worker

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


def _clean_company_ids(values: List[Any]) -> List[str]:
    out: List[str] = []
    for x in values or []:
        s = str(x).strip()
        if not s or not s.isdigit():
            continue
        if s not in out:
            out.append(s)
    return out


def _append_company_id(user_id: str, company_id: str) -> List[str]:
    user = get_user(user_id)
    if not user:
        return []

    ids = _clean_company_ids(user.get("company_ids") or [])
    company_id = str(company_id).strip()
    if company_id and company_id not in ids:
        ids.append(company_id)
        set_company_ids(user_id, ids)
    return ids


def _as_int(value: Any, default: int = 0) -> int:
    try:
        raw = str(value).replace(",", "").strip()
        if raw == "":
            return default
        return int(float(raw))
    except Exception:
        return default


def _hof_pick_rows(payload: Any) -> List[Dict[str, Any]]:
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]

    if not isinstance(payload, dict):
        return []

    for key in ("hof", "items", "rankings", "players", "data", "results"):
        val = payload.get(key)
        if isinstance(val, list):
            return [x for x in val if isinstance(x, dict)]
        if isinstance(val, dict):
            for subkey in ("items", "players", "entries", "rows", "data", "results"):
                subval = val.get(subkey)
                if isinstance(subval, list):
                    return [x for x in subval if isinstance(x, dict)]

    for _, val in payload.items():
        if isinstance(val, list) and val and isinstance(val[0], dict):
            return [x for x in val if isinstance(x, dict)]

    return []


def _hof_pick_total(row: Dict[str, Any]) -> int:
    for key in ("value", "total", "score", "stat", "amount", "workstats", "work_stats"):
        if key in row:
            return _as_int(row.get(key), 0)

    man = _as_int(row.get("manual_labor") or row.get("man"), 0)
    intl = _as_int(row.get("intelligence") or row.get("int"), 0)
    end = _as_int(row.get("endurance") or row.get("end"), 0)
    if man or intl or end:
        return man + intl + end

    return 0


def _hof_pick_rank(row: Dict[str, Any], fallback_rank: int) -> int:
    for key in ("rank", "position", "place"):
        if key in row:
            return _as_int(row.get(key), fallback_rank)
    return fallback_rank


def _hof_pick_player_id(row: Dict[str, Any]) -> str:
    for key in ("player_id", "user_id", "id"):
        val = str(row.get(key) or "").strip()
        if val:
            return val
    return ""


def _hof_pick_name(row: Dict[str, Any]) -> str:
    for key in ("name", "player_name", "username"):
        val = str(row.get(key) or "").strip()
        if val:
            return val
    return "Unknown"


def _fetch_torn_hof_page(api_key: str, offset: int, limit: int) -> List[Dict[str, Any]]:
    attempts = [
        {"key": api_key, "cat": "workstats", "offset": offset, "limit": limit},
        {"key": api_key, "category": "workstats", "offset": offset, "limit": limit},
    ]

    last_error = None

    for params in attempts:
        try:
            r = requests.get(TORN_HOF_URL, params=params, timeout=30)
            r.raise_for_status()
            payload = r.json()

            if isinstance(payload, dict) and payload.get("error"):
                err = payload.get("error") or {}
                raise RuntimeError(f'{err.get("code", "")}: {err.get("error", "Unknown API error")}')

            rows = _hof_pick_rows(payload)
            if rows:
                return rows
        except Exception as e:
            last_error = e

    if last_error:
        raise last_error

    return []


def _rows_to_results(rows: List[Dict[str, Any]], offset: int, min_total: int, max_total: int) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []

    for idx, row in enumerate(rows):
        total = _hof_pick_total(row)
        if total < min_total or total > max_total:
            continue

        player_id = _hof_pick_player_id(row)
        out.append({
            "id": player_id,
            "name": _hof_pick_name(row),
            "rank": _hof_pick_rank(row, offset + idx + 1),
            "total": total,
            "profile_url": f"https://www.torn.com/profiles.php?XID={player_id}" if player_id else "",
        })

    return out


def _page_range(rows: List[Dict[str, Any]]) -> Tuple[int, int]:
    if not rows:
        return (0, 0)
    totals = [_hof_pick_total(r) for r in rows]
    return (max(totals), min(totals))


def _fetch_user_profile_activity(api_key: str, player_id: str) -> Dict[str, Any]:
    r = requests.get(
        f"{TORN_USER_V1_URL}{player_id}",
        params={"selections": "profile", "key": api_key},
        timeout=25,
    )
    r.raise_for_status()
    payload = r.json()

    if isinstance(payload, dict) and payload.get("error"):
        err = payload.get("error") or {}
        raise RuntimeError(f'{err.get("code", "")}: {err.get("error", "Unknown API error")}')

    last_action = payload.get("last_action") or {}
    status = payload.get("status") or {}

    ts = _as_int(last_action.get("timestamp"), 0)
    relative = str(last_action.get("relative") or "")
    status_state = str(status.get("state") or "")
    status_desc = str(status.get("description") or "")
    status_color = str(status.get("color") or "")

    return {
        "last_action_timestamp": ts,
        "last_action_relative": relative,
        "status_state": status_state,
        "status_description": status_desc,
        "status_color": status_color,
    }


def _is_recently_active(activity: Dict[str, Any], active_days: int) -> bool:
    ts = _as_int(activity.get("last_action_timestamp"), 0)
    if ts <= 0:
        return False

    cutoff = int(time.time()) - (max(1, int(active_days)) * 86400)
    return ts >= cutoff


def _collect_live_hof_results_binary(api_key: str, min_total: int, max_total: int, limit: int, active_days: int):
    visited_offsets = set()
    results_by_id: Dict[str, Dict[str, Any]] = {}
    sampled_pages: List[Dict[str, Any]] = []
    pages_scanned = 0
    profiles_checked = 0

    def fetch_page(offset: int):
        nonlocal pages_scanned
        offset = max(0, int(offset))
        if offset in visited_offsets:
            return None, None, None
        rows = _fetch_torn_hof_page(api_key, offset, HOF_PAGE_SIZE)
        visited_offsets.add(offset)
        pages_scanned += 1
        if not rows:
            return [], 0, 0
        hi, lo = _page_range(rows)
        sampled_pages.append({
            "offset": offset,
            "max_total": hi,
            "min_total": lo,
        })
        return rows, hi, lo

    def maybe_add_active_matches(rows: List[Dict[str, Any]], offset: int):
        nonlocal profiles_checked
        if not rows:
            return

        candidates = _rows_to_results(rows, offset, min_total, max_total)
        for item in candidates:
            if len(results_by_id) >= limit:
                break

            player_id = str(item.get("id") or "").strip()
            if not player_id:
                continue
            if player_id in results_by_id:
                continue

            try:
                activity = _fetch_user_profile_activity(api_key, player_id)
                profiles_checked += 1
            except Exception:
                continue

            if not _is_recently_active(activity, active_days):
                continue

            item["last_action_relative"] = activity.get("last_action_relative", "")
            item["last_action_timestamp"] = activity.get("last_action_timestamp", 0)
            item["status_state"] = activity.get("status_state", "")
            item["status_description"] = activity.get("status_description", "")
            item["status_color"] = activity.get("status_color", "")
            results_by_id[player_id] = item

    low_off = 0
    high_off = 0
    probe = 0
    found_band = False

    probe_sequence = [
        0, 1000, 2500, 5000, 10000, 20000, 40000, 80000, 120000, 160000, 200000
    ]

    prev_probe = 0
    prev_lo = None

    for probe in probe_sequence:
        if pages_scanned >= 80:
            break

        rows, hi, lo = fetch_page(probe)
        if rows is None or not rows:
            break

        if hi >= min_total and lo <= max_total:
            low_off = probe
            high_off = probe
            found_band = True
            maybe_add_active_matches(rows, probe)
            if len(results_by_id) >= limit:
                break
            break

        if lo > max_total:
            prev_probe = probe
            prev_lo = lo
            continue

        if hi < min_total:
            low_off = prev_probe
            high_off = probe
            found_band = True
            break

    if not found_band:
        if prev_lo is not None and prev_lo > max_total:
            low_off = prev_probe
            high_off = max(prev_probe + HOF_PAGE_SIZE, 200000)
        else:
            low_off = 0
            high_off = max(probe, HOF_PAGE_SIZE)

    left = min(low_off, high_off)
    right = max(low_off, high_off)

    while right - left > HOF_PAGE_SIZE and pages_scanned < 120 and len(results_by_id) < limit:
        mid = ((left + right) // (2 * HOF_PAGE_SIZE)) * HOF_PAGE_SIZE
        rows, hi, lo = fetch_page(mid)
        if rows is None or not rows:
            break

        if hi >= min_total and lo <= max_total:
            maybe_add_active_matches(rows, mid)
            left = max(0, mid - HOF_PAGE_SIZE)
            right = mid + HOF_PAGE_SIZE
            break

        if lo > max_total:
            left = mid + HOF_PAGE_SIZE
        elif hi < min_total:
            right = max(0, mid - HOF_PAGE_SIZE)
        else:
            left = max(0, mid - HOF_PAGE_SIZE)
            right = mid + HOF_PAGE_SIZE
            break

    start = max(0, left - (10 * HOF_PAGE_SIZE))
    end = max(start, right + (10 * HOF_PAGE_SIZE))

    for offset in range(start, end + HOF_PAGE_SIZE, HOF_PAGE_SIZE):
        if pages_scanned >= 180 or len(results_by_id) >= limit:
            break

        rows, hi, lo = fetch_page(offset)
        if rows is None or not rows:
            continue

        maybe_add_active_matches(rows, offset)

        if hi < min_total and offset > right:
            break

    results = list(results_by_id.values())
    results.sort(key=lambda r: (int(r.get("total") or 0), -int(r.get("rank") or 10**9)), reverse=True)

    sampled_pages.sort(key=lambda x: x["offset"])
    meta = {
        "pages_scanned": pages_scanned,
        "profiles_checked": profiles_checked,
        "sampled_pages": sampled_pages[:60],
        "visited_offsets": sorted(visited_offsets),
        "active_days": active_days,
    }
    return results[:limit], meta


@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Session-Token, X-Importer-Secret"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return resp


@app.route("/")
def home():
    return ok({
        "service": "tse-headquarters",
        "ok": True,
        "server_time": utc_now(),
        "routes": [
            "/health",
            "/api/auth",
            "/state",
            "/company_ids",
            "/company-keys",
            "/trains",
            "/hof/search",
            "/hof/import",
            "/hof/upsert",
            "/hof/upload-json",
            "/admin/uploader",
        ],
    })


@app.route("/health", methods=["GET"])
def health():
    return ok({
        "service": "tse-headquarters",
        "server_time": utc_now(),
        "hof_count": hof_count(),
    })


@app.route("/api/auth", methods=["POST", "OPTIONS"])
def api_auth():
    if request.method == "OPTIONS":
        return ok({})

    try:
        body = request.get_json(force=True, silent=False) or {}
    except Exception:
        return fail("Bad JSON", 400)

    admin_key = (body.get("admin_key") or "").strip()
    api_key = (body.get("api_key") or "").strip()

    if not ADMIN_KEYS:
        return fail("Server missing ADMIN_KEYS", 500)

    if not admin_key or admin_key not in ADMIN_KEYS:
        return fail("Invalid Admin Key", 401)

    if not api_key:
        return fail("Missing API Key", 400)

    try:
        me = me_basic(api_key)
    except Exception as e:
        return fail("API Key validation failed", 401, str(e))

    user_id = str(me.get("player_id") or me.get("user_id") or "").strip()
    name = str(me.get("name") or "").strip()

    if not user_id:
        return fail("Torn API response missing player_id", 401)

    upsert_user(user_id=user_id, name=name, api_key=api_key)
    token = create_session(user_id)
    return ok({"token": token, "user": {"id": user_id, "name": name}, "server_time": utc_now()})


def require_session() -> Optional[Dict[str, Any]]:
    token = (request.headers.get("X-Session-Token") or "").strip()
    if not token:
        return None
    session = get_session(token)
    if not session:
        return None
    touch_session(token)
    touch_user(session["user_id"])
    return session


@app.route("/company_ids", methods=["GET", "POST", "OPTIONS"])
def company_ids():
    if request.method == "OPTIONS":
        return ok({})

    session = require_session()
    if not session:
        return fail("Missing/invalid session token", 401)

    user = get_user(session["user_id"])
    if not user:
        return fail("User not found", 404)

    if request.method == "GET":
        ids = user.get("company_ids") or []
        if not isinstance(ids, list):
            ids = []
        return ok({"company_ids": [str(x) for x in ids], "server_time": utc_now()})

    try:
        body = request.get_json(force=True, silent=False) or {}
    except Exception:
        return fail("Bad JSON", 400)

    raw_ids = body.get("company_ids", [])
    if not isinstance(raw_ids, list):
        return fail("company_ids must be a list", 400)

    cleaned = _clean_company_ids(raw_ids)
    set_company_ids(session["user_id"], cleaned)
    return ok({"saved": True, "company_ids": cleaned, "server_time": utc_now()})


@app.route("/company-keys", methods=["GET", "POST", "OPTIONS"])
def company_keys():
    if request.method == "OPTIONS":
        return ok({})

    session = require_session()
    if not session:
        return fail("Missing/invalid session token", 401)

    user = get_user(session["user_id"])
    if not user:
        return fail("User not found", 404)

    if request.method == "GET":
        return ok({
            "items": list_company_keys(session["user_id"]),
            "server_time": utc_now(),
        })

    try:
        body = request.get_json(force=True, silent=False) or {}
    except Exception:
        return fail("Bad JSON", 400)

    company_id = str(body.get("company_id") or "").strip()
    api_key = str(body.get("api_key") or "").strip()

    if not company_id or not company_id.isdigit():
        return fail("Valid company_id required", 400)

    if not api_key:
        return fail("api_key required", 400)

    try:
        raw = company_profile(api_key, company_id)
        company = normalize_company(company_id, raw)
    except Exception as e:
        return fail("Company API key validation failed", 401, str(e))

    save_company_key(session["user_id"], company_id, api_key)
    updated_ids = _append_company_id(session["user_id"], company_id)

    return ok({
        "saved": True,
        "company_id": company_id,
        "company_ids": updated_ids,
        "company": company,
        "items": list_company_keys(session["user_id"]),
        "server_time": utc_now(),
    })


@app.route("/company-keys/<company_id>", methods=["DELETE", "OPTIONS"])
def company_keys_delete(company_id: str):
    if request.method == "OPTIONS":
        return ok({})

    session = require_session()
    if not session:
        return fail("Missing/invalid session token", 401)

    company_id = str(company_id or "").strip()
    if not company_id:
        return fail("Missing company id", 400)

    deleted = delete_company_key(session["user_id"], company_id)
    if not deleted:
        return fail("Company key not found", 404)

    return ok({
        "deleted": True,
        "items": list_company_keys(session["user_id"]),
        "server_time": utc_now(),
    })


@app.route("/state", methods=["GET", "OPTIONS"])
def state():
    if request.method == "OPTIONS":
        return ok({})

    session = require_session()
    if not session:
        return fail("Missing/invalid session token", 401)

    user = get_user(session["user_id"])
    if not user:
        return fail("User not found", 404)

    raw_company_ids = _clean_company_ids(user.get("company_ids") or [])
    saved_company_keys = list_company_keys(user["user_id"])

    merged_company_ids: List[str] = []
    for cid in raw_company_ids:
        if cid not in merged_company_ids:
            merged_company_ids.append(cid)

    for item in saved_company_keys:
        cid = str(item.get("company_id") or "").strip()
        if cid and cid not in merged_company_ids:
            merged_company_ids.append(cid)

    if merged_company_ids != raw_company_ids:
        set_company_ids(user["user_id"], merged_company_ids)

    companies: List[Dict[str, Any]] = []
    for cid in merged_company_ids[:25]:
        company_key_row = get_company_key(user["user_id"], cid)
        api_key_to_use = (
            str(company_key_row.get("api_key") or "").strip()
            if company_key_row else ""
        ) or str(user.get("api_key") or "").strip()

        try:
            raw = company_profile(api_key_to_use, cid)
            company = normalize_company(cid, raw)
            company["source"] = "company_key" if company_key_row and company_key_row.get("api_key") else "user_key"
            companies.append(company)
        except Exception:
            companies.append({
                "id": str(cid),
                "name": f"Company #{cid}",
                "director": "",
                "employees": [],
                "source": "fallback",
            })

    trains = list_trains(user["user_id"])
    name_map = {str(c["id"]): c.get("name") for c in companies}

    for t in trains:
        cid = str(t.get("company_id") or "")
        if cid and cid in name_map:
            t["company_name"] = name_map[cid]

    return ok({
        "user": {
            "id": user["user_id"],
            "name": user.get("name", ""),
            "company_ids": merged_company_ids,
        },
        "companies": companies,
        "company_keys": saved_company_keys,
        "trains": trains,
        "server_time": utc_now(),
    })


@app.route("/trains", methods=["POST", "OPTIONS"])
def trains_add():
    if request.method == "OPTIONS":
        return ok({})

    session = require_session()
    if not session:
        return fail("Missing/invalid session token", 401)

    try:
        body = request.get_json(force=True, silent=False) or {}
    except Exception:
        return fail("Bad JSON", 400)

    company_id = str(body.get("company_id") or "").strip()
    buyer = str(body.get("buyer") or "").strip()
    note = str(body.get("note") or "").strip()

    try:
        amount = int(body.get("amount") or 0)
    except Exception:
        amount = 0

    if amount <= 0:
        return fail("Amount must be > 0", 400)

    new_id = add_train(session["user_id"], company_id, buyer, amount, note)
    return ok({"id": new_id, "server_time": utc_now()})


@app.route("/trains/<train_id>", methods=["DELETE", "OPTIONS"])
def trains_delete(train_id: str):
    if request.method == "OPTIONS":
        return ok({})

    session = require_session()
    if not session:
        return fail("Missing/invalid session token", 401)

    try:
        tid = int(train_id)
    except Exception:
        return fail("Invalid train id", 400)

    deleted = delete_train(session["user_id"], tid)
    if not deleted:
        return fail("Train record not found", 404)

    return ok({"deleted": True, "server_time": utc_now()})


@app.route("/hof/search", methods=["POST", "OPTIONS"])
def hof_search():
    if request.method == "OPTIONS":
        return ok({})

    session = require_session()
    if not session:
        return fail("Missing/invalid session token", 401)

    user = get_user(session["user_id"])
    if not user:
        return fail("User not found", 404)

    api_key = str(user.get("api_key") or "").strip()
    if not api_key:
        return fail("Missing user API key", 400)

    try:
        body = request.get_json(force=True, silent=False) or {}
    except Exception:
        return fail("Bad JSON", 400)

    min_total = max(0, _as_int(body.get("min_total"), 0))
    max_total = _as_int(body.get("max_total"), 0)
    limit = max(1, min(100, _as_int(body.get("limit"), 50)))
    active_days = max(1, min(30, _as_int(body.get("active_days"), ACTIVE_DAYS_DEFAULT)))

    if max_total <= 0:
        max_total = 10**18

    if max_total < min_total:
        return fail("max_total must be greater than or equal to min_total", 400)

    try:
        live_results, meta = _collect_live_hof_results_binary(
            api_key=api_key,
            min_total=min_total,
            max_total=max_total,
            limit=limit,
            active_days=active_days,
        )

        return ok({
            "results": live_results,
            "count": len(live_results),
            "source": "torn_live_hof_active_only",
            "pages_scanned": meta.get("pages_scanned", 0),
            "profiles_checked": meta.get("profiles_checked", 0),
            "sampled_pages": meta.get("sampled_pages", []),
            "active_days": meta.get("active_days", active_days),
            "server_time": utc_now(),
        })

    except requests.HTTPError as e:
        return fail("Torn HoF HTTP error", 502, str(e))
    except requests.RequestException as e:
        return fail("Torn HoF request failed", 502, str(e))
    except Exception as e:
        return fail("HoF search failed", 500, str(e))


@app.route("/hof/import", methods=["POST", "OPTIONS"])
def hof_import():
    if request.method == "OPTIONS":
        return ok({})

    header_secret = (request.headers.get("X-Importer-Secret") or "").strip()
    if not check_importer_secret(header_secret):
        return fail("Invalid importer secret", 401)

    try:
        imported = import_hof_workers_from_json_file(HOF_DATA_FILE)
        return ok({"imported": imported, "hof_count": hof_count(), "server_time": utc_now()})
    except Exception as e:
        return fail("Import failed", 500, str(e))


@app.route("/hof/upsert", methods=["POST", "OPTIONS"])
def hof_upsert():
    if request.method == "OPTIONS":
        return ok({})

    header_secret = (request.headers.get("X-Importer-Secret") or "").strip()
    if not check_importer_secret(header_secret):
        return fail("Invalid importer secret", 401)

    try:
        body = request.get_json(force=True, silent=False) or {}
    except Exception:
        return fail("Bad JSON", 400)

    rows = body.get("rows") or []
    if not isinstance(rows, list):
        return fail("rows must be a list", 400)

    imported = import_hof_workers_from_payload_local({"rows": rows})
    return ok({"imported": imported, "hof_count": hof_count(), "server_time": utc_now()})


@app.route("/admin/uploader", methods=["GET"])
def admin_uploader():
    html = """
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>T.S.E HoF Uploader</title>
  <style>
    body{font-family:Arial,sans-serif;background:#0b1220;color:#eef3ff;margin:0;padding:20px}
    .card{max-width:760px;margin:0 auto;background:#0f1b33;border:1px solid rgba(214,179,90,.28);border-radius:18px;padding:18px;box-shadow:0 18px 60px rgba(0,0,0,.45)}
    h1{margin:0 0 8px;font-size:22px}
    .sub{color:#aebddd;font-size:13px;margin-bottom:18px}
    label{display:block;margin:12px 0 6px;color:#aebddd;font-size:12px;font-weight:700}
    input,textarea{width:100%;box-sizing:border-box;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:#0b1220;color:#eef3ff}
    button{margin-top:14px;padding:12px 14px;border-radius:12px;border:1px solid rgba(214,179,90,.35);background:#13213f;color:#eef3ff;font-weight:700;cursor:pointer}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    .row > div{flex:1 1 220px}
    .ok{color:#34d57a}
    .err{color:#ff5968}
    pre{background:#0b1220;padding:12px;border-radius:12px;overflow:auto;border:1px solid rgba(255,255,255,.08)}
  </style>
</head>
<body>
  <div class="card">
    <h1>T.S.E Headquarters HoF Uploader</h1>
    <div class="sub">Upload your <b>hof_workers.json</b> from your phone or paste JSON directly.</div>

    <div class="row">
      <div>
        <label>Importer Secret</label>
        <input id="secret" type="password" placeholder="IMPORTER_SECRET">
      </div>
      <div>
        <label>JSON File</label>
        <input id="file" type="file" accept=".json,application/json">
      </div>
    </div>

    <label>Or Paste JSON</label>
    <textarea id="json" rows="12" placeholder='{"rows":[{"id":"123","name":"Player","manual_labor":1,"intelligence":2,"endurance":3,"job_status":"company","company_name":"Example"}]}'></textarea>

    <div class="row">
      <div><button id="uploadFile">Upload File</button></div>
      <div><button id="uploadJson">Upload Pasted JSON</button></div>
      <div><button id="serverImport">Run Server File Import</button></div>
    </div>

    <label>Result</label>
    <pre id="result">Ready.</pre>
  </div>

<script>
const result = document.getElementById("result");

function show(obj, isError=false){
  result.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  result.className = isError ? "err" : "ok";
}

async function postJson(url, body, secret){
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Importer-Secret": secret
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error((json && (json.error || json.details)) || text || ("HTTP " + res.status));
  return json;
}

document.getElementById("uploadJson").onclick = async () => {
  const secret = document.getElementById("secret").value.trim();
  const raw = document.getElementById("json").value.trim();
  if (!secret) return show("Missing importer secret", true);
  if (!raw) return show("Paste some JSON first", true);

  try {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : (parsed.rows || parsed.results || parsed.players || parsed.workers || parsed.data || []);
    const json = await postJson("/hof/upsert", { rows }, secret);
    show(json);
  } catch (e) {
    show(e.message || String(e), true);
  }
};

document.getElementById("uploadFile").onclick = async () => {
  const secret = document.getElementById("secret").value.trim();
  const file = document.getElementById("file").files[0];
  if (!secret) return show("Missing importer secret", true);
  if (!file) return show("Choose a JSON file first", true);

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : (parsed.rows || parsed.results || parsed.players || parsed.workers || parsed.data || []);
    const json = await postJson("/hof/upsert", { rows }, secret);
    show(json);
  } catch (e) {
    show(e.message || String(e), true);
  }
};

document.getElementById("serverImport").onclick = async () => {
  const secret = document.getElementById("secret").value.trim();
  if (!secret) return show("Missing importer secret", true);

  try {
    const res = await fetch("/hof/import", {
      method: "POST",
      headers: { "X-Importer-Secret": secret }
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error((json && (json.error || json.details)) || text || ("HTTP " + res.status));
    show(json);
  } catch (e) {
    show(e.message || String(e), true);
  }
};
</script>
</body>
</html>
"""
    return Response(html, mimetype="text/html")


@app.route("/hof/upload-json", methods=["POST", "OPTIONS"])
def hof_upload_json():
    if request.method == "OPTIONS":
        return ok({})

    header_secret = (request.headers.get("X-Importer-Secret") or request.form.get("secret") or "").strip()
    if not check_importer_secret(header_secret):
        return fail("Invalid importer secret", 401)

    if "file" not in request.files:
        return fail("Missing file", 400)

    f = request.files["file"]
    if not f or not f.filename:
        return fail("Missing file", 400)

    try:
        raw = f.read()
        payload = json.loads(raw.decode("utf-8"))
        imported = import_hof_workers_from_payload_local(payload)
        return ok({"imported": imported, "hof_count": hof_count(), "server_time": utc_now()})
    except Exception as e:
        return fail("Upload import failed", 500, str(e))


init_db()

if __name__ == "__main__":
    port = int(os.getenv("PORT", "10000"))
    app.run(host="0.0.0.0", port=port)
