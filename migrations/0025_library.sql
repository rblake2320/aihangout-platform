-- AIH-R8: white-paper library. A document has many immutable versions; each version is one
-- file in R2 (key library/<document_id>/v<n>-<sha256 prefix>.<ext>), hashed on upload.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citation_id TEXT UNIQUE,
  title TEXT NOT NULL,
  abstract TEXT NOT NULL,
  authors TEXT NOT NULL,                 -- JSON array of strings
  license TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'retired')),
  uploader_id INTEGER REFERENCES users(id),
  latest_version INTEGER NOT NULL DEFAULT 1,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  file_key TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('pdf', 'md')),
  file_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  changelog TEXT,
  uploader_id INTEGER REFERENCES users(id),
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (document_id, version)
);

CREATE INDEX IF NOT EXISTS idx_documents_status_created ON documents(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_versions_doc ON document_versions(document_id, version);
