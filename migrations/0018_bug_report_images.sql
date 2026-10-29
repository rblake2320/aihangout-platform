ALTER TABLE bug_reports ADD COLUMN image_group_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bug_reports_image_group ON bug_reports(image_group_id);
CREATE TABLE IF NOT EXISTS bug_report_images (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES bug_reports(image_group_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  image_base64 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bug_report_images_group ON bug_report_images(group_id, position);
