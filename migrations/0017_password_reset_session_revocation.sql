-- 0017_password_reset_session_revocation.sql
-- Password resets must invalidate all pre-reset JWTs.  A durable generation
-- avoids retaining raw session tokens and preserves existing accounts/tokens at
-- generation 0 until their first reset.
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
