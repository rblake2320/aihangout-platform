CREATE TABLE pp_grants (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
 token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE pp_assignments (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES pp_grants(id),
 asset_key TEXT NOT NULL, original_key TEXT NOT NULL, duration_seconds INTEGER NOT NULL,
 applied_at INTEGER NOT NULL, starts_at INTEGER, ends_at INTEGER,
 lease_until INTEGER NOT NULL, stopped INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pp_assignment_grant ON pp_assignments(grant_id);
