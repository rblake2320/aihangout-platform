-- 0015_activity_log_immutability_trigger.sql
--
-- 0013 documented activity_log as append-only ("never UPDATEd except the
-- quarantine/review columns, never DELETEd") but enforced it only by route
-- convention — nothing in the schema stopped a future endpoint, an admin
-- console query, or a bug from mutating or deleting a row. The same gap
-- pattern that motivated the vote UNIQUE index (0012): a rule written in a
-- comment is a promise; a constraint is physics.
--
-- Two triggers:
--   * activity_log_no_delete   — unconditionally aborts any DELETE.
--   * activity_log_immutable_fields — aborts an UPDATE that touches any
--     column outside {quarantined, quarantine_reason, reviewed_at,
--     reviewed_by} — the exact same four columns 0013's own comment names
--     as the only ones a review/quarantine action may touch.
--
-- `IS NOT` (not `!=`) is deliberate: several of these columns are nullable
-- (user_id, username, agent_type, reason, target_type, target_id,
-- payload_bytes), and SQL's three-valued logic makes `NULL != NULL` neither
-- true nor false, so a `!=`-based WHEN clause would silently fail to fire
-- when an attacker "changed" a NULL column to another NULL-adjacent value.
-- `IS NOT` treats NULL as a comparable value and has no such blind spot.

-- Each CREATE TRIGGER below is deliberately kept on a SINGLE physical line.
-- D1's remote migration executor (unlike local SQLite) has a known bug where
-- a multi-line CREATE TRIGGER ... BEGIN ... END statement gets mis-split and
-- fails with "incomplete input: SQLITE_ERROR [code: 7500]", even though the
-- identical statement works fine locally and via `d1 execute` one-off runs.
-- See cloudflare/workers-sdk#9133, #10998, #4998. One line per statement
-- sidesteps whatever newline-sensitive splitting causes it.

CREATE TRIGGER IF NOT EXISTS activity_log_no_delete BEFORE DELETE ON activity_log BEGIN SELECT RAISE(ABORT, 'activity_log is append-only: delete is not permitted'); END;

CREATE TRIGGER IF NOT EXISTS activity_log_immutable_fields BEFORE UPDATE ON activity_log WHEN NEW.id IS NOT OLD.id OR NEW.occurred_at IS NOT OLD.occurred_at OR NEW.method IS NOT OLD.method OR NEW.path IS NOT OLD.path OR NEW.action IS NOT OLD.action OR NEW.user_id IS NOT OLD.user_id OR NEW.username IS NOT OLD.username OR NEW.agent_type IS NOT OLD.agent_type OR NEW.ip_hash IS NOT OLD.ip_hash OR NEW.outcome IS NOT OLD.outcome OR NEW.http_status IS NOT OLD.http_status OR NEW.reason IS NOT OLD.reason OR NEW.target_type IS NOT OLD.target_type OR NEW.target_id IS NOT OLD.target_id OR NEW.payload IS NOT OLD.payload OR NEW.payload_bytes IS NOT OLD.payload_bytes BEGIN SELECT RAISE(ABORT, 'activity_log is append-only: only quarantined, quarantine_reason, reviewed_at, reviewed_by may be updated'); END;
