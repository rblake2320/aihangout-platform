import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import {
  POLICY_VERSION, CONSENT_KEY, readConsent, writeConsent, analyticsAllowed, needsBanner, hasOptOutSignal,
} from '../frontend/src/consent/consent.ts';

// AIH-R4: telemetry off until consent, consent log, data export, account deletion (anonymisation).
const base = 'https://aihangout.ai';
let ipN = 0;
const hdr = (extra = {}) => ({ 'Content-Type': 'application/json', 'CF-Connecting-IP': `203.0.113.${100 + (ipN++ % 100)}`, ...extra });
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function register(name) {
  const res = await SELF.fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: hdr(),
    body: JSON.stringify({ username: name, email: `${name}@example.test`, password: 'test-only-strong-password-123', ai_agent_type: 'human', accept_tos: true }),
  });
  expect(res.status).toBe(200);
  const { token, user } = await res.json();
  return { token, id: user.id, email: `${name}@example.test`, password: 'test-only-strong-password-123' };
}
const countEvents = async () => (await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM analytics_events WHERE event_type LIKE ?').bind('tel_%').first()).n;
const telBatch = (query, headers = {}) => SELF.fetch(`${base}/api/analytics/batch${query}`, {
  method: 'POST', headers: hdr(headers),
  body: JSON.stringify({ session_id: 'a'.repeat(32), events: [{ type: 'page_view', ts: Date.now(), route: '/problems', data: { viewport_w: 1, viewport_h: 1 } }] }),
});

describe('telemetry is off until consent', () => {
  it('drops batches that do not declare consent, or that carry a privacy signal, and stores nothing', async () => {
    const before = await countEvents();
    for (const [q, h] of [['', {}], ['?consent=no', {}], ['?consent=analytics', { 'Sec-GPC': '1' }], ['?consent=analytics', { DNT: '1' }]]) {
      expect((await telBatch(q, h)).status).toBe(204);
    }
    expect(await countEvents()).toBe(before);

    const ok = await telBatch('?consent=analytics');
    expect(ok.status).toBeLessThan(300);
    expect(ok.status).not.toBe(204);
    expect(await countEvents()).toBeGreaterThan(before);
  });

  it('applies the same gate to the universal event endpoint', async () => {
    const body = JSON.stringify({ session_id: 'ses_consent_test', events: [{ event_type: 'consent_probe', page_url: '/x', metadata: {} }] });
    const count = async () => (await env.AIHANGOUT_DB.prepare("SELECT COUNT(*) AS n FROM analytics_events WHERE event_type = 'consent_probe'").first()).n;
    expect((await SELF.fetch(`${base}/api/events/batch`, { method: 'POST', headers: hdr(), body })).status).toBe(204);
    expect(await count()).toBe(0);
    expect((await SELF.fetch(`${base}/api/events/batch?consent=analytics`, { method: 'POST', headers: hdr(), body })).status).toBe(200);
    expect(await count()).toBe(1);
  });
});

describe('POST /api/consent', () => {
  it('records decisions with the policy version, links the signed-in user, rejects malformed input', async () => {
    const u = await register('consent_user');
    const post = (body, headers = {}) => SELF.fetch(`${base}/api/consent`, { method: 'POST', headers: hdr(headers), body: JSON.stringify(body) });
    expect((await post({ analytics: true })).status).toBe(200);
    expect((await post({ analytics: false, source: 'settings' }, auth(u.token))).status).toBe(200);
    expect((await post({ analytics: 'yes' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    const rows = (await env.AIHANGOUT_DB.prepare('SELECT user_id, analytics, source, policy_version, gpc FROM consent_log ORDER BY id').all()).results;
    expect(rows).toEqual([
      { user_id: null, analytics: 1, source: 'banner', policy_version: POLICY_VERSION, gpc: 0 },
      { user_id: u.id, analytics: 0, source: 'settings', policy_version: POLICY_VERSION, gpc: 0 },
    ]);
  });
});

async function seedUserData(u, otherId) {
  const db = env.AIHANGOUT_DB;
  const p = await db.prepare("INSERT INTO problems (user_id, title, description, category, difficulty) VALUES (?, 'Kept problem', 'body', 'General', 'easy')").bind(u.id).run();
  await db.prepare("INSERT INTO solutions (problem_id, user_id, solution_text) VALUES (?, ?, 'my solution')").bind(p.meta.last_row_id, u.id).run();
  await db.prepare("INSERT INTO bookmarks (user_id, content_type, content_id) VALUES (?, 'problem', ?)").bind(u.id, p.meta.last_row_id).run();
  await db.prepare("INSERT INTO votes (user_id, target_type, target_id, vote_type) VALUES (?, 'problem', ?, 'up')").bind(u.id, p.meta.last_row_id).run();
  await db.prepare("INSERT INTO analytics_events (event_type, user_id, user_type, ip_address) VALUES ('tel_page_view', ?, 'human', '198.51.100.9')").bind(u.id).run();
  await db.prepare("INSERT INTO followers (follower_id, following_id) VALUES (?, ?)").bind(u.id, otherId).run();
  await db.prepare("INSERT INTO followers (follower_id, following_id) VALUES (?, ?)").bind(otherId, u.id).run();
  await db.prepare("INSERT INTO bookmarks (user_id, content_type, content_id) VALUES (?, 'problem', ?)").bind(otherId, p.meta.last_row_id).run();
  return p.meta.last_row_id;
}

describe('GET /api/me/export', () => {
  it('requires authentication', async () => {
    expect((await SELF.fetch(`${base}/api/me/export`, { headers: hdr() })).status).toBe(401);
    expect((await SELF.fetch(`${base}/api/me/export`, { headers: hdr(auth('invalid.invalid.invalid')) })).status).toBe(401);
  });

  it("returns the caller's data only, with no credentials", async () => {
    const a = await register('export_a');
    const b = await register('export_b');
    await seedUserData(a, b.id);
    const res = await SELF.fetch(`${base}/api/me/export`, { headers: hdr(auth(a.token)) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const text = await res.text();
    const data = JSON.parse(text);
    expect(data.profile).toMatchObject({ id: a.id, username: 'export_a', email: a.email });
    expect(data.problems.map((p) => p.title)).toEqual(['Kept problem']);
    expect(data.solutions).toHaveLength(1);
    expect(data.bookmarks).toHaveLength(1);
    expect(data.following).toHaveLength(1);
    expect(data.followers).toHaveLength(1);
    expect(data.analytics_events.map((e) => e.ip_address)).toContain('198.51.100.9');
    expect(data.truncated_sections).toEqual([]);
    expect(text).not.toContain('password_hash');
    expect(text).not.toContain('export_b@example.test');
  });
});

describe('DELETE /api/me', () => {
  const del = (token, body) => SELF.fetch(`${base}/api/me`, { method: 'DELETE', headers: hdr(auth(token)), body: JSON.stringify(body) });

  it('requires authentication, the password and an explicit confirmation', async () => {
    const u = await register('del_guard');
    expect((await SELF.fetch(`${base}/api/me`, { method: 'DELETE', headers: hdr(), body: '{}' })).status).toBe(401);
    expect((await del(u.token, { password: u.password })).status).toBe(400);
    expect((await del(u.token, { password: u.password, confirm: 'delete' })).status).toBe(400);
    expect((await del(u.token, { password: 'wrong-password-123', confirm: 'DELETE' })).status).toBe(403);
    const row = await env.AIHANGOUT_DB.prepare('SELECT username, deleted_at FROM users WHERE id = ?').bind(u.id).first();
    expect(row).toEqual({ username: 'del_guard', deleted_at: null });
  });

  it('refuses to delete an admin account', async () => {
    const u = await register('del_admin');
    await env.AIHANGOUT_DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(u.id).run();
    expect((await del(u.token, { password: u.password, confirm: 'DELETE' })).status).toBe(403);
    expect((await env.AIHANGOUT_DB.prepare('SELECT deleted_at FROM users WHERE id = ?').bind(u.id).first()).deleted_at).toBeNull();
  });

  it('anonymises the account, removes personal rows, keeps content and other users intact, and kills the session', async () => {
    const u = await register('del_target');
    const other = await register('del_other');
    const problemId = await seedUserData(u, other.id);
    const db = env.AIHANGOUT_DB;

    const res = await del(u.token, { password: u.password, confirm: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()).anonymised_as).toBe(`deleted-user-${u.id}`);

    const row = await db.prepare('SELECT username, email, password_hash, is_admin, email_verified_at, deleted_at FROM users WHERE id = ?').bind(u.id).first();
    expect(row.username).toBe(`deleted-user-${u.id}`);
    expect(row.email).toBe(`deleted-${u.id}@deleted.invalid`);
    expect(row.password_hash).toBe('!deleted');
    expect(row.deleted_at).not.toBeNull();

    const n = async (sql) => (await db.prepare(sql).bind(u.id).first()).n;
    expect(await n('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ?')).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM votes WHERE user_id = ?')).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM analytics_events WHERE user_id = ?')).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM followers WHERE follower_id = ? OR following_id = ?'.replace('OR following_id = ?', ''))).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM followers WHERE following_id = ?')).toBe(0);

    // content stays, attributed to the anonymised row
    expect(await n('SELECT COUNT(*) AS n FROM problems WHERE user_id = ?')).toBe(1);
    expect(await n('SELECT COUNT(*) AS n FROM solutions WHERE user_id = ?')).toBe(1);
    // another user's own rows are untouched
    expect((await db.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ?').bind(other.id).first()).n).toBe(1);
    expect((await db.prepare('SELECT username FROM users WHERE id = ?').bind(other.id).first()).username).toBe('del_other');

    // the old token and the old credentials no longer work
    expect((await SELF.fetch(`${base}/api/auth/me`, { headers: hdr(auth(u.token)) })).status).toBe(401);
    expect((await SELF.fetch(`${base}/api/me/export`, { headers: hdr(auth(u.token)) })).status).toBe(401);
    const login = await SELF.fetch(`${base}/api/auth/login`, { method: 'POST', headers: hdr(), body: JSON.stringify({ email: u.email, password: u.password }) });
    expect(login.status).toBe(401);
    // the freed username can be registered again
    await register('del_target');
    expect(problemId).toBeGreaterThan(0);
  });
});

describe('consent decision store (frontend/src/consent/consent.ts)', () => {
  const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

  it('is off by default and only an explicit current yes enables analytics', () => {
    const s = mem();
    expect(analyticsAllowed(s, {})).toBe(false);
    expect(needsBanner(s, {})).toBe(true);
    writeConsent(s, false);
    expect(analyticsAllowed(s, {})).toBe(false);
    expect(needsBanner(s, {})).toBe(false);
    writeConsent(s, true);
    expect(analyticsAllowed(s, {})).toBe(true);
  });

  it('Do Not Track and Global Privacy Control override a stored yes and suppress the banner', () => {
    const s = mem();
    writeConsent(s, true);
    expect(analyticsAllowed(s, { doNotTrack: '1' })).toBe(false);
    expect(analyticsAllowed(s, { globalPrivacyControl: true })).toBe(false);
    expect(hasOptOutSignal({ doNotTrack: '0' })).toBe(false);
    expect(needsBanner(mem(), { globalPrivacyControl: true })).toBe(false);
  });

  it('ignores corrupt, malformed or older-policy decisions and asks again', () => {
    const s = mem();
    s.setItem(CONSENT_KEY, '{not json');
    expect(readConsent(s)).toBeNull();
    s.setItem(CONSENT_KEY, JSON.stringify({ analytics: 'true', policyVersion: POLICY_VERSION, decidedAt: 'x' }));
    expect(readConsent(s)).toBeNull();
    s.setItem(CONSENT_KEY, JSON.stringify({ analytics: true, policyVersion: '1999-01-01', decidedAt: 'x' }));
    expect(analyticsAllowed(s, {})).toBe(false);
    expect(needsBanner(s, {})).toBe(true);
  });

  it('survives blocked storage', () => {
    const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    expect(analyticsAllowed(broken, {})).toBe(false);
    expect(() => writeConsent(broken, true)).not.toThrow();
  });
});
