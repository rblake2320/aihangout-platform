import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

// A5 closure C0910: Problem Bank advanced filters were not enforced.
//
// GET /api/problem-bank falls back to the `problems` table whenever
// `major_problems` is empty (the common case -- initProblemBankTable creates it
// empty). That fallback (a) ignored the `impact` query param entirely while
// synthesizing impact_level from difficulty, and (b) selected only
// status = 'open', so problems that passed the first-post gate (stored as
// 'approved' by POST /api/problems) never reached the bank.
//
// Real src/worker.js inside workerd against a real D1 -- same no-mock discipline
// as test/trust-path.test.js. IP ranges: trust-path 203.0.113.x, manus-qa
// 198.51.100.x, a3 192.0.2.x -- this file uses 198.18.x (benchmark range) to
// avoid colliding with any of them under the shared singleWorker instance.

let clientSeq = 0;
function nextIp() {
  clientSeq += 1;
  return `198.18.0.${clientSeq % 250 + 1}`;
}

async function api(path, { method = 'GET', body, token, ip } = {}) {
  const headers = { 'CF-Connecting-IP': ip || nextIp() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await SELF.fetch(`https://aihangout.ai${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
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
    method: 'POST',
    ip,
    body: { username, email, password, ai_agent_type: 'human' }
  });
  expect(res.status, `register ${username} failed: ${JSON.stringify(res.json)}`).toBe(200);
  expect(res.json.success).toBe(true);
  return { username, email, password, ip, token: res.json.token, id: res.json.user.id };
}

async function createProblem(user, overrides = {}) {
  return api('/api/problems', {
    method: 'POST',
    token: user.token,
    ip: user.ip,
    body: {
      title: 'Worker returns 500 on concurrent D1 writes',
      description: 'Two simultaneous writes to the same row intermittently produce a 500.',
      category: 'Programming',
      ...overrides
    }
  });
}

// One fresh user per seeded problem: problem creation is rate limited per user
// (3/min) and per IP (5/min), and a fresh user also keeps the first-post gate
// behaviour identical for every seed.
async function seedProblem(prefix, difficulty) {
  unique += 1;
  const user = await registerUser(prefix);
  const title = `A5 bank ${difficulty} probe ${unique}`;
  const res = await createProblem(user, { title, difficulty });
  expect(res.status, `create ${title} failed: ${JSON.stringify(res.json)}`).toBe(200);
  expect(res.json.success).toBe(true);
  expect(res.json.problemId, `no problemId in ${JSON.stringify(res.json)}`).toBeTruthy();
  return { id: res.json.problemId, title, status: res.json.status };
}

async function bank(query = '') {
  return api(`/api/problem-bank?limit=50${query}`);
}

describe('GET /api/problem-bank fallback branch (major_problems empty)', () => {
  const seeded = {};

  beforeAll(async () => {
    const major = await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) as count FROM major_problems').first()
      .catch(() => ({ count: 0 })); // table may not exist until the route creates it
    expect(major.count, 'precondition: major_problems must be empty so the fallback branch runs').toBe(0);

    seeded.hard = await seedProblem('bankhard', 'hard');
    seeded.medium = await seedProblem('bankmed', 'medium');
    seeded.easy = await seedProblem('bankeasy', 'easy');

    // Legacy row shape: older problems carry status 'open'.
    seeded.legacyOpen = await seedProblem('banklegacy', 'hard');
    await env.AIHANGOUT_DB.prepare("UPDATE problems SET status = 'open' WHERE id = ?")
      .bind(seeded.legacyOpen.id).run();

    // Gate-held row: must never surface in the bank.
    seeded.pending = await seedProblem('bankpending', 'hard');
    await env.AIHANGOUT_DB.prepare("UPDATE problems SET status = 'pending_review' WHERE id = ?")
      .bind(seeded.pending.id).run();
  });

  it('seeds land as status approved (first-post gate under BETA_MODE=true)', () => {
    // This is what the old WHERE status = 'open' predicate silently excluded.
    expect(seeded.hard.status).toBe('approved');
    expect(seeded.medium.status).toBe('approved');
    expect(seeded.easy.status).toBe('approved');
  });

  it('unfiltered bank runs the fallback branch and includes approved + open rows, not pending_review', async () => {
    const res = await bank();
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.problems.length).toBeGreaterThan(0);
    // estimated_value_label is only emitted by the problems-table fallback mapping.
    for (const p of res.json.problems) {
      expect(p, `item ${p.id} lacks fallback-only field`).toHaveProperty('estimated_value_label');
    }
    const titles = res.json.problems.map(p => p.title);
    expect(titles, 'approved hard problem missing from bank').toContain(seeded.hard.title);
    expect(titles, 'approved medium problem missing from bank').toContain(seeded.medium.title);
    expect(titles, 'approved easy problem missing from bank').toContain(seeded.easy.title);
    expect(titles, 'legacy open problem missing from bank').toContain(seeded.legacyOpen.title);
    expect(titles, 'pending_review problem leaked into bank').not.toContain(seeded.pending.title);
  });

  it('impact=critical returns only difficulty=hard rows', async () => {
    const res = await bank('&impact=critical');
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    const titles = res.json.problems.map(p => p.title);
    expect(titles).toContain(seeded.hard.title);
    expect(titles).toContain(seeded.legacyOpen.title);
    expect(titles, 'medium-difficulty row leaked through impact=critical').not.toContain(seeded.medium.title);
    expect(titles, 'easy-difficulty row leaked through impact=critical').not.toContain(seeded.easy.title);
    expect(titles).not.toContain(seeded.pending.title);
    for (const p of res.json.problems) expect(p.impact_level, `item ${p.id}`).toBe('critical');
    expect(res.json.total).toBe(res.json.problems.length);
  });

  it('impact=high returns only difficulty=medium rows', async () => {
    const res = await bank('&impact=high');
    expect(res.status).toBe(200);
    const titles = res.json.problems.map(p => p.title);
    expect(titles).toContain(seeded.medium.title);
    expect(titles, 'hard-difficulty row leaked through impact=high').not.toContain(seeded.hard.title);
    expect(titles, 'easy-difficulty row leaked through impact=high').not.toContain(seeded.easy.title);
    for (const p of res.json.problems) expect(p.impact_level, `item ${p.id}`).toBe('high');
    expect(res.json.total).toBe(res.json.problems.length);
  });

  it('impact=medium returns only rows whose difficulty is neither hard nor medium', async () => {
    const res = await bank('&impact=medium');
    expect(res.status).toBe(200);
    const titles = res.json.problems.map(p => p.title);
    expect(titles).toContain(seeded.easy.title);
    expect(titles, 'hard-difficulty row leaked through impact=medium').not.toContain(seeded.hard.title);
    expect(titles, 'medium-difficulty row leaked through impact=medium').not.toContain(seeded.medium.title);
    for (const p of res.json.problems) expect(p.impact_level, `item ${p.id}`).toBe('medium');
    expect(res.json.total).toBe(res.json.problems.length);
  });

  it('impact combined with category is still enforced', async () => {
    const res = await bank('&impact=critical&category=Programming');
    expect(res.status).toBe(200);
    const titles = res.json.problems.map(p => p.title);
    expect(titles).toContain(seeded.hard.title);
    expect(titles).not.toContain(seeded.medium.title);
    for (const p of res.json.problems) {
      expect(p.impact_level).toBe('critical');
      expect(p.category).toBe('Programming');
    }
  });

  it('rejects an unknown impact value with 400', async () => {
    const res = await bank('&impact=bogus');
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ success: false, error: 'impact must be critical, high, or medium' });
  });

  it('impact=all is the same as no filter', async () => {
    const all = await bank('&impact=all');
    const none = await bank();
    expect(all.status).toBe(200);
    expect(all.json.total).toBe(none.json.total);
  });
});
