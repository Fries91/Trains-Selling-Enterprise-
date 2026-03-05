import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from flask import Flask, jsonify, request
from dotenv import load_dotenv

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
)
from torn_api import me_basic, company_profile, normalize_company

load_dotenv()
app = Flask(__name__)

ADMIN_KEYS = [k.strip() for k in (os.getenv("ADMIN_KEYS") or "").split(",") if k.strip()]


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


@app.after_request
def add_cors_headers(resp):
    # Userscripts call cross-origin, so keep CORS permissive.
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Session-Token"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    return resp


@app.route("/health", methods=["GET"])
def health():
    return ok({"service": "company-hub", "server_time": utc_now()})


@app.route("/api/auth", methods=["POST", "OPTIONS"])
def api_auth():
    if request.method == "OPTIONS":
        return ok({"ok": True})

    try:
        body = request.get_json(force=True, silent=False) or {}
    except Exception:
        return fail("Bad JSON", 400)

    admin_key = (body.get("admin_key") or "").strip()
    api_key = (body.get("api_key") or "").strip()

    if not ADMIN_KEYS:
        return fail("Server missing ADMIN_KEYS env var", 500)

    if not admin_key or admin_key not in ADMIN_KEYS:
        return fail("Invalid Admin Key", 401)

    if not api_key:
        return fail("Missing API Key", 400)

    try:
        me = me_basic(api_key)
    except Exception as e:
        return fail("API Key validation failed", 401, str(e))

    user_id = str(me.get("player_id") or me.get("user_id") or "")
    name = str(me.get("name") or "")

    if not user_id:
        return fail("Torn API response missing player_id", 401)

    upsert_user(user_id=user_id, name=name, api_key=api_key)

    token = create_session(user_id)
    user = {"id": user_id, "name": name}

    return ok({"token": token, "user": user, "server_time": utc_now()})


def require_session() -> Optional[Dict[str, Any]]:
    token = (request.headers.get("X-Session-Token") or "").strip()
    if not token:
        return None
    ses = get_session(token)
    if not ses:
        return None
    touch_session(token)
    touch_user(ses["user_id"])
    return ses


@app.route("/company_ids", methods=["GET", "POST", "OPTIONS"])
def company_ids():
    if request.method == "OPTIONS":
        return ok({"ok": True})

    ses = require_session()
    if not ses:
        return fail("Missing/invalid session token", 401)

    user = get_user(ses["user_id"])
    if not user:
        return fail("User not found", 404)

    if request.method == "GET":
        ids = user.get("company_ids") or []
        if not isinstance(ids, list):
            ids = []
        return ok({"company_ids": [str(x) for x in ids], "server_time": utc_now()})

    # POST: replace list
    try:
        body = request.get_json(force=True, silent=False) or {}
    except Exception:
        return fail("Bad JSON", 400)

    ids = body.get("company_ids", [])
    if not isinstance(ids, list):
        return fail("company_ids must be a list", 400)

    cleaned: List[str] = []
    for x in ids:
        s = str(x).strip()
        if not s:
            continue
        if not s.isdigit():
            continue
        if s not in cleaned:
            cleaned.append(s)

    set_company_ids(ses["user_id"], cleaned)
    return ok({"saved": True, "company_ids": cleaned, "server_time": utc_now()})


@app.route("/state", methods=["GET", "OPTIONS"])
def state():
    if request.method == "OPTIONS":
        return ok({"ok": True})

    ses = require_session()
    if not ses:
        return fail("Missing/invalid session token", 401)

    user = get_user(ses["user_id"])
    if not user:
        return fail("User not found", 404)

    company_ids: List[str] = []
    raw_ids = user.get("company_ids") or []
    if isinstance(raw_ids, list):
        company_ids = [str(x) for x in raw_ids if str(x).strip()]

    companies: List[Dict[str, Any]] = []
    for cid in company_ids[:25]:
        try:
            raw = company_profile(user["api_key"], cid)
            companies.append(normalize_company(cid, raw))
        except Exception:
            companies.append({"id": str(cid), "name": f"Company #{cid}", "director": "", "employees": []})

    trains = list_trains(user["user_id"])

    # attach company_name for UI convenience
    name_map = {c["id"]: c.get("name") for c in companies}
    for t in trains:
        cid = str(t.get("company_id") or "")
        if cid and cid in name_map:
            t["company_name"] = name_map[cid]

    return ok(
        {
            "user": {"id": user["user_id"], "name": user.get("name", "")},
            "companies": companies,
            "trains": trains,
            "server_time": utc_now(),
        }
    )


@app.route("/trains", methods=["POST", "OPTIONS"])
def trains_add():
    if request.method == "OPTIONS":
        return ok({"ok": True})

    ses = require_session()
    if not ses:
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

    new_id = add_train(
        user_id=ses["user_id"],
        company_id=company_id,
        buyer=buyer,
        amount=amount,
        note=note,
    )
    return ok({"id": new_id, "server_time": utc_now()})


@app.route("/trains/<train_id>", methods=["DELETE", "OPTIONS"])
def trains_delete(train_id: str):
    if request.method == "OPTIONS":
        return ok({"ok": True})

    ses = require_session()
    if not ses:
        return fail("Missing/invalid session token", 401)

    try:
        tid = int(train_id)
    except Exception:
        return fail("Invalid train id", 400)

    removed = delete_train(ses["user_id"], tid)
    if not removed:
        return fail("Train record not found", 404)

    return ok({"deleted": True, "server_time": utc_now()})


# Init db on import (works on Render too)
init_db()

if __name__ == "__main__":
    port = int(os.getenv("PORT", "10000"))
    app.run(host="0.0.0.0", port=port)
