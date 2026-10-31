-- AIH-R6: editable profiles. Bio and avatar pointer live on users; links in their own table.
-- avatar_key is the R2 object key (avatars/<user_id>/<random>.<ext>), never user-supplied.
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN avatar_key TEXT;
ALTER TABLE users ADD COLUMN avatar_updated_at TEXT;

CREATE TABLE IF NOT EXISTS profile_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  UNIQUE (user_id, position)
);
CREATE INDEX IF NOT EXISTS idx_profile_links_user ON profile_links(user_id, position);
