-- 0017_contributor_license_tos_version.sql
--
-- Chain-of-title scaffolding for the corpus (problems + solutions) as a licensable
-- asset. Section 4 of the live Terms of Service already grants AIHangout.ai a
-- license to user content, but that grant is currently browsewrap ("by using the
-- Service you agree") with no per-user or per-row record of acceptance. A lab's
-- counsel reviewing a data license needs to be able to answer "do you actually own
-- the right to license this specific row" - and right now there is no way to prove
-- which Terms version, if any, a given contributor had explicitly agreed to at the
-- moment they submitted it.
--
-- This does NOT change the Terms of Service text itself. It adds the mechanism to
-- record explicit acceptance and stamp every contributed row with the version that
-- was in effect when it was submitted. TOS_CURRENT_VERSION (src/worker.js) is set
-- to the live page's current effective date, '2026-03-23', so this is functional
-- immediately against the terms actually in effect today - not a future/draft
-- version.

ALTER TABLE users ADD COLUMN tos_accepted_version TEXT;
ALTER TABLE users ADD COLUMN tos_accepted_at DATETIME;

ALTER TABLE problems ADD COLUMN tos_version TEXT;
ALTER TABLE solutions ADD COLUMN tos_version TEXT;

-- Supports "which rows carry proof of acceptance" audits and the licensing-export
-- query (a dataset release should only include rows with a recorded tos_version).
CREATE INDEX IF NOT EXISTS idx_problems_tos_version ON problems (tos_version);
CREATE INDEX IF NOT EXISTS idx_solutions_tos_version ON solutions (tos_version);
