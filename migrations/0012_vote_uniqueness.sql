-- 0012_vote_uniqueness.sql
--
-- Problem: votes(user_id, target_type, target_id) had no uniqueness guarantee.
-- The vote handler enforced "one vote per user per target" purely in application
-- code via DELETE-then-INSERT, unbatched. Two concurrent requests from the same
-- user could interleave (DELETE, DELETE, INSERT, INSERT) and leave two rows,
-- inflating the recomputed upvote count.
--
-- Fix is two-part: the handler now runs DELETE+INSERT in a single D1 batch()
-- transaction, and this migration adds the database-level backstop.
--
-- Step 1 must run before the index can be created: collapse any duplicate rows
-- that already exist, keeping the most recent vote (highest id) per triple.

DELETE FROM votes
WHERE id NOT IN (
  SELECT MAX(id)
  FROM votes
  GROUP BY user_id, target_type, target_id
);

-- Step 2: enforce one vote per user per target from here on.
CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_user_target_unique
  ON votes (user_id, target_type, target_id);

-- Supports the new ingest-time duplicate-problem check in POST /api/problems,
-- which looks up prior problems by the submitting user. Without this the dedup
-- guard would force a full table scan on every problem submission.
CREATE INDEX IF NOT EXISTS idx_problems_user_status
  ON problems (user_id, status);
