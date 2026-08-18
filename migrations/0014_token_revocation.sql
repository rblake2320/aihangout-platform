-- 0014_token_revocation.sql
--
-- Manus adversarial QA F-04 (2026-08-17): logout was client-side credential
-- discard only — a stolen or lost JWE stayed valid for its full 24h lifetime
-- after the user logged out, with no way to invalidate it early.
--
-- Every newly issued JWT now carries a random `jti` claim. Logout records that
-- jti here; authenticate() rejects any JWT whose jti appears in this table.
-- Tokens issued before this migration have no jti and are unaffected (they
-- simply age out within 24h as before) — no forced re-login on deploy.

CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti         TEXT PRIMARY KEY,
  user_id     INTEGER,
  revoked_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Mirrors the token's own expiry so the daily cron can prune rows for
  -- tokens that would have expired naturally anyway, instead of growing
  -- this table forever.
  expires_at  DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens (expires_at);
