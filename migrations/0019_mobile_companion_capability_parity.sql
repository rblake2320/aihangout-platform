-- Expands the mobile companion capability allowlist to parity with what
-- PhoneClaw's upstream offers (UI automation, screenshot capture, SMS,
-- calls), per explicit owner decision 2026-09-08 -- as original code
-- with the SAME per-action human-approval gate from migration 0018, not
-- as a PhoneClaw fork. Deliberately still excludes true autonomous/
-- recurring scheduling: the AIHANGOUT-launch-20260908.md task's standing
-- constraint ("no provider spending or autonomous recurring schedules")
-- was not superseded by this specific capability-scope decision, and
-- every action here -- including these new ones -- still requires one
-- explicit human approval per occurrence, never unattended repetition.
--
-- SQLite has no ALTER TABLE ... DROP CONSTRAINT / ALTER COLUMN for a CHECK
-- clause; the standard migration pattern is rebuild-and-copy.
PRAGMA foreign_keys=OFF;

CREATE TABLE mobile_action_intents_new (
  action_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES mobile_devices(device_id),
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  capability TEXT NOT NULL CHECK(capability IN (
    'device_diagnostics_read', 'battery_status_read', 'network_status_read',
    'ui_read_screen', 'ui_click', 'ui_type', 'screenshot_capture',
    'sms_send', 'call_make', 'email_send'
  )),
  -- Coarse risk classification the (future) approval UI keys off of.
  -- read_only: no device-visible side effect. device_ui_action: acts on
  -- the screen but stays local to the device. communication_send: leaves
  -- the device (SMS/call) -- real-world cost/irreversibility, gated by
  -- confirm_phrase below in addition to digest binding.
  risk_tier TEXT NOT NULL DEFAULT 'read_only'
    CHECK(risk_tier IN ('read_only', 'device_ui_action', 'communication_send')),
  target_description TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_approval'
    CHECK(status IN ('awaiting_approval', 'approved', 'denied', 'expired', 'revoked')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  UNIQUE(device_id, idempotency_key)
);
INSERT INTO mobile_action_intents_new
  (action_id, device_id, owner_user_id, capability, risk_tier, target_description, action_digest, idempotency_key, status, created_at, expires_at)
  SELECT action_id, device_id, owner_user_id, capability, 'read_only', target_description, action_digest, idempotency_key, status, created_at, expires_at
  FROM mobile_action_intents;
DROP TABLE mobile_action_intents;
ALTER TABLE mobile_action_intents_new RENAME TO mobile_action_intents;

CREATE INDEX IF NOT EXISTS idx_mobile_action_intents_device ON mobile_action_intents(device_id, status);
CREATE INDEX IF NOT EXISTS idx_mobile_action_intents_owner ON mobile_action_intents(owner_user_id, created_at DESC);

-- communication_send-tier approvals require the human to type a fixed
-- confirmation phrase, in addition to the exact digest match already
-- required for every tier -- an extra deliberate-intent gate for actions
-- that leave the device (real SMS/call), matching this repo's own
-- red-team tooling precedent (explicit ack-phrase gates for high-
-- consequence actions) rather than inventing a new pattern.
ALTER TABLE mobile_action_approvals ADD COLUMN confirm_phrase TEXT;

PRAGMA foreign_keys=ON;
