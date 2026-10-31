-- AIH-R4: account deletion marker and an append-only record of consent decisions.
-- deleted_at is set when a user deletes their account. The users row is kept but
-- anonymised, so community content (problems, solutions) and audit chains keep a valid
-- foreign key while no personal data remains on the row.
ALTER TABLE users ADD COLUMN deleted_at TEXT;

-- One row per consent decision (banner click or settings change), so a decision can be
-- demonstrated later. No IP address or user agent is stored here.
CREATE TABLE IF NOT EXISTS consent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  session_id TEXT,
  analytics INTEGER NOT NULL CHECK (analytics IN (0, 1)),
  policy_version TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'banner',
  gpc INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_consent_log_user ON consent_log(user_id, created_at);
