-- Durable, deduplicated Pathbook outcome reporting and trust evidence.
CREATE TABLE IF NOT EXISTS pathbook_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pathbook_id INTEGER NOT NULL REFERENCES pathbooks(id),
  verifier_id INTEGER NOT NULL REFERENCES users(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure')),
  environment TEXT,
  notes TEXT,
  evidence_url TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(pathbook_id, verifier_id)
);

CREATE INDEX IF NOT EXISTS idx_pathbook_verifications_pathbook
  ON pathbook_verifications(pathbook_id, outcome, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pathbook_verifications_verifier
  ON pathbook_verifications(verifier_id, updated_at DESC);
