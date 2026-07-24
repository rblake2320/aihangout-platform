"""SQLite persistence for pbp-0.1.

Design points:

- ``error_fingerprint`` is indexed, so exact-hash lookup is an index seek —
  the O(1)-style "hash -> hit" retrieval the protocol wants, not a load-100-
  and-rank-in-application-code scan.
- A second composite index on ``(runtime, trust_tier, confidence DESC)``
  serves scoped/ranked listing.
- WAL journal mode + busy_timeout gives crash-safe atomic commits and sane
  cross-process behavior; every mutation happens inside a single transaction
  together with its ledger entry.
- ``(pathbook_id, application_id)`` is UNIQUE on outcomes: reporting the same
  application twice is idempotent by construction, enforced by the database,
  not by application-code politeness.
"""

from __future__ import annotations

import json
import os
import secrets
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Optional

from . import ledger as ledger_mod
from .schema import OutcomeReport, PathbookRecord, Provenance, TrustTier

_SCHEMA = """
CREATE TABLE IF NOT EXISTS pathbooks (
    id TEXT PRIMARY KEY,
    protocol TEXT NOT NULL,
    title TEXT NOT NULL,
    error_signature TEXT NOT NULL,
    error_fingerprint TEXT NOT NULL,
    context_fingerprint TEXT NOT NULL,
    ecosystem TEXT NOT NULL DEFAULT '',
    runtime TEXT NOT NULL DEFAULT '',
    package_name TEXT NOT NULL DEFAULT '',
    trigger_yaml TEXT NOT NULL,
    remediation_yaml TEXT NOT NULL,
    verify_yaml TEXT NOT NULL,
    failed_attempts_yaml TEXT NOT NULL DEFAULT '',
    safety_class TEXT NOT NULL DEFAULT 'low',
    safety_flags TEXT NOT NULL DEFAULT '[]',
    requires_confirmation INTEGER NOT NULL DEFAULT 0,
    token_savings_estimate INTEGER NOT NULL DEFAULT 0,
    provenance TEXT NOT NULL,
    signature TEXT NOT NULL,
    trust_tier TEXT NOT NULL DEFAULT 'draft',
    times_applied INTEGER NOT NULL DEFAULT 0,
    times_succeeded INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0.5,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pathbooks_fingerprint ON pathbooks (error_fingerprint);
CREATE INDEX IF NOT EXISTS idx_pathbooks_scope ON pathbooks (runtime, trust_tier, confidence DESC);

CREATE TABLE IF NOT EXISTS outcomes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    pathbook_id TEXT NOT NULL REFERENCES pathbooks(id),
    application_id TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    reporter_public_key TEXT NOT NULL,
    outcome TEXT NOT NULL,
    verify_passed INTEGER NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    evidence TEXT,
    reported_at TEXT NOT NULL,
    signature TEXT NOT NULL,
    counted INTEGER NOT NULL DEFAULT 1,
    UNIQUE (pathbook_id, application_id)
);
CREATE INDEX IF NOT EXISTS idx_outcomes_pathbook ON outcomes (pathbook_id);

CREATE TABLE IF NOT EXISTS applications (
    application_id TEXT PRIMARY KEY,
    pathbook_id TEXT NOT NULL REFERENCES pathbooks(id),
    pathbook_signature TEXT NOT NULL,
    executor_id TEXT,
    executor_public_key TEXT,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_applications_pathbook ON applications (pathbook_id);
CREATE INDEX IF NOT EXISTS idx_applications_expiry ON applications (expires_at);

CREATE TABLE IF NOT EXISTS reporter_keys (
    reporter_id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL
);
"""


def _load_or_create_secret(secret_path: Path) -> bytes:
    """Registry HMAC secret lives in a sidecar file, NOT inside the database —
    a tamper-evidence secret stored next to the thing it seals, inside the
    same file an attacker rewrites, would be theater.

    POSIX: file is created 0600. Windows delta: chmod is a no-op there; place
    the file on an NTFS path with a restrictive ACL (or point
    PATHBOOK_SECRET_FILE at DPAPI/CNG-protected storage).
    """
    if secret_path.exists():
        return secret_path.read_bytes()
    secret = secrets.token_bytes(32)
    fd = os.open(str(secret_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, secret)
    finally:
        os.close(fd)
    return secret


class Store:
    """Owns the SQLite database, the ledger, and the registry secret."""

    def __init__(self, db_path: str | Path, secret: Optional[bytes] = None):
        self.db_path = Path(db_path)
        self.checkpoint_path = self.db_path.with_suffix(self.db_path.suffix + ".checkpoint")
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        if secret is None:
            env_file = os.environ.get("PATHBOOK_SECRET_FILE")
            secret_path = Path(env_file) if env_file else self.db_path.with_suffix(self.db_path.suffix + ".secret")
            secret = _load_or_create_secret(secret_path)
        self.secret = secret
        with self.connect() as conn:
            conn.executescript(_SCHEMA)
            self._migrate(conn)
            ledger_mod.init_ledger(conn)
            if not self.checkpoint_path.exists():
                ledger_mod.write_checkpoint(conn, self.secret, self.checkpoint_path)

    def refresh_checkpoint(self) -> None:
        """Seal the latest committed database/ledger head in a sidecar file."""
        with self.connect() as conn:
            # Serialize sidecar replacement with SQLite's writer lock. This is
            # required on Windows, where concurrent os.replace calls can fail,
            # and ensures an older process cannot overwrite a newer head.
            conn.execute("BEGIN IMMEDIATE")
            try:
                ledger_mod.write_checkpoint(conn, self.secret, self.checkpoint_path)
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise

    @staticmethod
    def _migrate(conn: sqlite3.Connection) -> None:
        """Add pbp-0.1 hardening columns to registries created by early builds."""
        pathbook_cols = {row[1] for row in conn.execute("PRAGMA table_info(pathbooks)")}
        additions = {
            "context_fingerprint": "TEXT",
            "safety_class": "TEXT NOT NULL DEFAULT 'low'",
            "safety_flags": "TEXT NOT NULL DEFAULT '[]'",
            "requires_confirmation": "INTEGER NOT NULL DEFAULT 0",
        }
        for name, ddl in additions.items():
            if name not in pathbook_cols:
                conn.execute(f"ALTER TABLE pathbooks ADD COLUMN {name} {ddl}")
        from .fingerprint import context_fingerprint
        rows = conn.execute(
            "SELECT id, error_signature FROM pathbooks "
            "WHERE context_fingerprint IS NULL OR context_fingerprint = ''"
        ).fetchall()
        for pathbook_id, error_signature in rows:
            conn.execute(
                "UPDATE pathbooks SET context_fingerprint = ? WHERE id = ?",
                (context_fingerprint(error_signature), pathbook_id),
            )
        from .validation import remediation_risk
        for pathbook_id, remediation_yaml in conn.execute(
            "SELECT id, remediation_yaml FROM pathbooks"
        ).fetchall():
            safety_class, safety_flags = remediation_risk(remediation_yaml)
            conn.execute(
                "UPDATE pathbooks SET safety_class = ?, safety_flags = ?, "
                "requires_confirmation = ? WHERE id = ?",
                (
                    safety_class,
                    json.dumps(safety_flags),
                    int(safety_class == "high"),
                    pathbook_id,
                ),
            )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_pathbooks_context_fingerprint "
            "ON pathbooks (context_fingerprint)"
        )
        outcome_cols = {row[1] for row in conn.execute("PRAGMA table_info(outcomes)")}
        if "evidence" not in outcome_cols:
            conn.execute("ALTER TABLE outcomes ADD COLUMN evidence TEXT")

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0, isolation_level=None)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    # ---- row mapping ---------------------------------------------------

    _COLS = (
        "id, protocol, title, error_signature, error_fingerprint, ecosystem, runtime, "
        "context_fingerprint, package_name, trigger_yaml, remediation_yaml, verify_yaml, failed_attempts_yaml, "
        "safety_class, safety_flags, requires_confirmation, "
        "token_savings_estimate, provenance, signature, trust_tier, times_applied, "
        "times_succeeded, confidence, active, updated_at"
    )

    @staticmethod
    def _row_to_record(row: tuple) -> PathbookRecord:
        (
            id_, protocol, title, error_signature, error_fingerprint, ecosystem, runtime,
            context_fingerprint, package_name, trigger_yaml, remediation_yaml, verify_yaml, failed_attempts_yaml,
            safety_class, safety_flags, requires_confirmation,
            token_savings_estimate, provenance, signature, trust_tier, times_applied,
            times_succeeded, confidence, active, updated_at,
        ) = row
        return PathbookRecord(
            id=id_, protocol=protocol, title=title, error_signature=error_signature,
            error_fingerprint=error_fingerprint, ecosystem=ecosystem, runtime=runtime,
            context_fingerprint=context_fingerprint,
            package_name=package_name, trigger_yaml=trigger_yaml,
            remediation_yaml=remediation_yaml, verify_yaml=verify_yaml,
            failed_attempts_yaml=failed_attempts_yaml,
            safety_class=safety_class, safety_flags=json.loads(safety_flags),
            requires_confirmation=bool(requires_confirmation),
            token_savings_estimate=token_savings_estimate,
            provenance=Provenance(**json.loads(provenance)), signature=signature,
            trust_tier=TrustTier(trust_tier), times_applied=times_applied,
            times_succeeded=times_succeeded, confidence=confidence,
            active=bool(active), updated_at=updated_at,
        )

    # ---- reads ---------------------------------------------------------

    def get(self, conn: sqlite3.Connection, pathbook_id: str) -> Optional[PathbookRecord]:
        row = conn.execute(f"SELECT {self._COLS} FROM pathbooks WHERE id = ?", (pathbook_id,)).fetchone()
        return self._row_to_record(row) if row else None

    def by_fingerprint(self, conn: sqlite3.Connection, fp: str) -> list[PathbookRecord]:
        rows = conn.execute(
            f"SELECT {self._COLS} FROM pathbooks WHERE error_fingerprint = ?", (fp,)
        ).fetchall()
        return [self._row_to_record(r) for r in rows]

    def by_context_fingerprint(self, conn: sqlite3.Connection, fp: str) -> list[PathbookRecord]:
        rows = conn.execute(
            f"SELECT {self._COLS} FROM pathbooks WHERE context_fingerprint = ?", (fp,)
        ).fetchall()
        return [self._row_to_record(r) for r in rows]

    def list(
        self,
        conn: sqlite3.Connection,
        runtime: Optional[str] = None,
        ecosystem: Optional[str] = None,
        trust_tier: Optional[str] = None,
        active_only: bool = True,
        limit: int = 50,
        offset: int = 0,
    ) -> list[PathbookRecord]:
        clauses, params = [], []
        if active_only:
            clauses.append("active = 1")
        if runtime:
            clauses.append("runtime = ?"); params.append(runtime)
        if ecosystem:
            clauses.append("ecosystem = ?"); params.append(ecosystem)
        if trust_tier:
            clauses.append("trust_tier = ?"); params.append(trust_tier)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        params.extend([max(1, min(limit, 200)), max(0, offset)])
        rows = conn.execute(
            f"SELECT {self._COLS} FROM pathbooks {where} "
            "ORDER BY confidence DESC, id ASC LIMIT ? OFFSET ?",
            params,
        ).fetchall()
        return [self._row_to_record(r) for r in rows]

    def outcomes_for(self, conn: sqlite3.Connection, pathbook_id: str) -> list[dict[str, Any]]:
        rows = conn.execute(
            "SELECT application_id, reporter_id, reporter_public_key, outcome, verify_passed, "
            "details, evidence, reported_at, counted FROM outcomes WHERE pathbook_id = ? ORDER BY seq ASC",
            (pathbook_id,),
        ).fetchall()
        return [
            {
                "application_id": r[0], "reporter_id": r[1], "reporter_public_key": r[2],
                "outcome": r[3], "verify_passed": bool(r[4]), "details": r[5],
                "evidence": json.loads(r[6]) if r[6] else None,
                "reported_at": r[7], "counted": bool(r[8]),
            }
            for r in rows
        ]

    def outcome_exists(self, conn: sqlite3.Connection, pathbook_id: str, application_id: str) -> bool:
        return conn.execute(
            "SELECT 1 FROM outcomes WHERE pathbook_id = ? AND application_id = ?",
            (pathbook_id, application_id),
        ).fetchone() is not None

    # ---- writes (caller wraps in a transaction) ------------------------

    def insert_record(self, conn: sqlite3.Connection, rec: PathbookRecord) -> None:
        conn.execute(
            "INSERT INTO pathbooks "
            "(id, protocol, title, error_signature, error_fingerprint, context_fingerprint, "
            "ecosystem, runtime, package_name, trigger_yaml, remediation_yaml, verify_yaml, "
            "failed_attempts_yaml, safety_class, safety_flags, requires_confirmation, "
            "token_savings_estimate, provenance, signature, trust_tier, times_applied, "
            "times_succeeded, confidence, active, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                rec.id, rec.protocol, rec.title, rec.error_signature, rec.error_fingerprint,
                rec.context_fingerprint,
                rec.ecosystem, rec.runtime, rec.package_name, rec.trigger_yaml,
                rec.remediation_yaml, rec.verify_yaml, rec.failed_attempts_yaml,
                rec.safety_class, json.dumps(rec.safety_flags), int(rec.requires_confirmation),
                rec.token_savings_estimate, json.dumps(rec.provenance.model_dump(), sort_keys=True),
                rec.signature, rec.trust_tier.value, rec.times_applied, rec.times_succeeded,
                rec.confidence, int(rec.active), rec.updated_at,
            ),
        )

    def insert_outcome(self, conn: sqlite3.Connection, report: OutcomeReport, counted: bool) -> bool:
        """Insert an outcome row. Returns False if this (pathbook, application)
        was already reported — the idempotent no-op path."""
        try:
            conn.execute(
                "INSERT INTO outcomes (pathbook_id, application_id, reporter_id, reporter_public_key, "
                "outcome, verify_passed, details, evidence, reported_at, signature, counted) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    report.pathbook_id, report.application_id, report.reporter_id,
                    report.reporter_public_key, report.outcome.value, int(report.verify_passed),
                    report.details,
                    json.dumps(report.evidence.model_dump(), sort_keys=True) if report.evidence else None,
                    report.reported_at, report.signature, int(counted),
                ),
            )
            return True
        except sqlite3.IntegrityError:
            return False

    def update_registry_state(
        self,
        conn: sqlite3.Connection,
        pathbook_id: str,
        *,
        trust_tier: TrustTier,
        times_applied: int,
        times_succeeded: int,
        confidence: float,
        active: bool,
        updated_at: str,
    ) -> None:
        conn.execute(
            "UPDATE pathbooks SET trust_tier=?, times_applied=?, times_succeeded=?, "
            "confidence=?, active=?, updated_at=? WHERE id=?",
            (trust_tier.value, times_applied, times_succeeded, confidence, int(active), updated_at, pathbook_id),
        )

    def pin_reporter_key(self, conn: sqlite3.Connection, reporter_id: str, public_key: str) -> bool:
        """Trust-on-first-use key pinning. Returns False if *reporter_id* is
        already pinned to a different key (identity hijack attempt)."""
        row = conn.execute("SELECT public_key FROM reporter_keys WHERE reporter_id = ?", (reporter_id,)).fetchone()
        if row is None:
            conn.execute("INSERT INTO reporter_keys (reporter_id, public_key) VALUES (?,?)", (reporter_id, public_key))
            return True
        return row[0] == public_key

    def issue_application(
        self,
        conn: sqlite3.Connection,
        *,
        application_id: str,
        pathbook_id: str,
        pathbook_signature: str,
        executor_id: Optional[str],
        executor_public_key: Optional[str],
        issued_at: str,
        expires_at: str,
    ) -> None:
        conn.execute(
            "INSERT INTO applications "
            "(application_id, pathbook_id, pathbook_signature, executor_id, "
            "executor_public_key, issued_at, expires_at, consumed_at) "
            "VALUES (?,?,?,?,?,?,?,NULL)",
            (
                application_id, pathbook_id, pathbook_signature, executor_id,
                executor_public_key, issued_at, expires_at,
            ),
        )

    def get_application(self, conn: sqlite3.Connection, application_id: str) -> Optional[dict[str, Any]]:
        row = conn.execute(
            "SELECT application_id, pathbook_id, pathbook_signature, executor_id, "
            "executor_public_key, issued_at, expires_at, consumed_at "
            "FROM applications WHERE application_id = ?",
            (application_id,),
        ).fetchone()
        if row is None:
            return None
        keys = (
            "application_id", "pathbook_id", "pathbook_signature", "executor_id",
            "executor_public_key", "issued_at", "expires_at", "consumed_at",
        )
        return dict(zip(keys, row))

    def consume_application(self, conn: sqlite3.Connection, application_id: str, consumed_at: str) -> bool:
        cursor = conn.execute(
            "UPDATE applications SET consumed_at = ? "
            "WHERE application_id = ? AND consumed_at IS NULL",
            (consumed_at, application_id),
        )
        return cursor.rowcount == 1
