-- 0016_activity_log_retention.sql
--
-- Resolves a real conflict between two controls that are each correct on their own.
--
-- 0013 added activity_log, which deliberately records REJECTED requests. That makes
-- the table writable by anyone who can reach the API, including an unauthenticated
-- flood, and nothing ever pruned it: growth is unbounded and trends toward D1's
-- storage limit, which turns the audit trail into a denial-of-service path against
-- the database that serves the product.
--
-- 0015 then enforced append-only with an unconditional no-DELETE trigger, on the
-- correct principle that a rule in a comment is a promise while a constraint is
-- physics. But "never delete" and "must not grow without bound" cannot both hold.
--
-- The resolution is the one WORM storage has always used: immutable *within a
-- retention window*, not immutable forever. Recent history stays absolutely
-- untouchable — that is the property worth having, because it is recent history an
-- attacker wants to rewrite. Only rows past their window can be removed, and
-- quarantined evidence (anything refused or moderation-flagged) gets a window six
-- times longer than routine accepted traffic.
--
-- The trigger is the FLOOR, not the policy. Application retention (currently 30 and
-- 180 days, in src/worker.js) may be more conservative than these thresholds but can
-- never be more aggressive, because the database refuses. That ordering is what makes
-- this defence in depth rather than duplicated configuration: the endpoint validates,
-- and the constraint enforces.

DROP TRIGGER IF EXISTS activity_log_no_delete;

CREATE TRIGGER IF NOT EXISTS activity_log_retention_floor
BEFORE DELETE ON activity_log
WHEN
  -- Routine traffic is protected for 30 days.
  (COALESCE(OLD.quarantined, 0) = 0 AND OLD.occurred_at >= datetime('now', '-30 days'))
  -- Evidence is protected for 180 days. Deleting a quarantined row early is exactly
  -- the move an attacker would make to remove the record of their own refused
  -- requests, so it is refused at the storage layer, not just in the route.
  OR (COALESCE(OLD.quarantined, 0) = 1 AND OLD.occurred_at >= datetime('now', '-180 days'))
BEGIN
  SELECT RAISE(ABORT, 'activity_log is append-only within its retention window: this row is not yet eligible for deletion');
END;

-- Supports the retention sweep itself: without this the daily prune scans the whole
-- table, which is the opposite of what a growth-control measure should do.
CREATE INDEX IF NOT EXISTS idx_activity_log_retention
  ON activity_log (quarantined, occurred_at);
