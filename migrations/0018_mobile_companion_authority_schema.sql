-- AIHangout Mobile Companion authority schema (Gate 1 of 6 from A6's
-- architecture review, Team/tasks/A6-aihangout-phoneclaw-lane-20260908.md).
-- Owner decision 2026-09-08: build an ORIGINAL companion, not a PhoneClaw
-- fork. Recommended first-release capability set: read-only, user-visible
-- diagnostics on one enrolled device. No accessibility automation,
-- messaging, calling, camera, or unattended execution -- enforced by the
-- capability CHECK constraint below, not left to application code alone.
--
-- Separate, additive action ledger -- distinct from `activity_log` (which
-- the architecture review found "explicitly best-effort... no action-
-- intent/result/effect linkage or unique idempotency key", i.e. wrong tool
-- for this). An agent/device can never impersonate the owning human
-- account; every table below carries an explicit owner_user_id.

CREATE TABLE IF NOT EXISTS mobile_devices (
  device_id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  agent_name TEXT NOT NULL,
  device_public_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
  enrolled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME,
  UNIQUE(owner_user_id, agent_name)
);
CREATE INDEX IF NOT EXISTS idx_mobile_devices_owner ON mobile_devices(owner_user_id, status);

CREATE TABLE IF NOT EXISTS mobile_action_intents (
  action_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES mobile_devices(device_id),
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  -- Narrow, explicit allowlist -- NOT an open string field. Adding a new
  -- capability (e.g. anything write/send/call/camera/accessibility)
  -- requires its own migration and its own explicit policy decision, not
  -- a value an API caller can just supply.
  capability TEXT NOT NULL CHECK(capability IN (
    'device_diagnostics_read', 'battery_status_read', 'network_status_read'
  )),
  target_description TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_approval'
    CHECK(status IN ('awaiting_approval', 'approved', 'denied', 'expired', 'revoked')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  UNIQUE(device_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_mobile_action_intents_device ON mobile_action_intents(device_id, status);
CREATE INDEX IF NOT EXISTS idx_mobile_action_intents_owner ON mobile_action_intents(owner_user_id, created_at DESC);

-- Exactly one approval per action (UNIQUE action_id) -- a changed plan is a
-- new action with a new digest, never a mutated approval. The device/agent
-- itself can never write this row (only the owning human's authenticated
-- session can, enforced in the API layer against owner_user_id).
CREATE TABLE IF NOT EXISTS mobile_action_approvals (
  action_id TEXT PRIMARY KEY REFERENCES mobile_action_intents(action_id),
  approved_by INTEGER NOT NULL REFERENCES users(id),
  approved_digest TEXT NOT NULL,
  approved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Exactly one result per action (UNIQUE action_id) -- the device reports
-- once; idempotency_key must match the intent's, so a retried/duplicate
-- report from the device is a no-op, never a second row.
CREATE TABLE IF NOT EXISTS mobile_action_results (
  action_id TEXT PRIMARY KEY REFERENCES mobile_action_intents(action_id),
  device_id TEXT NOT NULL REFERENCES mobile_devices(device_id),
  idempotency_key TEXT NOT NULL,
  result_status TEXT NOT NULL CHECK(result_status IN ('executed', 'failed')),
  -- Redaction boundary: a hash of the actual result payload, never raw
  -- content -- matches the architecture review's "upload structured facts
  -- plus content hashes" rule. Raw diagnostic text never reaches this table.
  result_payload_hash TEXT,
  reported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Effect verification is deliberately a SEPARATE state from "the device
-- said it executed" -- "no success inference from a model response... or
-- an approval count" (architecture review). Defaults to unconfirmed;
-- something else (a follow-up read, a human check) must explicitly verify.
CREATE TABLE IF NOT EXISTS mobile_action_effects (
  action_id TEXT PRIMARY KEY REFERENCES mobile_action_intents(action_id),
  effect_status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK(effect_status IN ('effect_verified', 'unconfirmed')),
  verification_note TEXT,
  verified_at DATETIME
);
