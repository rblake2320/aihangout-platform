-- Production Pathbook hardening: issued applications, append-only evidence,
-- context-aware fingerprints, safety metadata, sealed state, and an
-- optimistic audit-chain head enforced by SQLite triggers.

ALTER TABLE pathbooks ADD COLUMN context_fingerprint TEXT;
ALTER TABLE pathbooks ADD COLUMN safety_class TEXT NOT NULL DEFAULT 'low';
ALTER TABLE pathbooks ADD COLUMN safety_flags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE pathbooks ADD COLUMN requires_confirmation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pathbooks ADD COLUMN state_hash TEXT;
ALTER TABLE pathbooks ADD COLUMN state_seal TEXT;

CREATE INDEX IF NOT EXISTS idx_pathbooks_context_fingerprint
  ON pathbooks(context_fingerprint);

CREATE TABLE IF NOT EXISTS pathbook_applications (
  application_id TEXT PRIMARY KEY,
  pathbook_id INTEGER NOT NULL REFERENCES pathbooks(id),
  executor_id INTEGER NOT NULL REFERENCES users(id),
  pathbook_version TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  status TEXT NOT NULL DEFAULT 'issued'
    CHECK(status IN ('issued','consumed','expired','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_pathbook_applications_executor
  ON pathbook_applications(executor_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_pathbook_applications_expiry
  ON pathbook_applications(status, expires_at);

CREATE TABLE IF NOT EXISTS pathbook_verification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL UNIQUE REFERENCES pathbook_applications(application_id),
  pathbook_id INTEGER NOT NULL REFERENCES pathbooks(id),
  verifier_id INTEGER NOT NULL REFERENCES users(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','dangerous')),
  verify_passed INTEGER NOT NULL DEFAULT 0,
  environment TEXT,
  notes TEXT,
  evidence TEXT,
  evidence_level TEXT NOT NULL DEFAULT 'self_attested'
    CHECK(evidence_level IN ('legacy','self_attested','platform_attested','maintainer_attested')),
  reporter_public_key TEXT,
  reporter_signature TEXT,
  counted INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pathbook_events_pathbook
  ON pathbook_verification_events(pathbook_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pathbook_events_verifier
  ON pathbook_verification_events(verifier_id, created_at DESC);

-- Preserve the already-collected honest reports as explicitly labeled legacy
-- evidence. New reports must always flow through issued applications.
INSERT OR IGNORE INTO pathbook_applications (
  application_id, pathbook_id, executor_id, pathbook_version,
  issued_at, expires_at, consumed_at, status
)
SELECT
  'legacy-verification-' || id,
  pathbook_id,
  verifier_id,
  'legacy-import',
  created_at,
  updated_at,
  updated_at,
  'consumed'
FROM pathbook_verifications;

INSERT OR IGNORE INTO pathbook_verification_events (
  application_id, pathbook_id, verifier_id, outcome, verify_passed,
  environment, notes, evidence, evidence_level, counted, created_at
)
SELECT
  'legacy-verification-' || id,
  pathbook_id,
  verifier_id,
  outcome,
  CASE WHEN outcome = 'success' THEN 1 ELSE 0 END,
  environment,
  notes,
  json_object('legacy_evidence_url', evidence_url),
  'legacy',
  1,
  created_at
FROM pathbook_verifications;

CREATE TABLE IF NOT EXISTS pathbook_audit_head (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  head_seq INTEGER NOT NULL DEFAULT 0,
  head_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO pathbook_audit_head (id, head_seq, head_hash)
VALUES (1, 0, '0000000000000000000000000000000000000000000000000000000000000000');

CREATE TABLE IF NOT EXISTS pathbook_audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  pathbook_id INTEGER REFERENCES pathbooks(id),
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE,
  event_seal TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS pathbook_audit_prev_hash_guard
BEFORE INSERT ON pathbook_audit_events
FOR EACH ROW
WHEN NEW.prev_hash != (SELECT head_hash FROM pathbook_audit_head WHERE id = 1)
BEGIN
  SELECT RAISE(ABORT, 'pathbook_audit_head_conflict');
END;

CREATE TRIGGER IF NOT EXISTS pathbook_audit_advance_head
AFTER INSERT ON pathbook_audit_events
FOR EACH ROW
BEGIN
  UPDATE pathbook_audit_head
  SET head_seq = NEW.seq,
      head_hash = NEW.event_hash,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;
