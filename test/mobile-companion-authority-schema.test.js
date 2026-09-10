import { enrollmentProof } from './mobile-proof-helper.js';
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// AIHangout Mobile Companion authority schema, Gate 1 of A6's architecture
// review (Team/tasks/A6-aihangout-phoneclaw-lane-20260908.md). Owner
// decision 2026-09-08: build an owned companion, not a PhoneClaw fork.
// Real src/worker.js inside workerd against a real D1, same no-mock
// discipline as the other test files in this repo. Uses 198.51.100.x's
// sibling 198.18.0.x (a distinct RFC 2544 benchmarking range) to avoid
// colliding with any other test file's IP range under the shared
// singleWorker instance.

let clientSeq = 0;
function nextIp() {
  clientSeq += 1;
  return `198.18.0.${clientSeq % 250 + 1}`;
}

async function api(path, { method = 'GET', body, token, ip, headers: extraHeaders } = {}) {
  const headers = { 'CF-Connecting-IP': ip || nextIp(), ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await SELF.fetch(`https://aihangout.ai${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

let unique = 0;
async function registerUser(prefix) {
  unique += 1;
  const username = `${prefix}_${unique}`;
  const email = `${username}@example.test`;
  const password = 'correct horse battery staple 42';
  const ip = nextIp();
  const res = await api('/api/auth/register', {
    method: 'POST', ip,
    body: { username, email, password, aiAgentType: 'human' }
  });
  expect(res.status, `register ${username} failed: ${JSON.stringify(res.json)}`).toBe(200);
  return { username, email, password, ip, token: res.json.token, id: res.json.user.id };
}

async function enrollDevice(user, overrides = {}) {
  unique += 1;
  const proof = await enrollmentProof(api, user, overrides.agentName || `probe-agent-${unique}`);
  return api('/api/mobile/devices/enroll', {method: 'POST', token: user.token, body: proof.body});
}

async function createIntent(user, deviceId, overrides = {}) {
  unique += 1;
  return api('/api/mobile/actions/intent', {
    method: 'POST', token: user.token, ip: user.ip,
    body: {
      deviceId, capability: 'battery_status_read', targetDescription: 'own device battery percentage',
      idempotencyKey: `idem-${unique}-${Date.now()}`, ...overrides
    }
  });
}

describe('Device enrollment', () => {
  it('enrolls a real device row owned by the caller', async () => {
    const user = await registerUser('mc_enroll');
    const res = await enrollDevice(user);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.deviceId).toBeTruthy();
    const row = await env.AIHANGOUT_DB.prepare('SELECT owner_user_id, status FROM mobile_devices WHERE device_id = ?').bind(res.json.deviceId).first();
    expect(row.owner_user_id).toBe(user.id);
    expect(row.status).toBe('active');
  });

  it('refuses a second device under the same agent name for the same owner', async () => {
    const user = await registerUser('mc_enroll_dup');
    const first = await enrollDevice(user, { agentName: 'same-name' });
    expect(first.status).toBe(200);
    const second = await enrollDevice(user, { agentName: 'same-name' });
    expect(second.status).toBe(409);
  });

  it('requires authentication', async () => {
    const res = await api('/api/mobile/devices/enroll', { method: 'POST', body: { agentName: 'x', devicePublicKey: 'y'.repeat(20) } });
    expect(res.status).toBe(401);
  });
});

describe('Device revocation', () => {
  it('the owner can revoke their own device', async () => {
    const user = await registerUser('mc_revoke');
    const enrolled = await enrollDevice(user);
    const revoke = await api(`/api/mobile/devices/${enrolled.json.deviceId}/revoke`, { method: 'POST', token: user.token, ip: user.ip, body: {} });
    expect(revoke.status, JSON.stringify(revoke.json)).toBe(200);
    const row = await env.AIHANGOUT_DB.prepare('SELECT status FROM mobile_devices WHERE device_id = ?').bind(enrolled.json.deviceId).first();
    expect(row.status).toBe('revoked');
  });

  it('a different account cannot revoke someone else\'s device', async () => {
    const owner = await registerUser('mc_revoke_owner');
    const attacker = await registerUser('mc_revoke_attacker');
    const enrolled = await enrollDevice(owner);
    const revoke = await api(`/api/mobile/devices/${enrolled.json.deviceId}/revoke`, { method: 'POST', token: attacker.token, ip: attacker.ip, body: {} });
    expect(revoke.status).toBe(404);
    const row = await env.AIHANGOUT_DB.prepare('SELECT status FROM mobile_devices WHERE device_id = ?').bind(enrolled.json.deviceId).first();
    expect(row.status).toBe('active');
  });

  it('a revoked device can no longer be used to create an action intent', async () => {
    const user = await registerUser('mc_revoke_then_intent');
    const enrolled = await enrollDevice(user);
    await api(`/api/mobile/devices/${enrolled.json.deviceId}/revoke`, { method: 'POST', token: user.token, ip: user.ip, body: {} });
    const intent = await createIntent(user, enrolled.json.deviceId);
    expect(intent.status).toBe(404);
  });
});

describe('Action intent capability allowlist (this release: read-only diagnostics only)', () => {
  it('accepts an allowlisted read-only capability', async () => {
    const user = await registerUser('mc_intent_ok');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId, { capability: 'device_diagnostics_read' });
    expect(intent.status, JSON.stringify(intent.json)).toBe(200);
    expect(intent.json.actionDigest).toBeTruthy();
  });

  it('rejects a capability outside the fixed allowlist outright -- not merely unimplemented, refused', async () => {
    const user = await registerUser('mc_intent_bad');
    const enrolled = await enrollDevice(user);
    for (const bad of ['accessibility_action', 'camera_capture', 'schedule_recurring', 'clear_schedule', 'arbitrary_shell_exec']) {
      const intent = await createIntent(user, enrolled.json.deviceId, { capability: bad });
      expect(intent.status, `capability ${bad} should have been refused`).toBe(400);
    }
    // Confirm the DB-level CHECK constraint is also real, not just the API
    // layer -- direct INSERT bypassing the route must fail too. Autonomous
    // scheduling stays excluded even after the 2026-09-08 capability-parity
    // expansion (standing launch-task constraint: no autonomous recurring
    // schedules) -- used here as the negative-control capability.
    let threw = false;
    try {
      await env.AIHANGOUT_DB.prepare(
        `INSERT INTO mobile_action_intents (action_id, device_id, owner_user_id, capability, target_description, action_digest, idempotency_key, expires_at)
         VALUES ('bad-action-1', ?, ?, 'schedule_recurring', 'x', 'x', 'x', datetime('now','+1 hour'))`
      ).bind(enrolled.json.deviceId, user.id).run();
    } catch (e) { threw = true; }
    expect(threw, 'schema CHECK constraint must reject a disallowed capability even at the DB layer').toBe(true);
  });

  it('accepts every capability-parity addition (UI automation, screenshot, SMS, call, email) with the correct risk tier', async () => {
    const user = await registerUser('mc_intent_parity');
    const enrolled = await enrollDevice(user);
    const expected = {
      ui_read_screen: 'device_ui_action', ui_click: 'device_ui_action', ui_type: 'device_ui_action',
      screenshot_capture: 'device_ui_action',
      sms_send: 'communication_send', call_make: 'communication_send', email_send: 'communication_send',
    };
    for (const [capability, riskTier] of Object.entries(expected)) {
      const intent = await createIntent(user, enrolled.json.deviceId, { capability });
      expect(intent.status, `capability ${capability}: ${JSON.stringify(intent.json)}`).toBe(200);
      expect(intent.json.riskTier, `capability ${capability} should be risk tier ${riskTier}`).toBe(riskTier);
    }
  });

  it('a caller cannot create an intent against a device they do not own', async () => {
    const owner = await registerUser('mc_intent_owner');
    const attacker = await registerUser('mc_intent_attacker');
    const enrolled = await enrollDevice(owner);
    const intent = await createIntent(attacker, enrolled.json.deviceId);
    expect(intent.status).toBe(404);
  });

  it('refuses a duplicate idempotencyKey for the same device', async () => {
    const user = await registerUser('mc_intent_idem');
    const enrolled = await enrollDevice(user);
    const key = `fixed-key-${Date.now()}`;
    const first = await createIntent(user, enrolled.json.deviceId, { idempotencyKey: key });
    expect(first.status).toBe(200);
    const second = await createIntent(user, enrolled.json.deviceId, { idempotencyKey: key });
    expect(second.status).toBe(409);
  });
});

describe('Approval: exact digest binding, expiry, idempotent re-approval', () => {
  it('refuses approval with a digest that does not match (the plan changed)', async () => {
    const user = await registerUser('mc_approve_baddigest');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId);
    const approve = await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: 'wrong-digest' }
    });
    expect(approve.status).toBe(409);
    const row = await env.AIHANGOUT_DB.prepare('SELECT status FROM mobile_action_intents WHERE action_id = ?').bind(intent.json.actionId).first();
    expect(row.status).toBe('awaiting_approval');
  });

  it('approves with the correct digest, and re-approving the SAME digest is idempotent', async () => {
    const user = await registerUser('mc_approve_ok');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId);
    const approve1 = await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: intent.json.actionDigest }
    });
    expect(approve1.status, JSON.stringify(approve1.json)).toBe(200);
    const approve2 = await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: intent.json.actionDigest }
    });
    expect(approve2.status).toBe(200);
    expect(approve2.json.already_approved).toBe(true);
    const count = await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM mobile_action_approvals WHERE action_id = ?').bind(intent.json.actionId).first();
    expect(count.n).toBe(1);
  });

  it('refuses approval of an expired intent', async () => {
    const user = await registerUser('mc_approve_expired');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId);
    await env.AIHANGOUT_DB.prepare("UPDATE mobile_action_intents SET expires_at = ? WHERE action_id = ?").bind(new Date(Date.now() - 60000).toISOString(), intent.json.actionId).run();
    const approve = await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: intent.json.actionDigest }
    });
    expect(approve.status).toBe(410);
    const row = await env.AIHANGOUT_DB.prepare('SELECT status FROM mobile_action_intents WHERE action_id = ?').bind(intent.json.actionId).first();
    expect(row.status).toBe('expired');
  });

  it('a different account cannot approve someone else\'s action', async () => {
    const owner = await registerUser('mc_approve_owner');
    const attacker = await registerUser('mc_approve_attacker');
    const enrolled = await enrollDevice(owner);
    const intent = await createIntent(owner, enrolled.json.deviceId);
    const approve = await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: attacker.token, ip: attacker.ip, body: { actionDigest: intent.json.actionDigest }
    });
    expect(approve.status).toBe(404);
  });

  it('an action already approved before its expiry is still idempotently reported as approved AFTER it expires (ordering fix)', async () => {
    const user = await registerUser('mc_approve_thenexpire');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId);
    const approve1 = await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: intent.json.actionDigest }
    });
    expect(approve1.status).toBe(200);
    // Force expires_at into the past AFTER approval -- a real approved
    // action's expiry clock becoming stale should never retroactively turn
    // a repeated approval call into a 410.
    await env.AIHANGOUT_DB.prepare("UPDATE mobile_action_intents SET expires_at = ? WHERE action_id = ?")
      .bind(new Date(Date.now() - 60000).toISOString(), intent.json.actionId).run();
    const approve2 = await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: intent.json.actionDigest }
    });
    expect(approve2.status, JSON.stringify(approve2.json)).toBe(200);
    expect(approve2.json.already_approved).toBe(true);
  });

  it('a concurrent duplicate approval race is a graceful idempotent success, never a 500', async () => {
    const user = await registerUser('mc_approve_race');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId);
    // Simulate the exact race the review named: two approvals for the same
    // action_id both reach the INSERT after the status check passed for
    // both. Insert one directly to occupy the PRIMARY KEY, matching what a
    // genuinely concurrent second request would collide against, then call
    // the real route -- it must not throw a raw DB error to the caller.
    await env.AIHANGOUT_DB.prepare(
      'INSERT INTO mobile_action_approvals (action_id, approved_by, approved_digest) VALUES (?, ?, ?)'
    ).bind(intent.json.actionId, user.id, intent.json.actionDigest).run();
    const approve = await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: intent.json.actionDigest }
    });
    expect(approve.status, JSON.stringify(approve.json)).toBe(200);
    expect(approve.json.already_approved).toBe(true);
  });
});

describe('Security-review fixes (2026-09-08): confirm-phrase secrecy, rate limiting, sanitization', () => {
  it('the missing-confirm-phrase error never echoes the required phrase itself', async () => {
    const user = await registerUser('mc_secfix_noecho');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId, { capability: 'sms_send', targetDescription: 'Send "hi" to +15555550100' });
    const approve = await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: intent.json.actionDigest }
    });
    expect(approve.status).toBe(400);
    const bodyText = JSON.stringify(approve.json);
    expect(bodyText, 'the exact required confirm phrase must never appear in an error response').not.toContain('I APPROVE THIS SEND');
  });

  it('legacy hostile placeholder keys are rejected without enrolling a device', async () => {
    const user = await registerUser('mc_secfix_sanitize');
    const res = await api('/api/mobile/devices/enroll', {
      method: 'POST', token: user.token, ip: user.ip,
      body: { agentName: 'sanitize-probe', devicePublicKey: '<script>alert(1)</script>' + 'x'.repeat(3000) }
    });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    const row = await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) n FROM mobile_devices WHERE owner_user_id = ?').bind(user.id).first();
    expect(row.n).toBe(0);
  });
});

describe('communication_send tier (SMS/call/email -- leaves the device): extra confirm-phrase gate', () => {
  it('refuses approval of an SMS action without the exact confirm phrase', async () => {
    const user = await registerUser('mc_confirm_missing');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId, { capability: 'sms_send', targetDescription: 'Send "test" to +15555550100' });
    const approve = await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: intent.json.actionDigest }
    });
    expect(approve.status).toBe(400);
    const row = await env.AIHANGOUT_DB.prepare('SELECT status FROM mobile_action_intents WHERE action_id = ?').bind(intent.json.actionId).first();
    expect(row.status).toBe('awaiting_approval');
  });

  it('refuses approval with the WRONG confirm phrase, even if close', async () => {
    const user = await registerUser('mc_confirm_wrong');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId, { capability: 'call_make', targetDescription: 'Call +15555550100' });
    const approve = await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip,
      body: { actionDigest: intent.json.actionDigest, confirmPhrase: 'i approve this send' }
    });
    expect(approve.status).toBe(400);
  });

  it('approves an SMS action once the exact confirm phrase is supplied', async () => {
    const user = await registerUser('mc_confirm_ok');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId, { capability: 'sms_send', targetDescription: 'Send "test" to +15555550100' });
    const approve = await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip,
      body: { actionDigest: intent.json.actionDigest, confirmPhrase: 'I APPROVE THIS SEND' }
    });
    expect(approve.status, JSON.stringify(approve.json)).toBe(200);
  });

  it('a read_only-tier action needs no confirm phrase at all', async () => {
    const user = await registerUser('mc_confirm_readonly');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId, { capability: 'battery_status_read' });
    const approve = await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: intent.json.actionDigest }
    });
    expect(approve.status).toBe(200);
  });
});

describe('Result reporting: bound to the approved action, exactly-once, redacted', () => {
  it('refuses a result report before approval', async () => {
    const user = await registerUser('mc_result_unapproved');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId);
    const result = await api(`/api/mobile/actions/${intent.json.actionId}/result`, {
      method: 'POST', token: user.token, ip: user.ip,
      body: { deviceId: enrolled.json.deviceId, idempotencyKey: 'whatever', resultStatus: 'executed' }
    });
    expect(result.status).toBe(409);
  });

  it('accepts a result after approval, creates an unconfirmed effect row, and a duplicate report is a no-op', async () => {
    const user = await registerUser('mc_result_ok');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId);
    await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: intent.json.actionDigest }
    });

    const key = intent.json.actionId; // fetch the real idempotency key from the row instead of guessing
    const row = await env.AIHANGOUT_DB.prepare('SELECT idempotency_key FROM mobile_action_intents WHERE action_id = ?').bind(intent.json.actionId).first();

    const result1 = await api(`/api/mobile/actions/${intent.json.actionId}/result`, {
      method: 'POST', token: user.token, ip: user.ip,
      body: { deviceId: enrolled.json.deviceId, idempotencyKey: row.idempotency_key, resultStatus: 'executed', resultPayloadHash: 'deadbeef' }
    });
    expect(result1.status, JSON.stringify(result1.json)).toBe(200);
    expect(result1.json.effect_status).toBe('unconfirmed');

    const result2 = await api(`/api/mobile/actions/${intent.json.actionId}/result`, {
      method: 'POST', token: user.token, ip: user.ip,
      body: { deviceId: enrolled.json.deviceId, idempotencyKey: row.idempotency_key, resultStatus: 'executed', resultPayloadHash: 'deadbeef' }
    });
    expect(result2.status).toBe(200);
    expect(result2.json.already_reported).toBe(true);

    const count = await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM mobile_action_results WHERE action_id = ?').bind(intent.json.actionId).first();
    expect(count.n).toBe(1);
    const effect = await env.AIHANGOUT_DB.prepare('SELECT effect_status FROM mobile_action_effects WHERE action_id = ?').bind(intent.json.actionId).first();
    expect(effect.effect_status).toBe('unconfirmed');
  });

  it('refuses a result report with a mismatched deviceId or idempotencyKey', async () => {
    const user = await registerUser('mc_result_mismatch');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId);
    await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: intent.json.actionDigest }
    });
    const result = await api(`/api/mobile/actions/${intent.json.actionId}/result`, {
      method: 'POST', token: user.token, ip: user.ip,
      body: { deviceId: enrolled.json.deviceId, idempotencyKey: 'totally-wrong-key', resultStatus: 'executed' }
    });
    expect(result.status).toBe(409);
  });
});

describe('Effect verification and readback', () => {
  it('verify-effect requires a reported result first', async () => {
    const user = await registerUser('mc_verify_noresult');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId);
    await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: intent.json.actionDigest }
    });
    const verify = await api(`/api/mobile/actions/${intent.json.actionId}/verify-effect`, {
      method: 'POST', token: user.token, ip: user.ip, body: { note: 'checked screen' }
    });
    expect(verify.status).toBe(409);
  });

  it('full happy path: enroll -> intent -> approve -> result -> verify-effect -> readback', async () => {
    const user = await registerUser('mc_full_path');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId, { capability: 'battery_status_read', targetDescription: '87% battery, charging' });
    expect(intent.status).toBe(200);

    const approve = await api(`/api/mobile/actions/${intent.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: intent.json.actionDigest }
    });
    expect(approve.status).toBe(200);

    const row = await env.AIHANGOUT_DB.prepare('SELECT idempotency_key FROM mobile_action_intents WHERE action_id = ?').bind(intent.json.actionId).first();
    const result = await api(`/api/mobile/actions/${intent.json.actionId}/result`, {
      method: 'POST', token: user.token, ip: user.ip,
      body: { deviceId: enrolled.json.deviceId, idempotencyKey: row.idempotency_key, resultStatus: 'executed', resultPayloadHash: 'abc123' }
    });
    expect(result.status).toBe(200);

    const verify = await api(`/api/mobile/actions/${intent.json.actionId}/verify-effect`, {
      method: 'POST', token: user.token, ip: user.ip, body: { note: 'confirmed on-screen' }
    });
    expect(verify.status).toBe(200);

    const readback = await api(`/api/mobile/actions/${intent.json.actionId}`, { token: user.token, ip: user.ip });
    expect(readback.status).toBe(200);
    expect(readback.json.intent.status).toBe('approved');
    expect(readback.json.intent.capability).toBe('battery_status_read');
    expect(readback.json.approval.approved_by).toBe(user.id);
    expect(readback.json.result.result_status).toBe('executed');
    expect(readback.json.effect.effect_status).toBe('effect_verified');
  });

  it('readback never leaks another account\'s action', async () => {
    const owner = await registerUser('mc_readback_owner');
    const other = await registerUser('mc_readback_other');
    const enrolled = await enrollDevice(owner);
    const intent = await createIntent(owner, enrolled.json.deviceId);
    const readback = await api(`/api/mobile/actions/${intent.json.actionId}`, { token: other.token, ip: other.ip });
    expect(readback.status).toBe(404);
  });
});

describe('Deny: the human explicitly refuses -- a terminal state distinct from expiry', () => {
  it('the owner can deny a pending action; re-denying is idempotent; readback shows denied', async () => {
    const user = await registerUser('mc_deny');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId);
    const actionId = intent.json.actionId;

    const deny = await api(`/api/mobile/actions/${actionId}/deny`, { method: 'POST', token: user.token, ip: user.ip, body: {} });
    expect(deny.status, JSON.stringify(deny.json)).toBe(200);
    expect(deny.json.status).toBe('denied');

    const again = await api(`/api/mobile/actions/${actionId}/deny`, { method: 'POST', token: user.token, ip: user.ip, body: {} });
    expect(again.status).toBe(200);
    expect(again.json.already_denied).toBe(true);

    const readback = await api(`/api/mobile/actions/${actionId}`, { token: user.token, ip: user.ip });
    expect(readback.json.intent.status).toBe('denied');
    expect(readback.json.approval).toBeNull();
  });

  it('a denied action can no longer be approved, and no result can be reported against it', async () => {
    const user = await registerUser('mc_deny_then_approve');
    const enrolled = await enrollDevice(user);
    const idempotencyKey = `idem-deny-${Date.now()}`;
    const intent = await createIntent(user, enrolled.json.deviceId, { idempotencyKey });
    const actionId = intent.json.actionId;
    await api(`/api/mobile/actions/${actionId}/deny`, { method: 'POST', token: user.token, ip: user.ip, body: {} });

    const approve = await api(`/api/mobile/actions/${actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: intent.json.actionDigest }
    });
    expect(approve.status).toBe(409);

    const result = await api(`/api/mobile/actions/${actionId}/result`, {
      method: 'POST', token: user.token, ip: user.ip,
      body: { deviceId: enrolled.json.deviceId, idempotencyKey, resultStatus: 'executed', resultPayloadHash: 'sha256:deadbeef' }
    });
    expect(result.status).toBe(409);
    const row = await env.AIHANGOUT_DB.prepare('SELECT status FROM mobile_action_intents WHERE action_id = ?').bind(actionId).first();
    expect(row.status).toBe('denied');
  });

  it('an already-approved action cannot be denied after the fact -- it stays approved', async () => {
    const user = await registerUser('mc_deny_after_approve');
    const enrolled = await enrollDevice(user);
    const intent = await createIntent(user, enrolled.json.deviceId);
    const actionId = intent.json.actionId;
    await api(`/api/mobile/actions/${actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: intent.json.actionDigest }
    });

    const deny = await api(`/api/mobile/actions/${actionId}/deny`, { method: 'POST', token: user.token, ip: user.ip, body: {} });
    expect(deny.status).toBe(409);
    const row = await env.AIHANGOUT_DB.prepare('SELECT status FROM mobile_action_intents WHERE action_id = ?').bind(actionId).first();
    expect(row.status).toBe('approved');
  });

  it('a different account cannot deny someone else\'s action, and learns nothing about its existence', async () => {
    const owner = await registerUser('mc_deny_owner');
    const attacker = await registerUser('mc_deny_attacker');
    const enrolled = await enrollDevice(owner);
    const intent = await createIntent(owner, enrolled.json.deviceId);

    const deny = await api(`/api/mobile/actions/${intent.json.actionId}/deny`, { method: 'POST', token: attacker.token, ip: attacker.ip, body: {} });
    expect(deny.status).toBe(404);
    const row = await env.AIHANGOUT_DB.prepare('SELECT status FROM mobile_action_intents WHERE action_id = ?').bind(intent.json.actionId).first();
    expect(row.status).toBe('awaiting_approval');
  });
});

describe('Revocation cascade: fate of intents that already existed at revoke time', () => {
  it('revoking a device marks its awaiting AND approved-but-unexecuted intents revoked, and neither can proceed afterwards', async () => {
    const user = await registerUser('mc_revoke_cascade');
    const enrolled = await enrollDevice(user);
    const deviceId = enrolled.json.deviceId;

    const awaiting = await createIntent(user, deviceId);
    const approvedKey = `idem-cascade-${Date.now()}`;
    const approved = await createIntent(user, deviceId, { idempotencyKey: approvedKey });
    const approveRes = await api(`/api/mobile/actions/${approved.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: approved.json.actionDigest }
    });
    expect(approveRes.status).toBe(200);

    const revoke = await api(`/api/mobile/devices/${deviceId}/revoke`, { method: 'POST', token: user.token, ip: user.ip, body: {} });
    expect(revoke.status, JSON.stringify(revoke.json)).toBe(200);

    for (const id of [awaiting.json.actionId, approved.json.actionId]) {
      const row = await env.AIHANGOUT_DB.prepare('SELECT status FROM mobile_action_intents WHERE action_id = ?').bind(id).first();
      expect(row.status, id).toBe('revoked');
    }

    const lateApprove = await api(`/api/mobile/actions/${awaiting.json.actionId}/approve`, {
      method: 'POST', token: user.token, ip: user.ip, body: { actionDigest: awaiting.json.actionDigest }
    });
    expect(lateApprove.status).toBe(409);

    const lateResult = await api(`/api/mobile/actions/${approved.json.actionId}/result`, {
      method: 'POST', token: user.token, ip: user.ip,
      body: { deviceId, idempotencyKey: approvedKey, resultStatus: 'executed', resultPayloadHash: 'sha256:late' }
    });
    expect(lateResult.status).toBe(409);
    const results = await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM mobile_action_results WHERE action_id = ?').bind(approved.json.actionId).first();
    expect(results.n).toBe(0);
  });

  it('a non-owner\'s failed revoke attempt cascades to nothing', async () => {
    const owner = await registerUser('mc_cascade_owner');
    const attacker = await registerUser('mc_cascade_attacker');
    const enrolled = await enrollDevice(owner);
    const intent = await createIntent(owner, enrolled.json.deviceId);

    const revoke = await api(`/api/mobile/devices/${enrolled.json.deviceId}/revoke`, { method: 'POST', token: attacker.token, ip: attacker.ip, body: {} });
    expect(revoke.status).toBe(404);
    const row = await env.AIHANGOUT_DB.prepare('SELECT status FROM mobile_action_intents WHERE action_id = ?').bind(intent.json.actionId).first();
    expect(row.status).toBe('awaiting_approval');
  });
});
