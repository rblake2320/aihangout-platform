import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { enrollmentProof } from './mobile-proof-helper.js';

// Uncertain-outcome recovery (Team/tasks/A1-to-A3-phone-final-recovery-20260910.md):
// identity-bound lookups for a lost create/enroll response, and the one-shot
// local/test-only fault injector that reproduces "committed, response lost".
// Real src/worker.js in workerd against a real D1. Own IP range (198.18.1.x)
// so rate-limit buckets never collide with sibling test files under the
// shared singleWorker instance.

let clientSeq = 0;
function nextIp() { clientSeq += 1; return `198.18.1.${clientSeq % 250 + 1}`; }

async function api(path, { method = 'GET', body, token, ip, headers: extraHeaders } = {}) {
  const headers = { 'CF-Connecting-IP': ip || nextIp(), ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await SELF.fetch(`https://aihangout.ai${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}

let unique = 0;
async function registerUser(prefix) {
  unique += 1;
  const username = `${prefix}_${unique}`;
  const res = await api('/api/auth/register', {
    method: 'POST', body: { username, email: `${username}@example.test`, password: 'correct horse battery staple 42', aiAgentType: 'human', accept_tos: true }
  });
  expect(res.status, `register ${username} failed: ${JSON.stringify(res.json)}`).toBe(200);
  return { username, ip: nextIp(), token: res.json.token, id: res.json.user.id };
}

async function enrollDevice(user, agentName) {
  const proof = await enrollmentProof(api, user, agentName);
  const res = await api('/api/mobile/devices/enroll', { method: 'POST', token: user.token, body: proof.body });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return { deviceId: res.json.deviceId, spki: proof.body.publicKeySpki };
}

async function createIntent(user, deviceId, idempotencyKey) {
  return api('/api/mobile/actions/intent', {
    method: 'POST', token: user.token, ip: user.ip,
    body: { deviceId, capability: 'battery_status_read', targetDescription: 'own device battery percentage', idempotencyKey }
  });
}

async function arm(user, fault) {
  return api('/api/mobile/fault-arm', { method: 'POST', token: user.token, ip: user.ip, body: { fault } });
}

describe('action-lookup: identity-bound recovery for a lost create response', () => {
  it('the owner finds their own intent by device + idempotency key, with the fields the client binds on', async () => {
    const user = await registerUser('rl_owner');
    unique += 1;
    const { deviceId } = await enrollDevice(user, `rl-agent-${unique}`);
    const key = `android-lookup-${Date.now()}-${unique}`;
    const created = await createIntent(user, deviceId, key);
    expect(created.status).toBe(200);

    const found = await api(`/api/mobile/action-lookup?deviceId=${encodeURIComponent(deviceId)}&idempotencyKey=${encodeURIComponent(key)}`, { token: user.token, ip: user.ip });
    expect(found.status, JSON.stringify(found.json)).toBe(200);
    expect(found.json.intent.action_id).toBe(created.json.actionId);
    expect(found.json.intent.device_id).toBe(deviceId);
    expect(found.json.intent.idempotency_key).toBe(key);
    expect(found.json.intent.owner_user_id).toBe(user.id);
    expect(found.json.intent.action_digest).toBe(created.json.actionDigest);
    expect(found.json.intent.risk_tier).toBe('read_only');
    expect(found.json.result).toBeNull();
  });

  it('a different account gets the same generic 404 as for a nonexistent key', async () => {
    const owner = await registerUser('rl_owner2');
    const other = await registerUser('rl_other');
    unique += 1;
    const { deviceId } = await enrollDevice(owner, `rl-agent-${unique}`);
    const key = `android-lookup-${Date.now()}-${unique}`;
    await createIntent(owner, deviceId, key);

    const foreign = await api(`/api/mobile/action-lookup?deviceId=${deviceId}&idempotencyKey=${key}`, { token: other.token, ip: other.ip });
    const missing = await api(`/api/mobile/action-lookup?deviceId=${deviceId}&idempotencyKey=never-used-key`, { token: owner.token, ip: owner.ip });
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.json.error).toBe(missing.json.error);
  });

  it('missing parameters are a 400, not a scan', async () => {
    const user = await registerUser('rl_params');
    const res = await api('/api/mobile/action-lookup?deviceId=only', { token: user.token, ip: user.ip });
    expect(res.status).toBe(400);
  });
});

describe('device-lookup: identity-bound recovery for a lost enroll response', () => {
  it('the owner finds their device by agent name with the public key the client binds on', async () => {
    const user = await registerUser('dl_owner');
    unique += 1;
    const agent = `dl-agent-${unique}`;
    const { deviceId, spki } = await enrollDevice(user, agent);
    const found = await api(`/api/mobile/device-lookup?agentName=${encodeURIComponent(agent)}`, { token: user.token, ip: user.ip });
    expect(found.status, JSON.stringify(found.json)).toBe(200);
    expect(found.json.device.device_id).toBe(deviceId);
    expect(found.json.device.agent_name).toBe(agent);
    expect(found.json.device.public_key_spki).toBe(spki);
    expect(found.json.device.status).toBe('active');
  });

  it('a different account cannot see it; an unknown name is the same generic 404', async () => {
    const owner = await registerUser('dl_owner2');
    const other = await registerUser('dl_other');
    unique += 1;
    const agent = `dl-agent-${unique}`;
    await enrollDevice(owner, agent);
    const foreign = await api(`/api/mobile/device-lookup?agentName=${agent}`, { token: other.token, ip: other.ip });
    const missing = await api(`/api/mobile/device-lookup?agentName=no-such-agent-${unique}`, { token: owner.token, ip: owner.ip });
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.json.error).toBe(missing.json.error);
  });
});

describe('one-shot ambiguous-POST fault injection (local/test only)', () => {
  it('create_lost_response: the intent is committed, the response is lost, the lookup recovers it, and the fault does not repeat', async () => {
    const user = await registerUser('fi_create');
    unique += 1;
    const { deviceId } = await enrollDevice(user, `fi-agent-${unique}`);
    const armed = await arm(user, 'create_lost_response');
    expect(armed.status, JSON.stringify(armed.json)).toBe(200);
    expect(armed.json.oneShot).toBe(true);

    const key = `android-fault-${Date.now()}-${unique}`;
    // The route answers 502, and the fetch handler's error sanitizer (worker.js
    // "Never expose internal exception details") rewrites every /api 5xx into
    // the generic 503 -- which is precisely what a phone sees in a real
    // outage, so that shipped behaviour is what the test asserts.
    const lost = await createIntent(user, deviceId, key);
    expect(lost.status, lost.text).toBe(503);
    expect(lost.json.success).toBe(false);
    expect(lost.json.service_status).toBe('degraded');
    expect(await env.AIHANGOUT_KV.get('mobile_fault_armed:create_lost_response'), 'arm key must be consumed').toBeNull();

    const rows = await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM mobile_action_intents WHERE device_id = ? AND idempotency_key = ?').bind(deviceId, key).first();
    expect(rows.n).toBe(1);

    const found = await api(`/api/mobile/action-lookup?deviceId=${deviceId}&idempotencyKey=${key}`, { token: user.token, ip: user.ip });
    expect(found.status).toBe(200);
    expect(found.json.intent.status).toBe('awaiting_approval');

    const replay = await createIntent(user, deviceId, key);
    expect(replay.status).toBe(409);

    const next = await createIntent(user, deviceId, `${key}-next`);
    expect(next.status, 'fault must be one-shot').toBe(200);
  });

  it('enroll_lost_response: the device is committed, the response is lost, and device-lookup recovers it with the same key', async () => {
    const user = await registerUser('fi_enroll');
    unique += 1;
    const agent = `fi-enroll-agent-${unique}`;
    const proof = await enrollmentProof(api, user, agent);
    const armed = await arm(user, 'enroll_lost_response');
    expect(armed.status).toBe(200);

    const lost = await api('/api/mobile/devices/enroll', { method: 'POST', token: user.token, body: proof.body });
    expect(lost.status, lost.text).toBe(503);
    expect(lost.json.success).toBe(false);
    expect(lost.json.service_status).toBe('degraded');
    expect(await env.AIHANGOUT_KV.get('mobile_fault_armed:enroll_lost_response'), 'arm key must be consumed').toBeNull();

    const found = await api(`/api/mobile/device-lookup?agentName=${encodeURIComponent(agent)}`, { token: user.token, ip: user.ip });
    expect(found.status, JSON.stringify(found.json)).toBe(200);
    expect(found.json.device.public_key_spki).toBe(proof.body.publicKeySpki);
    expect(found.json.device.status).toBe('active');
  });

  it('arming requires auth and a known fault name', async () => {
    const user = await registerUser('fi_arm');
    const anon = await api('/api/mobile/fault-arm', { method: 'POST', body: { fault: 'create_lost_response' } });
    expect(anon.status).toBe(401);
    const bad = await arm(user, 'delete_everything');
    expect(bad.status).toBe(400);
  });
});
