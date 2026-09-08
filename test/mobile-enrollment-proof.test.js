import { SELF, env } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { enrollmentProof, b64 } from './mobile-proof-helper.js';
let n = 0;
async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'CF-Connecting-IP': `198.19.1.${++n % 250 + 1}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const r = await SELF.fetch('https://aihangout.ai' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
}
async function user() {
  const name = `proof_${++n}`;
  const r = await api('/api/auth/register', { method: 'POST', body: { username: name, email: name + '@example.test', password: 'test-only-long-password-423', aiAgentType: 'human' } });
  expect(r.status).toBe(200);
  return { token: r.json.token, id: r.json.user.id };
}
const submit = (u, body) => api('/api/mobile/devices/enroll', { method: 'POST', token: u.token, body });

it('accepts a real signature once and records unknown hardware assurance', async () => {
  const u = await user(), p = await enrollmentProof(api, u, 'valid');
  const result = await submit(u, { ...p.body, keySecurityLevel: 'strongbox' });
  expect(result.status).toBe(200);
  expect(result.json.keySecurityLevel).toBe('unknown');
  expect((await submit(u, p.body)).status).toBe(409);
  const row = await env.AIHANGOUT_DB.prepare('SELECT * FROM mobile_devices WHERE device_id=?').bind(result.json.deviceId).first();
  expect(row.public_key_spki).toBe(p.body.publicKeySpki);
  expect(row.key_security_level).toBe('unknown');
});
it('admits one of two concurrent submissions with one durable row', async () => {
  const u = await user(), p = await enrollmentProof(api, u, 'concurrent');
  const results = await Promise.all([submit(u, p.body), submit(u, p.body)]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  const count = await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM mobile_devices WHERE enrollment_challenge_id=?').bind(p.body.challengeId).first();
  expect(count.n).toBe(1);
});
it('rejects wrong signer and tampered transcript without consuming a valid challenge', async () => {
  const u = await user(), p = await enrollmentProof(api, u, 'tamper');
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  for (const [key, text] of [[other.privateKey, p.challenge.signingPayload], [p.keys.privateKey, p.challenge.signingPayload + 'x']]) {
    const signature = b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(text)));
    expect((await submit(u, { ...p.body, signature })).status).toBe(403);
  }
  expect((await submit(u, p.body)).status).toBe(200);
});
it('rejects expired challenge and wrong owner', async () => {
  const u = await user(), stranger = await user(), p = await enrollmentProof(api, u, 'expiry');
  expect((await submit(stranger, p.body)).status).toBe(409);
  await env.AIHANGOUT_DB.prepare('UPDATE mobile_enrollment_challenges SET expires_at=0 WHERE challenge_id=?').bind(p.body.challengeId).run();
  expect((await submit(u, p.body)).status).toBe(409);
});
it('rejects certificate, name and package mutation; rejects malformed signatures', async () => {
  const u = await user(), p = await enrollmentProof(api, u, 'bindings');
  for (const patch of [{ signingCertSha256: 'b'.repeat(64) }, { agentName: 'changed' }, { packageName: 'other.app' }, { signature: 'AA==' }, { signature: '!!' }]) {
    expect((await submit(u, { ...p.body, ...patch })).status).toBe(400);
  }
  expect((await submit(u, p.body)).status).toBe(200);
});
it('rejects bare placeholder enrollment and unrecognized build challenge', async () => {
  const u = await user(), p = await enrollmentProof(api, u, 'policy');
  expect((await submit(u, { agentName: 'old', devicePublicKey: 'placeholder-key-1234' })).status).toBe(400);
  const r = await api('/api/mobile/devices/challenge', { method: 'POST', token: u.token, body: { ...p.body, signingCertSha256: 'b'.repeat(64) } });
  expect(r.status).toBe(400);
});
it('revocation cancels pending and approved actions and blocks subsequent writes', async () => {
  const u = await user(), p = await enrollmentProof(api, u, 'revoke');
  const enrolled = await submit(u, p.body);
  const deviceId = enrolled.json.deviceId;
  const actions = [];
  for (let i = 0; i < 2; i++) {
    const r = await api('/api/mobile/actions/intent', { method: 'POST', token: u.token,
      body: { deviceId, capability: 'battery_status_read', targetDescription: 'battery', idempotencyKey: 'revoke-case-' + i } });
    expect(r.status).toBe(200); actions.push(r.json);
  }
  expect((await api(`/api/mobile/actions/${actions[0].actionId}/approve`, { method: 'POST', token: u.token,
    body: { actionDigest: actions[0].actionDigest } })).status).toBe(200);
  expect((await api(`/api/mobile/devices/${deviceId}/revoke`, { method: 'POST', token: u.token, body: {} })).status).toBe(200);
  const rows = await env.AIHANGOUT_DB.prepare('SELECT status FROM mobile_action_intents WHERE device_id=?').bind(deviceId).all();
  expect(rows.results.map(r => r.status)).toEqual(['revoked', 'revoked']);
  expect((await api(`/api/mobile/actions/${actions[0].actionId}/result`, { method: 'POST', token: u.token,
    body: { deviceId, idempotencyKey: 'revoke-case-0', resultStatus: 'executed' } })).status).toBe(409);
  // Direct SQL tests the mutation barrier itself, independent of pre-read checks.
  await expect(env.AIHANGOUT_DB.prepare(`INSERT INTO mobile_action_results
    (action_id,device_id,idempotency_key,result_status) VALUES (?,?,?,'executed')`)
    .bind(actions[0].actionId, deviceId, 'revoke-case-0').run()).rejects.toThrow('MOBILE_DEVICE_UNAVAILABLE');
  const count = await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) n FROM mobile_action_results WHERE device_id=?').bind(deviceId).first();
  expect(count.n).toBe(0);
});
