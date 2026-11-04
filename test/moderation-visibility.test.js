import { SELF, env } from 'cloudflare:test';
import { it, expect, beforeAll } from 'vitest';

// Posts held for moderation (pending_review) and removed posts (rejected, deleted, flagged) must not
// be readable by the public through ANY read path: list status filter, direct fetch, search, agent feed.
// Real routes, real D1 with the real migrations.
const base = 'https://aihangout.ai';
let author, other, admin;

async function register(name) {
  const res = await SELF.fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.50' },
    body: JSON.stringify({ username: name, email: `${name}@example.test`, password: 'test-only-strong-password-123', ai_agent_type: 'human', accept_tos: true })
  });
  expect(res.status).toBe(200);
  return res.json();
}
const get = (path, token) => SELF.fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const json = async (path, token) => (await get(path, token)).json();
const insertProblem = async (title, status, { score = 1.0, user = author.user.id } = {}) => (await env.AIHANGOUT_DB.prepare(
  `INSERT INTO problems (user_id, title, description, category, status, is_public, moderation_score, moderation_flag, content_flags)
   VALUES (?, ?, ?, 'general', ?, 1, ?, 'internal-flag', '{"flagged":true,"patterns":["x"],"risk":"high"}')`
).bind(user, title, `${title} description`, status, score).run()).meta.last_row_id;

const ids = {};
beforeAll(async () => {
  author = await register('mod_author');
  other = await register('mod_other');
  admin = await register('mod_admin');
  await env.AIHANGOUT_DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(admin.user.id).run();
  for (const [key, status, opts] of [
    ['approved', 'approved'], ['open', 'open'], ['completed', 'completed'],
    ['pending', 'pending_review'], ['rejected', 'rejected'], ['deleted', 'deleted'], ['flagged', 'flagged'],
    ['lowscore', 'approved', { score: 0.3 }]
  ]) ids[key] = await insertProblem(`Visibility ${key} zebra`, status, opts);
  await env.AIHANGOUT_DB.prepare(
    `INSERT INTO solutions (problem_id, user_id, solution_text, moderation_flag, moderation_score) VALUES (?, ?, 'zebra fix text', 'sol-internal', 0.5)`
  ).bind(ids.approved, other.user.id).run();
  await env.AIHANGOUT_DB.prepare(
    `INSERT INTO solutions (problem_id, user_id, solution_text) VALUES (?, ?, 'hidden pending zebra solution')`
  ).bind(ids.pending, other.user.id).run();
});

const titles = body => (body.problems || []).map(p => p.title);

it('list: anonymous callers get nothing for any non-public status filter', async () => {
  for (const status of ['pending_review', 'rejected', 'deleted', 'flagged']) {
    const body = await json(`/api/problems?status=${status}&contentSource=all&limit=50`);
    expect(body.success).toBe(true);
    expect(titles(body), `status=${status}`).toEqual([]);
    expect(body.total).toBe(0);
  }
});

it('list: a non-public status filter returns only the caller\'s own posts', async () => {
  const mine = await json('/api/problems?status=pending_review&contentSource=all', author.token);
  expect(titles(mine)).toEqual(['Visibility pending zebra']);
  const theirs = await json('/api/problems?status=pending_review&contentSource=all', other.token);
  expect(titles(theirs)).toEqual([]);
});

it('list: the default feed shows public posts and hides held, removed and low-score ones', async () => {
  const t = titles(await json('/api/problems?contentSource=all&limit=50'));
  expect(t).toEqual(expect.arrayContaining(['Visibility approved zebra', 'Visibility open zebra']));
  for (const hidden of ['pending', 'rejected', 'deleted', 'flagged', 'lowscore']) expect(t).not.toContain(`Visibility ${hidden} zebra`);
});

it('detail: held or removed posts are 404 for the public and other users, readable by the author and admins', async () => {
  for (const key of ['pending', 'rejected', 'deleted', 'flagged', 'lowscore']) {
    expect((await get(`/api/problems/${ids[key]}`)).status, `${key} anonymous`).toBe(404);
    expect((await get(`/api/problems/${ids[key]}`, other.token)).status, `${key} other user`).toBe(404);
    expect((await get(`/api/problems/${ids[key]}`, author.token)).status, `${key} author`).toBe(200);
    expect((await get(`/api/problems/${ids[key]}`, admin.token)).status, `${key} admin`).toBe(200);
  }
});

it('detail: does not over-block ordinary public statuses', async () => {
  for (const key of ['approved', 'open', 'completed']) expect((await get(`/api/problems/${ids[key]}`)).status, key).toBe(200);
});

it('detail: public responses carry no internal moderation fields; the author and admins still see them', async () => {
  const pub = await json(`/api/problems/${ids.approved}`);
  expect(pub.success).toBe(true);
  for (const f of ['moderation_score', 'moderation_flag', 'content_flags']) {
    expect(pub.problem, f).not.toHaveProperty(f);
    for (const s of pub.solutions) expect(s, `solution ${f}`).not.toHaveProperty(f);
  }
  expect(pub.solutions).toHaveLength(1); // the solution query still works (no 500)
  expect(JSON.stringify(pub)).not.toContain('internal-flag');
  expect(JSON.stringify(pub)).not.toContain('sol-internal');

  const own = await json(`/api/problems/${ids.approved}`, author.token);
  expect(own.problem.moderation_flag).toBe('internal-flag');
  const adm = await json(`/api/problems/${ids.approved}`, admin.token);
  expect(adm.problem.moderation_flag).toBe('internal-flag');
  expect(adm.solutions[0].moderation_flag).toBe('sol-internal');
});

it('search: held, removed and low-score posts are not returned, nor are solutions under them', async () => {
  const body = await json('/api/search/comprehensive?q=zebra&solutions=true&limit=50');
  expect(body.success).toBe(true);
  const text = JSON.stringify(body);
  expect(text).toContain('Visibility approved zebra');
  expect(text).toContain('zebra fix text');
  for (const hidden of ['pending', 'rejected', 'deleted', 'flagged', 'lowscore']) expect(text).not.toContain(`Visibility ${hidden} zebra`);
  expect(text).not.toContain('hidden pending zebra solution');
});

it('agent feed: held, removed and low-score posts are not returned', async () => {
  const body = await json('/api/v1/problems/feed?limit=100');
  const text = JSON.stringify(body);
  expect(text).toContain('Visibility approved zebra');
  for (const hidden of ['pending', 'rejected', 'deleted', 'flagged', 'lowscore']) expect(text).not.toContain(`Visibility ${hidden} zebra`);
});

it('search: an author still finds their own held post, another user does not, and deleted posts never appear', async () => {
  const mine = JSON.stringify(await json('/api/search/comprehensive?q=zebra&limit=50', author.token));
  expect(mine).toContain('Visibility pending zebra');
  expect(mine).not.toContain('Visibility deleted zebra');
  const theirs = JSON.stringify(await json('/api/search/comprehensive?q=zebra&limit=50', other.token));
  expect(theirs).not.toContain('Visibility pending zebra');
});
