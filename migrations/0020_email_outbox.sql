-- AIH-R5: notifications that reach people.
--
-- Email is queued in email_outbox and sent by the cron (batched, idempotent), never inline in a
-- request. dedupe_key is UNIQUE, so one event can only ever produce one row, and the same key is
-- used as the provider idempotency key. Unsubscribe state lives on user_settings; a user with no
-- user_settings row has every category enabled.
--
-- No triggers in this file (wrangler's remote migration splitter cannot apply them).

CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('solutions', 'mentions', 'digest')),
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT NOT NULL,
  link_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  provider_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  claimed_at DATETIME,
  sent_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_status ON email_outbox (status, id);
CREATE INDEX IF NOT EXISTS idx_email_outbox_user ON email_outbox (user_id, category, created_at);

ALTER TABLE user_settings ADD COLUMN email_solutions BOOLEAN NOT NULL DEFAULT 1;
ALTER TABLE user_settings ADD COLUMN email_mentions BOOLEAN NOT NULL DEFAULT 1;
ALTER TABLE user_settings ADD COLUMN email_digest BOOLEAN NOT NULL DEFAULT 1;
ALTER TABLE user_settings ADD COLUMN email_unsubscribed_at DATETIME;
