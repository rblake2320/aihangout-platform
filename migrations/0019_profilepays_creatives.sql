CREATE TABLE IF NOT EXISTS pp_creatives (
  asset_key TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES pp_grants(id),
  png_base64 TEXT NOT NULL
);
