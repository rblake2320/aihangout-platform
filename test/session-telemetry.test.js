import { SELF, env } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { EVENT_TYPES } from '../frontend/src/telemetry/types.ts';

// POST /api/analytics/batch and the telemetry fields of /api/admin/ops-summary.
// Real routes, real D1 with the real migrations (same pattern as ops-observability.test.js).
const ip = '203.0.113.90';
const sid = (n) => n.toString(16).padStart(32, '0');
const batch = (body, token, extraHeaders = {}) => SELF.fetch('https://aihangout.ai/api/analytics/batch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});
const ev = (type, data = {}, route = '/problems') => ({ type, ts: Date.now(), route, data });
const rows = async (session) => (await env.AIHANGOUT_DB.prepare(
  `SELECT event_type, user_id, user_type, session_id, page_url, ip_address, event_data FROM analytics_events WHERE session_id = ? ORDER BY id`
).bind(session).all()).results;

async function registerAdmin(name) {
  const res = await SELF.fetch('https://aihangout.ai/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.91' },
    body: JSON.stringify({ username: name, email: `${name}@example.test`, password: 'test-only-strong-password-123', ai_agent_type: 'human', accept_tos: true })
  });
  expect(res.status).toBe(200);
  const { token, user } = await res.json();
  await env.AIHANGOUT_DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(user.id).run();
  return { token, user };
}

it('accepts every event type the client can emit and stores them as tel_* rows', async () => {
  const s = sid(1);
  const res = await batch({ session_id: s, events: EVENT_TYPES.map(t => ev(t)) });
  expect(res.status).toBe(200);
  const out = await res.json();
  expect(out).toMatchObject({ success: true, accepted: EVENT_TYPES.length, rejected: 0 });
  const stored = await rows(s);
  expect(stored.map(r => r.event_type).sort()).toEqual(EVENT_TYPES.map(t => `tel_${t}`).sort());
  for (const r of stored) {
    expect(r.user_id).toBeNull();
    expect(r.user_type).toBe('anonymous');
    expect(r.ip_address).toBeNull(); // telemetry does not persist IPs
  }
});

it('rejects malformed, oversized and over-cap batches without writing anything', async () => {
  const s = sid(2);
  expect((await batch('{not json')).status).toBe(400);
  expect((await batch({ session_id: 'nope', events: [ev('page_view')] })).status).toBe(400);
  expect((await batch({ session_id: s, events: [] })).status).toBe(400);
  expect((await batch({ session_id: s, events: 'x' })).status).toBe(400);
  expect((await batch({ session_id: s, events: Array.from({ length: 51 }, () => ev('page_view')) })).status).toBe(400);
  const big = await batch({ session_id: s, events: [ev('client_error', { message: 'x'.repeat(70_000) })] });
  expect(big.status).toBe(413);
  expect(await rows(s)).toHaveLength(0);
});

it('drops unknown event types and counts them as rejected', async () => {
  const s = sid(3);
  const res = await batch({ session_id: s, events: [
    ev('page_view'), ev('keystroke', { key: 'a' }), { type: '__proto__', data: {} }, null, 'str', ev('constructor')
  ] });
  expect(await res.json()).toMatchObject({ accepted: 1, rejected: 5 });
  expect((await rows(s)).map(r => r.event_type)).toEqual(['tel_page_view']);
});

it('never lets a raw input value reach D1: unknown keys are dropped and free text is scrubbed', async () => {
  const s = sid(4);
  const secret = 'hunter2-super-secret-password';
  const email = 'victim.person@example.test';
  const tokenLike = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
  const res = await batch({ session_id: s, events: [
    ev('form_abandon', { form: 'form#login', fields_touched: 2, fields_total: 3, last_field: 'password', ms_in_form: 4000, value: secret, input_value: secret }),
    { ...ev('rage_click', { selector: 'button#go', count: 6, window_ms: 2000, navigated: false }), value: secret, innerText: secret },
    ev('client_error', { source: 'error', message: `Cannot read ${email} with ${tokenLike}`, stack: `at x (https://aihangout.ai/a.js:1:2)`, filename: '/a.js', fingerprint: 'deadbeef', nested: { value: secret } }),
    ev('page_view', { resumed: false, viewport_w: 1200, viewport_h: 800, referrer_host: 'example.test', formData: { password: secret } })
  ] });
  expect((await res.json()).accepted).toBe(4);
  const all = await rows(s);
  const blob = JSON.stringify(all);
  expect(blob).not.toContain(secret);
  expect(blob).not.toContain(email);
  expect(blob).not.toContain(tokenLike);
  expect(blob).toContain('<email>');
  expect(blob).toContain('<token>');
  for (const r of all) {
    const keys = Object.keys(JSON.parse(r.event_data));
    expect(keys).not.toEqual(expect.arrayContaining(['value']));
    expect(keys.some(k => ['input_value', 'innerText', 'nested', 'formData'].includes(k))).toBe(false);
  }
});

it('clamps numbers, strips query/hash from routes, and ignores wrongly typed fields', async () => {
  const s = sid(5);
  await batch({ session_id: s, events: [{
    type: 'page_leave', ts: 1, route: '/problems/42?token=abc#frag',
    data: { duration_ms: 9e15, active_ms: -5, idle_ms: 'lots', scroll_max_pct: 250 }
  }] });
  const [row] = await rows(s);
  expect(row.page_url).toBe('/problems/42');
  const d = JSON.parse(row.event_data);
  expect(d.duration_ms).toBe(86400000);
  expect(d.active_ms).toBe(0);
  expect(d.idle_ms).toBeUndefined();
  expect(d.scroll_max_pct).toBe(100);
  expect(d.client_ts).toBeUndefined(); // ts far outside +-24h is ignored
});

it('attributes batches to the bearer token, and beacon batches to the same session', async () => {
  const { token, user } = await registerAdmin('tel_attr');
  const s = sid(6);
  expect((await batch({ session_id: s, events: [ev('page_view')] }, token)).status).toBe(200);
  expect((await batch({ session_id: s, events: [ev('page_leave', { duration_ms: 1000 })] })).status).toBe(200); // beacon: no header
  const other = sid(7);
  expect((await batch({ session_id: other, events: [ev('page_view')] })).status).toBe(200);
  const mine = await rows(s);
  expect(mine.map(r => r.user_id)).toEqual([user.id, user.id]);
  expect((await rows(other))[0].user_id).toBeNull();
  // An invalid bearer is treated as anonymous, not as an error.
  expect((await batch({ session_id: sid(8), events: [ev('page_view')] }, 'garbage')).status).toBe(200);
});

it('rate limits a single IP', async () => {
  const flood = '203.0.113.200';
  let last = 0;
  for (let i = 0; i < 32; i++) last = (await batch({ session_id: sid(9), events: [ev('page_view')] }, null, { 'CF-Connecting-IP': flood })).status;
  expect(last).toBe(429);
});

it('exposes duration buckets, median active time, frustration, errors and scroll depth to admins only', async () => {
  const { token } = await registerAdmin('tel_summary');
  // D1 is shared by the tests in this file; exact counts below need a clean telemetry slate.
  await env.AIHANGOUT_DB.prepare(`DELETE FROM analytics_events WHERE event_type LIKE 'tel\\_%' ESCAPE '\\'`).run();
  const leave = (d, a, p, route = '/home') => ev('page_leave', { duration_ms: d, active_ms: a, idle_ms: d - a, scroll_max_pct: p }, route);
  await batch({ session_id: sid(20), events: [leave(5_000, 3_000, 20), leave(1_000, 1_000, 10)] });          // 6s total   -> <10s
  await batch({ session_id: sid(21), events: [leave(120_000, 60_000, 80, '/problems')] });                    // 2m         -> 1-5m
  await batch({ session_id: sid(22), events: [leave(2_400_000, 900_000, 100, '/problems')] });                // 40m        -> 30m+
  await batch({ session_id: sid(23), events: [
    ev('rage_click', { selector: 'button#go', count: 5, window_ms: 2000, navigated: false }, '/problems'),
    ev('rage_click', { selector: 'button#go', count: 6, window_ms: 2000, navigated: false }, '/problems'),
    ev('dead_click', { selector: 'div.card', wait_ms: 1000 }, '/problems'),
    ev('dead_click', { selector: 'a.nav', wait_ms: 1000 }, '/home'),
    ev('client_error', { source: 'error', message: 'boom', fingerprint: 'f1' }, '/problems'),
    ev('client_error', { source: 'error', message: 'boom', fingerprint: 'f1' }, '/problems'),
    ev('client_error', { source: 'unhandledrejection', message: 'other', fingerprint: 'f2' }, '/home')
  ] });

  const get = t => SELF.fetch('https://aihangout.ai/api/admin/ops-summary?hours=1', { headers: { Authorization: `Bearer ${t}` } });
  expect((await SELF.fetch('https://aihangout.ai/api/admin/ops-summary?hours=1')).status).toBe(403);
  const summary = await (await get(token)).json();
  const t = summary.telemetry;
  expect(t.sessions).toBe(3);
  expect(Object.fromEntries(t.sessions_by_duration.map(b => [b.label, b.sessions]))).toEqual({ '<10s': 1, '10-60s': 0, '1-5m': 1, '5-30m': 0, '30m+': 1 });
  expect(t.median_active_ms).toBe(60_000); // sessions' active: 4s, 60s, 900s
  const problems = t.frustration_by_page.find(r => r.page === '/problems');
  expect(problems).toMatchObject({ rage_clicks: 2, dead_clicks: 1 });
  expect(t.frustration_by_page.find(r => r.page === '/home')).toMatchObject({ rage_clicks: 0, dead_clicks: 1 });
  expect(t.top_client_errors[0]).toMatchObject({ fingerprint: 'f1', message: 'boom', count: 2, sessions: 1 });
  expect(t.scroll_depth_by_page.find(r => r.page === '/problems')).toMatchObject({ views: 2, avg_max_scroll_pct: 90 });
  expect(t.scroll_depth_by_page.find(r => r.page === '/home')).toMatchObject({ views: 2, avg_max_scroll_pct: 15 });
  expect(t.events).toBeGreaterThanOrEqual(11);
  // Existing summary fields are untouched.
  expect(summary.failures).toBeDefined();
  expect(summary.logins).toBeDefined();
});

it('the daily cron prunes telemetry older than 30 days and leaves every other event alone', async () => {
  const { createScheduledController, createExecutionContext, waitOnExecutionContext } = await import('cloudflare:test');
  const worker = (await import('../src/worker.js')).default;
  const db = env.AIHANGOUT_DB;
  const ins = (type, age) => db.prepare(`INSERT INTO analytics_events (event_type, session_id, timestamp) VALUES (?, 'prune-test', datetime('now', ?))`).bind(type, age).run();
  await ins('tel_page_view', '-31 days');
  await ins('tel_rage_click', '-40 days');
  await ins('tel_page_view', '-29 days');
  await ins('user_login', '-400 days'); // not telemetry: must survive however old
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '0 6 * * *' }), env, ctx);
  await waitOnExecutionContext(ctx);
  const left = (await db.prepare(`SELECT event_type FROM analytics_events WHERE session_id = 'prune-test' ORDER BY id`).all()).results.map(r => r.event_type);
  expect(left).toEqual(['tel_page_view', 'user_login']);
});
