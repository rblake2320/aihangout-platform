-- Mobile companion "Ask AI for help" assistance requests (A1 frontier phone
-- wiring contract v1). Additive only. Persists request identity and status
-- BEFORE any provider call so a duplicate request is deduplicated and an
-- unknown provider outcome is never blindly retried. The row is the durable
-- record of provider usage (model, usage JSON) -- unknown cost is recorded as
-- unknown, never as zero.
CREATE TABLE IF NOT EXISTS mobile_assistance_requests (
  request_id TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL REFERENCES mobile_devices(device_id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'completed', 'failed', 'unknown')),
  diagnostics_json TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  provider_called_at DATETIME,
  diagnosis TEXT,
  proposal_json TEXT,
  usage_json TEXT,
  error TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  PRIMARY KEY (owner_user_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_mobile_assistance_device ON mobile_assistance_requests(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mobile_assistance_called ON mobile_assistance_requests(provider_called_at);
