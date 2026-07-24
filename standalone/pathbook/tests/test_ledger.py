"""Ledger suite — proves the event log is tamper-evident: payload edits,
chain rewrites, row deletion, and wrong-secret reseals are all detected."""

import json
import sqlite3

import pytest

from pathbook.ledger import append_event, init_ledger, verify_chain

SECRET = b"s" * 32
WRONG = b"w" * 32


@pytest.fixture()
def conn():
    c = sqlite3.connect(":memory:")
    init_ledger(c)
    for i in range(5):
        append_event(c, SECRET, "test", {"i": i})
    return c


class TestLedger:
    def test_intact_chain_verifies(self, conn):
        res = verify_chain(conn, SECRET)
        assert res == {"ok": True, "entries": 5, "first_bad_seq": None, "reason": None}

    def test_empty_ledger_ok(self):
        c = sqlite3.connect(":memory:")
        init_ledger(c)
        assert verify_chain(c, SECRET)["ok"]

    def test_payload_tamper_detected(self, conn):
        row = conn.execute("SELECT payload FROM ledger WHERE seq=3").fetchone()[0]
        payload = json.loads(row)
        payload["i"] = 999
        conn.execute("UPDATE ledger SET payload=? WHERE seq=3", (json.dumps(payload, sort_keys=True, separators=(",", ":")),))
        res = verify_chain(conn, SECRET)
        assert not res["ok"] and res["first_bad_seq"] == 3 and "tampered" in res["reason"]

    def test_chain_rewrite_without_secret_detected(self, conn):
        # Attacker edits payload AND recomputes hashes — but cannot re-seal.
        import hashlib
        row = conn.execute("SELECT payload, prev_hash FROM ledger WHERE seq=3").fetchone()
        payload = json.loads(row[0])
        payload["i"] = 999
        pj = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        h = hashlib.sha256()
        h.update(row[1].encode())
        h.update(pj.encode())
        conn.execute("UPDATE ledger SET payload=?, entry_hash=? WHERE seq=3", (pj, h.hexdigest()))
        res = verify_chain(conn, SECRET)
        assert not res["ok"]
        # either downstream chain break (seq 4 prev mismatch) or seal failure at 3
        assert res["first_bad_seq"] in (3, 4)

    def test_row_deletion_detected(self, conn):
        conn.execute("DELETE FROM ledger WHERE seq=3")
        res = verify_chain(conn, SECRET)
        assert not res["ok"] and res["first_bad_seq"] == 4 and "chain break" in res["reason"]

    def test_wrong_secret_detected(self, conn):
        res = verify_chain(conn, WRONG)
        assert not res["ok"] and "seal" in res["reason"].lower()
