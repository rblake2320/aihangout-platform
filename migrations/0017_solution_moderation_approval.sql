-- Separates publication/moderation approval from human-outcome verification
-- (A2 launch-security finding 1, 2026-09-08). is_verified/verified_by/
-- verified_at/verification_type (migration 0005) mean "a human confirmed
-- this solution actually works", written ONLY by the dedicated
-- POST /api/problems/:problemId/solutions/:solutionId/accept handler.
-- These new columns mean "an admin cleared this content for public
-- visibility" -- a weaker, distinct claim, written by the legacy
-- POST /api/admin/approve/solution/:id moderation route, which must never
-- set is_verified itself.
ALTER TABLE solutions ADD COLUMN moderation_approved_at DATETIME;
ALTER TABLE solutions ADD COLUMN moderation_approved_by INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_solutions_moderation_approved
  ON solutions(moderation_approved_at);
