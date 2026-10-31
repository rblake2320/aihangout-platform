import { SELF, env } from 'cloudflare:test';
import { it, expect } from 'vitest';

// Every account-path failure must land in the ops ledger (analytics_events /
// ops_failure) and be readable from the admin ops summary. Real D1, real routes.
const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.77' };
const post = (path, body, token) => SELF.fetch(`https://aihangout.ai${path}`, {
  method: 'POST', headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
});
const failures = async () => (await env.AIHANGOUT_DB.prepare(
  `SELECT json_extract(event_data,'$.kind') AS kind, json_extract(event_data,'$.reason') AS reason, user_id, event_data
   FROM analytics_events WHERE event_type='ops_failure' ORDER BY id`).all()).results;

it('records registration, login, reset and verify failures and exposes them to admins only', async () => {
  const base = { username: 'ops_user', email: 'ops_user@example.test', password: 'test-only-strong-password-123', ai_agent_type: 'human', accept_tos: true };

  expect((await post('/api/auth/register', { ...base, password: 'short' })).status).toBe(400);
  expect((await post('/api/auth/register', { ...base, accept_tos: false })).status).toBe(400);
  const ok = await post('/api/auth/register', base);
  expect(ok.status).toBe(200);
  const { token, user } = await ok.json();
  expect((await post('/api/auth/register', { ...base, username: 'ops_user2' })).status).toBe(409); // duplicate email

  expect((await post('/api/auth/login', { email: 'nobody@example.test', password: 'whatever-whatever-1' })).status).toBe(401);
  expect((await post('/api/auth/login', { email: base.email, password: 'wrong-password-for-sure' })).status).toBe(401);
  expect((await post('/api/auth/password/forgot', { email: 'ghost@example.test' })).status).toBe(200);
  expect((await post('/api/auth/password/reset', { token: 'x'.repeat(64), password: base.password })).status).toBe(400);
  expect((await post('/api/auth/email/verify', { token: 'y'.repeat(64) })).status).toBe(400);

  const rows = await failures();
  expect(rows.map(r => `${r.kind}:${r.reason}`)).toEqual([
    'register:password_policy', 'register:tos_not_accepted', 'register:duplicate_email',
    'login:unknown_identifier', 'login:bad_password', 'password_forgot:unknown_email',
    'password_reset:token_invalid_or_expired', 'verify_email:token_invalid_or_expired'
  ]);
  expect(rows[4].user_id).toBe(user.id);
  for (const r of rows) expect(r.event_data).not.toContain(base.password); // never the password

  // Non-admin is refused; admin sees the ledger and login activity.
  const get = t => SELF.fetch('https://aihangout.ai/api/admin/ops-summary?hours=1', { headers: { Authorization: `Bearer ${t}` } });
  expect((await get(token)).status).toBe(403);
  await env.AIHANGOUT_DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(user.id).run();
  const summary = await (await get(token)).json();
  expect(summary.success).toBe(true);
  expect(summary.failures.total).toBe(8);
  expect(summary.failures.by_kind.find(r => r.kind === 'login' && r.reason === 'bad_password').count).toBe(1);
  expect(summary.failures.recent[0].kind).toBe('verify_email');
  expect(summary.registrations.registrations).toBe(1);
  expect(summary.logins.logins).toBe(0);
});

it('verifies email once, marks the user verified and does not fail without an email provider', async () => {
  const reg = await post('/api/auth/register', { username: 'ops_verify', email: 'ops_verify@example.test', password: 'test-only-strong-password-123', ai_agent_type: 'human', accept_tos: true });
  const { user } = await reg.json();
  const raw = 'a'.repeat(64);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))).map(b => b.toString(16).padStart(2, '0')).join('');
  await env.AIHANGOUT_DB.prepare(`INSERT INTO auth_email_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, 'verify_email', ?, datetime('now', '+1 day'))`).bind(user.id, hash).run();
  const res = await post('/api/auth/email/verify', { token: raw });
  expect(res.status).toBe(200);
  const row = await env.AIHANGOUT_DB.prepare('SELECT email_verified_at FROM users WHERE id = ?').bind(user.id).first();
  expect(row.email_verified_at).not.toBeNull();
  expect((await post('/api/auth/email/verify', { token: raw })).status).toBe(400); // single use
  expect((await failures()).filter(r => r.kind === 'email')).toEqual([]); // skipped send is not a failure
});
