import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { enrollmentProof } from './mobile-proof-helper.js';
import { RESERVE_CALL_SLOT_SQL } from '../src/mobile-assistance.js';

// Real handlers in workerd against a real D1. The OpenAI Responses API is
// replaced by the in-process stub selected in vitest.config.mjs
// (OPENAI_BASE_URL=stub://, honoured only with MOBILE_FAULT_INJECT_ENABLED=1).
// No key, no network, no paid call.

let seq = 0;
async function api(path, { method = 'GET', body, token, rawBody } = {}) {
  const headers = { 'CF-Connecting-IP': `198.51.100.${(++seq % 250) + 1}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || rawBody !== undefined) headers['Content-Type'] = 'application/json';
  const r = await SELF.fetch('https://example.test' + path, { method, headers, body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
async function user() {
  const name = `a5assist_${++seq}_${Date.now().toString(36)}`;
  const r = await api('/api/auth/register', { method: 'POST', body: { username: name, email: name + '@example.invalid', password: 'Synthetic assistance password only!', aiAgentType: 'human' } });
  expect(r.status).toBe(200);
  return { id: r.json.user.id, token: r.json.token };
}
async function device(u) {
  const p = await enrollmentProof(api, u, `assist_${++seq}`);
  const r = await api('/api/mobile/devices/enroll', { method: 'POST', token: u.token, body: p.body });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.deviceId;
}
const diag = { schemaVersion: 1, diagnosticsEnabled: false, appVersion: '0.1.0' };
const ask = (u, deviceId, requestId, extra = {}) => api('/api/mobile/assistance', { method: 'POST', token: u.token, body: { deviceId, requestId, diagnostics: diag, ...extra } });
const row = (u, requestId) => env.AIHANGOUT_DB.prepare('SELECT status, provider_called_at, proposal_json, usage_json, error FROM mobile_assistance_requests WHERE owner_user_id = ? AND request_id = ?').bind(u.id, requestId).first();

describe('POST /api/mobile/assistance (frontier phone wiring, backend lane)', () => {
  it('happy path: owner + active device -> diagnosis + the single literal proposal; row persisted with usage', async () => {
    const u = await user(); const d = await device(u);
    const r = await ask(u, d, 'req-happy-0001');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ success: true, requestId: 'req-happy-0001', provider: 'openai',
      proposal: { operation: 'enable_companion_diagnostics', capability: 'ui_click', targetDescription: 'Enable AIHangout companion diagnostics' } });
    expect(Object.keys(r.json.proposal).sort()).toEqual(['capability', 'operation', 'targetDescription']);
    const s = await row(u, 'req-happy-0001');
    expect(s.status).toBe('completed'); expect(s.provider_called_at).not.toBeNull(); expect(JSON.parse(s.usage_json).total_tokens).toBe(20);
  });

  it('no_action answer is returned explicitly with proposal null', async () => {
    const u = await user(); const d = await device(u);
    const r = await ask(u, d, 'stub-noaction-0001');
    expect(r.status).toBe(200); expect(r.json.proposal).toBeNull(); expect(r.json.noAction).toBe(true); expect(typeof r.json.diagnosis).toBe('string');
  });

  it('model output outside the two allowed decisions is rejected -- never compiled into a proposal', async () => {
    const u = await user(); const d = await device(u);
    const r = await ask(u, d, 'stub-badjson-0001');
    expect(r.status, JSON.stringify(r.json)).toBe(424); expect((await row(u, 'stub-badjson-0001')).status).toBe('failed');
  });

  it('dedup: same requestId returns the stored completed outcome without a second provider call', async () => {
    const u = await user(); const d = await device(u);
    const first = await ask(u, d, 'req-dedup-0001'); expect(first.status).toBe(200);
    const called = (await row(u, 'req-dedup-0001')).provider_called_at;
    const again = await ask(u, d, 'req-dedup-0001');
    expect(again.status).toBe(200); expect(again.json.deduplicated).toBe(true); expect(again.json.proposal).toEqual(first.json.proposal);
    expect((await row(u, 'req-dedup-0001')).provider_called_at).toBe(called);
    const readback = await api('/api/mobile/assistance/req-dedup-0001', { token: u.token });
    expect(readback.status).toBe(200); expect(readback.json.status).toBe('completed');
  });

  it('unknown provider outcome (timeout) is recorded as unknown and NOT retried on resubmit', async () => {
    const u = await user(); const d = await device(u);
    const r = await ask(u, d, 'stub-timeout-0001');
    expect(r.status).toBe(424); expect(r.json.status).toBe('unknown');
    const s1 = await row(u, 'stub-timeout-0001'); expect(s1.status).toBe('unknown'); expect(s1.usage_json).toBeNull(); // unknown cost, not zero
    const again = await ask(u, d, 'stub-timeout-0001');
    expect(again.status).toBe(409); expect(again.json.status).toBe('unknown');
    expect((await row(u, 'stub-timeout-0001')).provider_called_at).toBe(s1.provider_called_at);
  });

  it('provider HTTP error -> failed; another account cannot read or reuse the request', async () => {
    const u = await user(); const stranger = await user(); const d = await device(u);
    const r = await ask(u, d, 'stub-http500-0001'); expect(r.status).toBe(424); expect(r.json.status).toBe('failed');
    expect((await api('/api/mobile/assistance/stub-http500-0001', { token: stranger.token })).status).toBe(404);
    expect((await ask(stranger, d, 'stub-http500-0002')).status).toBe(404); // not their device
  });

  it('rejects extra keys, oversize, wrong diagnostics shape, and a device the caller does not own', async () => {
    const u = await user(); const d = await device(u);
    expect((await ask(u, d, 'req-shape-0001', { command: 'rm -rf' })).status).toBe(400);
    expect((await api('/api/mobile/assistance', { method: 'POST', token: u.token, body: { deviceId: d, requestId: 'req-shape-0002', diagnostics: { ...diag, extra: 1 } } })).status).toBe(400);
    expect((await api('/api/mobile/assistance', { method: 'POST', token: u.token, body: { deviceId: d, requestId: 'req-shape-0003', diagnostics: { ...diag, diagnosticsEnabled: true } } })).status).toBe(400);
    expect((await api('/api/mobile/assistance', { method: 'POST', token: u.token, rawBody: JSON.stringify({ deviceId: d, requestId: 'req-shape-0004', diagnostics: { ...diag, appVersion: 'x'.repeat(3000) } }) })).status).toBe(413);
    expect((await api('/api/mobile/assistance', { method: 'POST', body: { deviceId: d, requestId: 'req-shape-0005', diagnostics: diag } })).status).toBe(401);
    const n = await env.AIHANGOUT_DB.prepare("SELECT COUNT(*) AS n FROM mobile_assistance_requests WHERE request_id LIKE 'req-shape-%'").first();
    expect(n.n).toBe(0); // nothing persisted, nothing called
  });

  it('finite call cap: once the durable count reaches MOBILE_ASSISTANCE_MAX_CALLS, no provider call is made', async () => {
    const u = await user(); const d = await device(u);
    const ok = await ask(u, d, 'req-cap-fill-01'); expect(ok.status).toBe(200);
    const used = (await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM mobile_assistance_requests WHERE provider_called_at IS NOT NULL').first()).n;
    const saved = env.MOBILE_ASSISTANCE_MAX_CALLS; env.MOBILE_ASSISTANCE_MAX_CALLS = String(used); // cap now exactly reached
    try {
      const blocked = await ask(u, d, 'req-cap-blocked-01');
      expect(blocked.status, JSON.stringify(blocked.json)).toBe(429);
      const s = await row(u, 'req-cap-blocked-01'); expect(s.status).toBe('failed'); expect(s.provider_called_at).toBeNull();
      expect((await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM mobile_assistance_requests WHERE provider_called_at IS NOT NULL').first()).n).toBe(used);
    } finally { env.MOBILE_ASSISTANCE_MAX_CALLS = saved; }
  });

  it('concurrent cap boundary: distinct requests racing with ONE slot left reserve exactly one provider call', async () => {
    const u = await user(); const d = await device(u);
    const count = async () => (await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM mobile_assistance_requests WHERE provider_called_at IS NOT NULL').first()).n;
    const used = await count();
    const saved = env.MOBILE_ASSISTANCE_MAX_CALLS; env.MOBILE_ASSISTANCE_MAX_CALLS = String(used + 1); // exactly one slot left
    try {
      const rs = await Promise.all([1, 2, 3, 4].map(i => ask(u, d, `req-race-${i}`)));
      expect(rs.map(r => r.status).sort(), JSON.stringify(rs.map(r => r.json))).toEqual([200, 429, 429, 429]);
      expect(await count()).toBe(used + 1); // the durable count moved by exactly one
      const blocked = (await env.AIHANGOUT_DB.prepare("SELECT COUNT(*) AS n FROM mobile_assistance_requests WHERE request_id LIKE 'req-race-%' AND status = 'failed' AND provider_called_at IS NULL").first()).n;
      expect(blocked).toBe(3);
    } finally { env.MOBILE_ASSISTANCE_MAX_CALLS = saved; }
  });

  it('race proof at the SQL level: interleaved count-then-update over-admits; the single-statement reservation the route runs admits exactly one', async () => {
    // Real D1, real table. Three pending rows, one slot left. The vitest pool does
    // not interleave concurrent route requests at the DB step (the route-level
    // race test above passes against the old two-step code too), so the race is
    // reproduced here explicitly: every request reads the count BEFORE any of
    // them writes -- the exact interleaving A1 described.
    const u = await user(); const d = await device(u);
    const db = env.AIHANGOUT_DB;
    const count = async () => (await db.prepare('SELECT COUNT(*) AS n FROM mobile_assistance_requests WHERE provider_called_at IS NOT NULL').first()).n;
    const seed = async (ids) => { for (const id of ids) await db.prepare("INSERT INTO mobile_assistance_requests (request_id, owner_user_id, device_id, status, diagnostics_json, provider, model) VALUES (?, ?, ?, 'pending', '{}', 'openai', 'stub-model')").bind(id, u.id, d).run(); };

    // Old algorithm (b22e906): SELECT COUNT per request, then UPDATE per request.
    const oldIds = ['sql-race-old-1', 'sql-race-old-2', 'sql-race-old-3']; await seed(oldIds);
    const base = await count(); const cap = base + 1;
    const reads = []; for (const _ of oldIds) reads.push((await db.prepare('SELECT COUNT(*) AS n FROM mobile_assistance_requests WHERE provider_called_at IS NOT NULL').first()).n);
    let oldAdmitted = 0;
    for (let i = 0; i < oldIds.length; i++) if (reads[i] < cap) { await db.prepare('UPDATE mobile_assistance_requests SET provider_called_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND request_id = ?').bind(u.id, oldIds[i]).run(); oldAdmitted++; }
    expect(oldAdmitted).toBe(3); // over-admits: 3 provider calls against a cap with 1 slot
    expect(await count()).toBe(base + 3);
    // undo so the durable cap for the rest of the suite is unaffected
    await db.prepare("UPDATE mobile_assistance_requests SET provider_called_at = NULL WHERE request_id LIKE 'sql-race-old-%'").run();
    expect(await count()).toBe(base);

    // New statement (the one the route runs), same three-way race shape.
    const newIds = ['sql-race-new-1', 'sql-race-new-2', 'sql-race-new-3']; await seed(newIds);
    const results = await Promise.all(newIds.map(id => db.prepare(RESERVE_CALL_SLOT_SQL).bind(u.id, id, cap).run()));
    expect(results.map(r => r.meta.changes).sort()).toEqual([0, 0, 1]);
    expect(await count()).toBe(base + 1);
    // Idempotent for an already-reserved row: cannot double-reserve the winner.
    const winner = newIds[results.findIndex(r => r.meta.changes === 1)];
    expect((await db.prepare(RESERVE_CALL_SLOT_SQL).bind(u.id, winner, cap + 10).run()).meta.changes).toBe(0);
  });

  it('hostile provider shapes are contained as retained failed outcomes (424), never a generic 500/503', async () => {
    const u = await user(); const d = await device(u);
    for (const id of ['stub-hostile-output-01', 'stub-hostile-content-01', 'stub-hostile-root-01', 'stub-hostile-huge-01', 'stub-hostile-array-01']) {
      const r = await ask(u, d, id);
      expect(r.status, `${id}: ${JSON.stringify(r.json)}`).toBe(424);
      expect(r.json).toMatchObject({ requestId: id, status: 'failed' });
      const s = await row(u, id);
      expect(s.status).toBe('failed'); expect(s.error).toBe('provider output rejected by schema');
      expect(s.proposal_json).toBeNull(); expect(s.provider_called_at).not.toBeNull();
    }
  });

  it('resubmit guidance: unknown/pending carry no "new requestId" hint; failed does', async () => {
    const u = await user(); const d = await device(u);
    await ask(u, d, 'stub-timeout-guid01');
    const unk = await ask(u, d, 'stub-timeout-guid01');
    expect(unk.status).toBe(409); expect(unk.json.status).toBe('unknown');
    expect(unk.json.error).not.toMatch(/new requestId/i); expect(unk.json.error).toMatch(/do not replay/);
    await ask(u, d, 'stub-http500-guid01');
    const fl = await ask(u, d, 'stub-http500-guid01');
    expect(fl.status).toBe(409); expect(fl.json.status).toBe('failed'); expect(fl.json.error).toMatch(/new requestId/);
  });

  it('setup gates are structured non-5xx refusals (424 disabled / not_configured) that survive the outer handler; nothing persisted or called', async () => {
    const u = await user(); const d = await device(u);
    const savedEnabled = env.MOBILE_ASSISTANCE_ENABLED; env.MOBILE_ASSISTANCE_ENABLED = '0';
    try {
      const r = await ask(u, d, 'req-gate-0001');
      expect(r.status, JSON.stringify(r.json)).toBe(424);
      expect(r.json).toEqual({ success: false, error: 'Mobile assistance is disabled on this deployment', requestId: 'req-gate-0001', status: 'disabled' });
      expect(await row(u, 'req-gate-0001')).toBeNull();
    } finally { env.MOBILE_ASSISTANCE_ENABLED = savedEnabled; }
    // Enabled but no key/model (the exact state the first installed phone will hit
    // while owner key/budget consent is pending). Base URL made non-stub so the
    // real config path runs; the refusal happens before any network is touched.
    const savedBase = env.OPENAI_BASE_URL; env.OPENAI_BASE_URL = 'https://provider.invalid';
    try {
      const r = await ask(u, d, 'req-gate-0002');
      expect(r.status, JSON.stringify(r.json)).toBe(424);
      expect(r.json).toMatchObject({ success: false, requestId: 'req-gate-0002', status: 'not_configured' });
      expect(await row(u, 'req-gate-0002')).toBeNull();
    } finally { env.OPENAI_BASE_URL = savedBase; }
  });
});
