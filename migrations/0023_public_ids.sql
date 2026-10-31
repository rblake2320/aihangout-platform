-- AIH-R2: stable public identifiers. Integers stay internal (joins, foreign keys);
-- every public URL and API path also accepts public_id, forever.
--
-- public_id is a UUIDv7: 48-bit Unix-millisecond timestamp (taken from the row's own
-- creation time, so backfilled ids sort like new ones), version nibble 7, RFC 4122
-- variant, 74 random bits. The same expression is used by the lazy backfill in
-- src/public-ids.js for rows inserted by paths that predate this migration.
-- No triggers: wrangler's remote migration splitter cannot apply them (see CLAUDE.md).

ALTER TABLE problems ADD COLUMN public_id TEXT;
ALTER TABLE solutions ADD COLUMN public_id TEXT;
ALTER TABLE users ADD COLUMN public_id TEXT;

UPDATE problems SET public_id = lower(
  substr(printf('%012x', CAST(round((julianday(COALESCE(created_at, CURRENT_TIMESTAMP)) - 2440587.5) * 86400000) AS INTEGER)), 1, 8) || '-' ||
  substr(printf('%012x', CAST(round((julianday(COALESCE(created_at, CURRENT_TIMESTAMP)) - 2440587.5) * 86400000) AS INTEGER)), 9, 4) || '-7' ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2, 3) || '-' ||
  hex(randomblob(6))
) WHERE public_id IS NULL;

UPDATE solutions SET public_id = lower(
  substr(printf('%012x', CAST(round((julianday(COALESCE(created_at, CURRENT_TIMESTAMP)) - 2440587.5) * 86400000) AS INTEGER)), 1, 8) || '-' ||
  substr(printf('%012x', CAST(round((julianday(COALESCE(created_at, CURRENT_TIMESTAMP)) - 2440587.5) * 86400000) AS INTEGER)), 9, 4) || '-7' ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2, 3) || '-' ||
  hex(randomblob(6))
) WHERE public_id IS NULL;

UPDATE users SET public_id = lower(
  substr(printf('%012x', CAST(round((julianday(COALESCE(join_date, CURRENT_TIMESTAMP)) - 2440587.5) * 86400000) AS INTEGER)), 1, 8) || '-' ||
  substr(printf('%012x', CAST(round((julianday(COALESCE(join_date, CURRENT_TIMESTAMP)) - 2440587.5) * 86400000) AS INTEGER)), 9, 4) || '-7' ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2, 3) || '-' ||
  hex(randomblob(6))
) WHERE public_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_problems_public_id ON problems(public_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_solutions_public_id ON solutions(public_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_public_id ON users(public_id);
