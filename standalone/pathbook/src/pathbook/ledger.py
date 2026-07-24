"""Hash-chained, HMAC-sealed event ledger.

Every state mutation in the registry (contribution, outcome report, tier
transition, flag) appends an entry:

    entry_hash = SHA256(prev_hash || canonical(payload))
    seal       = HMAC-SHA256(registry_secret, entry_hash)

Tampering with any historical row breaks the chain from that row forward;
recomputing the chain without the registry secret breaks every seal.
``verify_chain`` walks the full ledger and reports the first bad row.

The ledger lives in the same SQLite database as the records and is written in
the same transaction as the mutation it describes — a mutation and its ledger
entry are atomic: both land or neither does.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
from pathlib import Path
from typing import Any, Optional

from .schema import utcnow_iso

GENESIS_HASH = "0" * 64


def _canonical(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _entry_hash(prev_hash: str, payload: dict[str, Any]) -> str:
    h = hashlib.sha256()
    h.update(prev_hash.encode("ascii"))
    h.update(_canonical(payload))
    return h.hexdigest()


def _seal(secret: bytes, entry_hash: str) -> str:
    return hmac.new(secret, entry_hash.encode("ascii"), hashlib.sha256).hexdigest()


def registry_state_hash(conn: sqlite3.Connection) -> str:
    """Hash every security-relevant materialized table in stable order."""
    existing = {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    tables = {}
    for table, order_by in (
        ("pathbooks", "id"),
        ("outcomes", "seq"),
        ("reporter_keys", "reporter_id"),
        ("applications", "application_id"),
    ):
        tables[table] = (
            conn.execute(f"SELECT * FROM {table} ORDER BY {order_by}").fetchall()
            if table in existing
            else []
        )
    return hashlib.sha256(_canonical(tables)).hexdigest()


def init_ledger(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ledger (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL,
            prev_hash TEXT NOT NULL,
            entry_hash TEXT NOT NULL,
            seal TEXT NOT NULL
        )
        """
    )


def append_event(
    conn: sqlite3.Connection,
    secret: bytes,
    event_type: str,
    payload: dict[str, Any],
) -> str:
    """Append an event inside the caller's open transaction. Returns entry_hash."""
    row = conn.execute("SELECT entry_hash FROM ledger ORDER BY seq DESC LIMIT 1").fetchone()
    prev_hash = row[0] if row else GENESIS_HASH
    full_payload = {
        "event_type": event_type,
        "ts": utcnow_iso(),
        **payload,
        "registry_state_hash": registry_state_hash(conn),
    }
    entry_hash = _entry_hash(prev_hash, full_payload)
    conn.execute(
        "INSERT INTO ledger (ts, event_type, payload, prev_hash, entry_hash, seal) VALUES (?,?,?,?,?,?)",
        (
            full_payload["ts"],
            event_type,
            json.dumps(full_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False),
            prev_hash,
            entry_hash,
            _seal(secret, entry_hash),
        ),
    )
    return entry_hash


def _checkpoint_payload(conn: sqlite3.Connection) -> dict[str, Any]:
    row = conn.execute(
        "SELECT seq, entry_hash FROM ledger ORDER BY seq DESC LIMIT 1"
    ).fetchone()
    return {
        "seq": int(row[0]) if row else 0,
        "entry_hash": row[1] if row else GENESIS_HASH,
        "registry_state_hash": registry_state_hash(conn),
    }


def write_checkpoint(conn: sqlite3.Connection, secret: bytes, path: Path) -> None:
    """Atomically persist an HMAC-sealed ledger head outside the database."""
    payload = _checkpoint_payload(conn)
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    document = {
        "payload": payload,
        "seal": hmac.new(secret, payload_json.encode("utf-8"), hashlib.sha256).hexdigest(),
    }
    tmp_path = path.with_name(f"{path.name}.{os.getpid()}.{secrets.token_hex(8)}.tmp")
    tmp_path.write_text(
        json.dumps(document, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(tmp_path, path)


def verify_checkpoint(conn: sqlite3.Connection, secret: bytes, path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"ok": False, "reason": "external ledger checkpoint missing"}
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        payload = document["payload"]
        seal = document["seal"]
        payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        expected_seal = hmac.new(secret, payload_json.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected_seal, seal):
            return {"ok": False, "reason": "external ledger checkpoint seal invalid"}
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return {"ok": False, "reason": "external ledger checkpoint malformed"}
    current = _checkpoint_payload(conn)
    if payload != current:
        return {
            "ok": False,
            "reason": "external checkpoint does not match ledger head or registry state",
            "checkpoint": payload,
            "current": current,
        }
    return {"ok": True, "reason": None, **current}


def verify_chain(
    conn: sqlite3.Connection,
    secret: bytes,
    checkpoint_path: Optional[Path] = None,
) -> dict[str, Any]:
    """Walk the entire ledger. Returns {ok, entries, first_bad_seq, reason}."""
    prev_hash = GENESIS_HASH
    count = 0
    last_payload: Optional[dict[str, Any]] = None
    for seq, payload_json, stored_prev, stored_hash, stored_seal in conn.execute(
        "SELECT seq, payload, prev_hash, entry_hash, seal FROM ledger ORDER BY seq ASC"
    ):
        count += 1
        if stored_prev != prev_hash:
            return {"ok": False, "entries": count, "first_bad_seq": seq, "reason": "chain break: prev_hash mismatch"}
        try:
            payload = json.loads(payload_json)
        except json.JSONDecodeError:
            return {"ok": False, "entries": count, "first_bad_seq": seq, "reason": "payload not valid JSON"}
        expect_hash = _entry_hash(stored_prev, payload)
        if expect_hash != stored_hash:
            return {"ok": False, "entries": count, "first_bad_seq": seq, "reason": "entry_hash mismatch (payload tampered)"}
        if not hmac.compare_digest(_seal(secret, stored_hash), stored_seal):
            return {"ok": False, "entries": count, "first_bad_seq": seq, "reason": "HMAC seal invalid (chain rewritten without registry secret)"}
        last_payload = payload
        prev_hash = stored_hash
    current_state_hash = registry_state_hash(conn)
    if last_payload is not None and last_payload.get("registry_state_hash") != current_state_hash:
        return {
            "ok": False,
            "entries": count,
            "first_bad_seq": count or None,
            "reason": "materialized registry state does not match ledger head",
        }
    if checkpoint_path is not None:
        checkpoint = verify_checkpoint(conn, secret, checkpoint_path)
        if not checkpoint["ok"]:
            return {
                "ok": False,
                "entries": count,
                "first_bad_seq": None,
                "reason": checkpoint["reason"],
                "checkpoint": checkpoint,
            }
    return {"ok": True, "entries": count, "first_bad_seq": None, "reason": None}
