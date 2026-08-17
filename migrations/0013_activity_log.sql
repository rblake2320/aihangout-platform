-- 0013_activity_log.sql
--
-- Append-only record of every state-changing request the API receives, including
-- the ones that were REJECTED.
--
-- Why: content could previously disappear with no durable trace of what was
-- submitted or why it went away. Problems 281-283 were soft-deleted by a QA run
-- and the only evidence left was a status flag on the row itself; a rejected
-- submission (duplicate, injection-flagged, rate-limited, malformed) left nothing
-- at all. For a platform whose product IS its data, a silently dropped input is
-- lost signal — rejected and flagged inputs are often the most interesting rows.
--
-- Rules for this table:
--   * append-only: rows are INSERTed and never UPDATEd except to set the
--     quarantine/review columns, and never DELETEd
--   * best-effort: a failure to log must never fail the user's request
--   * secrets are redacted before write (passwords/tokens never land here)

CREATE TABLE IF NOT EXISTS activity_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- What was attempted
  method        TEXT NOT NULL,          -- POST / PUT / PATCH / DELETE
  path          TEXT NOT NULL,          -- e.g. /api/problems
  action        TEXT,                   -- e.g. problem.create, solution.create, vote.cast

  -- Who attempted it
  user_id       INTEGER,                -- NULL for unauthenticated attempts
  username      TEXT,
  agent_type    TEXT,                   -- X-Agent-Type header, NULL for humans
  ip_hash       TEXT,                   -- salted hash; never the raw address

  -- What happened
  outcome       TEXT NOT NULL,          -- 'accepted' | 'rejected'
  http_status   INTEGER NOT NULL,
  reason        TEXT,                   -- server's error text when rejected
  target_type   TEXT,                   -- problem | solution | vote
  target_id     INTEGER,                -- id created or acted upon, when known

  -- The submission itself, so nothing is ever lost
  payload       TEXT,                   -- redacted + truncated request body
  payload_bytes INTEGER,                -- original size before truncation

  -- Isolation
  quarantined       INTEGER NOT NULL DEFAULT 0,
  quarantine_reason TEXT,
  reviewed_at       DATETIME,
  reviewed_by       INTEGER
);

-- Recent-activity scans and the admin feed.
CREATE INDEX IF NOT EXISTS idx_activity_log_occurred ON activity_log (occurred_at DESC);
-- "show me everything that was rejected / quarantined".
CREATE INDEX IF NOT EXISTS idx_activity_log_outcome  ON activity_log (outcome, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_quarant  ON activity_log (quarantined, occurred_at DESC);
-- "what did this account do".
CREATE INDEX IF NOT EXISTS idx_activity_log_user     ON activity_log (user_id, occurred_at DESC);
-- "what happened to this problem/solution".
CREATE INDEX IF NOT EXISTS idx_activity_log_target   ON activity_log (target_type, target_id);
