import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from flask import Flask, jsonify, request, Response
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
    list_hof_workers,
    upsert_hof_worker,
    hof_count,
    save_company_key,
    list_company_keys,
    delete_company_key,
)
from torn_api import me_basic, company_profile, normalize_company
from importer import import_hof_workers_from_json_file

load_dotenv()
app = Flask(__name__)

ADMIN_KEYS = [k.strip() for k in (os.getenv("ADMIN_KEYS") or "").split(",") if k.strip()]
IMPORTER_SECRET = (os.getenv("IMPORTER_SECRET") or "").strip()
HOF_DATA_FILE = (os.getenv("HOF_DATA_FILE") or "hof_workers.json").strip()


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

    user_id = str(me.get("player_id") or me.get("user_id") or "")
    name = str(me.get("name") or "")

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

    cleaned: List[str] = []
    for x in raw_ids:
        s = str(x).strip()
        if not s or not s.isdigit():
            continue
        if s not in cleaned:
            cleaned.append(s)

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

    user_company_ids = [str(x).strip() for x in (user.get("company_ids") or []) if str(x).strip()]
    if company_id not in user_company_ids:
        return fail("Company ID must be saved in Settings first", 400)

    save_company_key(session["user_id"], company_id, api_key)
    return ok({
        "saved": True,
        "company_id": company_id,
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

    company_ids = [str(x) for x in (user.get("company_ids") or []) if str(x).strip()]
    companies: List[Dict[str, Any]] = []

    for cid in company_ids[:25]:
        try:
            raw = company_profile(user["api_key"], cid)
            companies.append(normalize_company(cid, raw))
        except Exception:
            companies.append({"id": str(cid), "name": f"Company #{cid}", "director": "", "employees": []})

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
            "company_ids": company_ids,
        },
        "companies": companies,
        "company_keys": list_company_keys(user["user_id"]),
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

    try:
        body = request.get_json(force=True, silent=False) or {}
    except Exception:
        return fail("Bad JSON", 400)

    def as_int(value: Any, default: int = 0) -> int:
        try:
            return int(value)
        except Exception:
            return default

    min_total = as_int(body.get("min_total"), 0)
    max_total = as_int(body.get("max_total"), 10**12)
    if max_total <= 0:
        max_total = 10**12

    min_man = as_int(body.get("min_man"), 0)
    min_int = as_int(body.get("min_int"), 0)
    min_end = as_int(body.get("min_end"), 0)
    limit = max(1, min(100, as_int(body.get("limit"), 50)))
    status = str(body.get("status") or "any").strip().lower()

    results = []
    for row in list_hof_workers():
        man = int(row.get("manual_labor") or 0)
        intl = int(row.get("intelligence") or 0)
        end = int(row.get("endurance") or 0)
        total = man + intl + end
        job_status = str(row.get("job_status") or "unknown").lower()

        if total < min_total or total > max_total:
            continue
        if man < min_man or intl < min_int or end < min_end:
            continue
        if status != "any" and job_status != status:
            continue

        row["total"] = total
        results.append(row)

    results.sort(key=lambda r: int(r.get("total") or 0), reverse=True)
    sliced = results[:limit]
    return ok({"results": sliced, "count": len(sliced), "server_time": utc_now()})


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
