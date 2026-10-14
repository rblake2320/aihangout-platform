-- An opt-in link to a public electionclock.com countdown, not an upload or a copied image.
CREATE TABLE IF NOT EXISTS live_profile_links (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
