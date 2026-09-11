-- Private owner-only analysis ledger. Never stores image bytes, notification
-- text, or raw provider responses. Identity is durable before provider entry.
CREATE TABLE IF NOT EXISTS mobile_camera_analysis_requests (
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES mobile_devices(device_id),
  request_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','analyzed','unknown','failed')),
  provider_called_at DATETIME,
  model TEXT,
  summary TEXT,
  proposal_json TEXT,
  usage_json TEXT,
  error TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  PRIMARY KEY(owner_user_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_camera_analysis_calls ON mobile_camera_analysis_requests(provider_called_at);
