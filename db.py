import json
import os
import secrets
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

DB_PATH = os.getenv("DB_PATH", "tse_headquarters.db")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_parent_dir(path: str):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)


def _con():
    _ensure_parent_dir(DB_PATH)
    con = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    con = _con()
    cur = con.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            name TEXT DEFAULT '',
            api_key TEXT NOT NULL,
            company_ids TEXT NOT NULL DEFAULT '[]',
            created_at TEXT,
            last_seen_at TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at TEXT,
            last_seen_at TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS trains (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            company_id TEXT DEFAULT '',
            buyer TEXT DEFAULT '',
            amount INTEGER DEFAULT 0,
            note TEXT DEFAULT '',
            created_at TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS hof_workers (
            id TEXT PRIMARY KEY,
            name TEXT DEFAULT '',
            manual_labor INTEGER DEFAULT 0,
            intelligence INTEGER DEFAULT 0,
            endurance INTEGER DEFAULT 0,
            total INTEGER DEFAULT 0,
            job_status TEXT DEFAULT 'unknown',
            company_name TEXT DEFAULT '',
            updated_at TEXT
        )
    """)

    con.commit()
    con.close()


def upsert_user(user_id: str, name: str, api_key: str):
    con = _con()
    cur = con.cursor()
    now = _utc_now()
    cur.execute("""
        INSERT INTO users (user_id, name, api_key, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            name=excluded.name,
            api_key=excluded.api_key,
            last_seen_at=excluded.last_seen_at
    """, (user_id, name or "", api_key, now, now))
    con.commit()
    con.close()


def touch_user(user_id: str):
    con = _con()
    cur = con.cursor()
    cur.execute("UPDATE users SET last_seen_at=? WHERE user_id=?", (_utc_now(), user_id))
    con.commit()
    con.close()


def get_user(user_id: str) -> Optional[Dict[str, Any]]:
    con = _con()
    cur = con.cursor()
    cur.execute("SELECT * FROM users WHERE user_id=?", (user_id,))
    row = cur.fetchone()
    con.close()
    if not row:
        return None
    d = dict(row)
    try:
        d["company_ids"] = json.loads(d.get("company_ids") or "[]")
    except Exception:
        d["company_ids"] = []
    return d


def set_company_ids(user_id: str, company_ids: List[str]):
    con = _con()
    cur = con.cursor()
    cur.execute(
        "UPDATE users SET company_ids=?, last_seen_at=? WHERE user_id=?",
        (json.dumps(company_ids or []), _utc_now(), user_id)
    )
    con.commit()
    con.close()


def create_session(user_id: str) -> str:
    token = secrets.token_urlsafe(24)
    con = _con()
    cur = con.cursor()
    now = _utc_now()
    cur.execute("""
        INSERT INTO sessions (token, user_id, created_at, last_seen_at)
        VALUES (?, ?, ?, ?)
    """, (token, user_id, now, now))
    con.commit()
    con.close()
    return token


def get_session(token: str) -> Optional[Dict[str, Any]]:
    con = _con()
    cur = con.cursor()
    cur.execute("SELECT * FROM sessions WHERE token=?", (token,))
    row = cur.fetchone()
    con.close()
    return dict(row) if row else None


def touch_session(token: str):
    con = _con()
    cur = con.cursor()
    cur.execute("UPDATE sessions SET last_seen_at=? WHERE token=?", (_utc_now(), token))
    con.commit()
    con.close()


def add_train(user_id: str, company_id: str, buyer: str, amount: int, note: str) -> int:
    con = _con()
    cur = con.cursor()
    cur.execute("""
        INSERT INTO trains (user_id, company_id, buyer, amount, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (user_id, company_id or "", buyer or "", int(amount or 0), note or "", _utc_now()))
    con.commit()
    new_id = int(cur.lastrowid)
    con.close()
    return new_id


def list_trains(user_id: str) -> List[Dict[str, Any]]:
    con = _con()
    cur = con.cursor()
    cur.execute("SELECT * FROM trains WHERE user_id=? ORDER BY id DESC LIMIT 300", (user_id,))
    rows = cur.fetchall()
    con.close()
    return [dict(r) for r in rows]


def delete_train(user_id: str, train_id: int) -> bool:
    con = _con()
    cur = con.cursor()
    cur.execute("DELETE FROM trains WHERE user_id=? AND id=?", (user_id, int(train_id)))
    con.commit()
    ok = cur.rowcount > 0
    con.close()
    return ok


def upsert_hof_worker(
    player_id: str,
    name: str,
    manual_labor: int,
    intelligence: int,
    endurance: int,
    job_status: str,
    company_name: str = ""
):
    total = int(manual_labor or 0) + int(intelligence or 0) + int(endurance or 0)
    con = _con()
    cur = con.cursor()
    cur.execute("""
        INSERT INTO hof_workers (
            id, name, manual_labor, intelligence, endurance, total,
            job_status, company_name, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            manual_labor=excluded.manual_labor,
            intelligence=excluded.intelligence,
            endurance=excluded.endurance,
            total=excluded.total,
            job_status=excluded.job_status,
            company_name=excluded.company_name,
            updated_at=excluded.updated_at
    """, (
        str(player_id),
        name or "",
        int(manual_labor or 0),
        int(intelligence or 0),
        int(endurance or 0),
        total,
        job_status or "unknown",
        company_name or "",
        _utc_now(),
    ))
    con.commit()
    con.close()


def list_hof_workers() -> List[Dict[str, Any]]:
    con = _con()
    cur = con.cursor()
    cur.execute("SELECT * FROM hof_workers ORDER BY total DESC, name ASC")
    rows = cur.fetchall()
    con.close()
    return [dict(r) for r in rows]
