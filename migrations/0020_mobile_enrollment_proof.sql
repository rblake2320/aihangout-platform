-- Key possession only. Package/certificate claims are NOT Android attestation.
CREATE TABLE mobile_enrollment_challenges (
 challenge_id TEXT PRIMARY KEY,
 owner_user_id INTEGER NOT NULL REFERENCES users(id),
 agent_name TEXT NOT NULL,
 nonce TEXT NOT NULL,
 signing_payload TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 consumed_at INTEGER
);
ALTER TABLE mobile_devices ADD COLUMN enrollment_challenge_id TEXT;
CREATE UNIQUE INDEX mobile_device_challenge_once ON mobile_devices(enrollment_challenge_id);
ALTER TABLE mobile_devices ADD COLUMN public_key_alg TEXT;
ALTER TABLE mobile_devices ADD COLUMN public_key_spki TEXT;
ALTER TABLE mobile_devices ADD COLUMN key_security_level TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE mobile_devices ADD COLUMN signing_cert_sha256 TEXT;
ALTER TABLE mobile_devices ADD COLUMN package_name TEXT;
ALTER TABLE mobile_devices ADD COLUMN last_challenge_verified_at TEXT;

-- Mutation-time checks cover revocation interleaving with handler reads.
CREATE TRIGGER mobile_intent_active_device BEFORE INSERT ON mobile_action_intents
WHEN NOT EXISTS (SELECT 1 FROM mobile_devices WHERE device_id=NEW.device_id
 AND owner_user_id=NEW.owner_user_id AND status='active' AND public_key_spki IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'MOBILE_DEVICE_UNAVAILABLE'); END;
CREATE TRIGGER mobile_approval_active_device BEFORE INSERT ON mobile_action_approvals
WHEN NOT EXISTS (SELECT 1 FROM mobile_action_intents i JOIN mobile_devices d ON d.device_id=i.device_id
 WHERE i.action_id=NEW.action_id AND d.status='active' AND d.public_key_spki IS NOT NULL
 AND i.status='awaiting_approval' AND julianday(i.expires_at)>julianday('now'))
BEGIN SELECT RAISE(ABORT, 'MOBILE_DEVICE_UNAVAILABLE'); END;
CREATE TRIGGER mobile_result_active_device BEFORE INSERT ON mobile_action_results
WHEN NOT EXISTS (SELECT 1 FROM mobile_action_intents i JOIN mobile_devices d ON d.device_id=i.device_id
 WHERE i.action_id=NEW.action_id AND d.device_id=NEW.device_id AND d.status='active'
 AND d.public_key_spki IS NOT NULL AND i.status='approved')
BEGIN SELECT RAISE(ABORT, 'MOBILE_DEVICE_UNAVAILABLE'); END;
