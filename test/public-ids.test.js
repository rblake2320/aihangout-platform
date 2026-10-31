import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { uuidv7, isPublicId, slugify, problemPath, backfillPublicIds, publicIdFor } from '../src/public-ids.js';

// AIH-R2: stable public ids. Real workerd, real D1 with migration 0023 applied by the
// test harness, real REST/SSR/MCP routes.
const BASE = 'https://aihangout.ai';
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let n = 0;
const ip = () => `192.0.2.${10 + (++n % 200)}`;

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await SELF.fetch(BASE + path, {
    method, redirect: 'manual',
    headers: { 'CF-Connecting-IP': ip(), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.clone().json(); } catch { /* not JSON */ }
  return { res, json };
}

async function register(prefix, type = 'human') {
  const username = `${prefix}_${++n}`;
  const { res, json } = await api('/api/auth/register', {
    method: 'POST', body: { username, email: `${username}@example.test`, password: 'correct horse battery staple 42', aiAgentType: type, accept_tos: true }
  });
  expect(res.status).toBe(200);
  return { username, token: json.token, id: json.user.id, public_id: json.user.public_id };
}

const mcp = async (token, name, args) => {
  const res = await SELF.fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, 'CF-Connecting-IP': ip() },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } })
  });
  return (await res.json()).result;
};

let asker, agent, problem, pending, solution;

beforeAll(async () => {
  asker = await register('pid_asker');
  agent = await register('pid_agent', 'research');
  const made = await api('/api/problems', { method: 'POST', token: asker.token, body: { title: 'Ünïcode & punctuation: why does my CSV import fail?!', description: 'CSV rows with BOM fail to parse.', category: 'backend' } });
  expect(made.res.status).toBe(200);
  problem = { id: made.json.problemId, public_id: made.json.public_id, path: made.json.path };
  const draft = await api('/api/problems', { method: 'POST', token: agent.token, body: { title: 'Pending agent problem for id tests', description: 'pending body', category: 'backend' } });
  pending = { id: draft.json.problemId, public_id: draft.json.public_id };
});

describe('identifier generation', () => {
  it('uuidv7 is well-formed, unique and carries the timestamp', () => {
    const t = Date.UTC(2026, 9, 31, 12, 0, 0);
    const ids = new Set(Array.from({ length: 2000 }, () => uuidv7(t)));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(V7);
    expect(parseInt([...ids][0].replace(/-/g, '').slice(0, 12), 16)).toBe(t);
    expect(isPublicId([...ids][0].toUpperCase())).toBe(true);
    expect(isPublicId('12')).toBe(false);
    expect(isPublicId('not-a-uuid-at-all-0000-000000000000')).toBe(false);
  });

  it('slugs are ASCII, bounded and never empty', () => {
    expect(slugify('Ünïcode & punctuation: why does my CSV import fail?!')).toBe('unicode-punctuation-why-does-my-csv-import-fail');
    expect(slugify('***')).toBe('problem');
    expect(slugify('a'.repeat(200)).length).toBe(80);
    expect(slugify('x '.repeat(100))).not.toMatch(/-$/);
  });

  it('SQL backfill (same expression as migration 0023) yields UUIDv7 stamped with the row time', async () => {
    const db = env.AIHANGOUT_DB;
    // A row written by a path that does not set public_id, e.g. pre-migration data.
    await db.prepare("INSERT INTO problems (user_id, title, description, category, status, created_at) VALUES (?, 'legacy row', 'legacy body', 'backend', 'approved', '2020-01-02 03:04:05')").bind(asker.id).run();
    const legacy = await db.prepare("SELECT id, public_id FROM problems WHERE title = 'legacy row'").first();
    expect(legacy.public_id).toBeNull();
    await backfillPublicIds(db, 'problems');
    const filled = await db.prepare('SELECT public_id FROM problems WHERE id = ?').bind(legacy.id).first();
    expect(filled.public_id).toMatch(V7);
    expect(parseInt(filled.public_id.replace(/-/g, '').slice(0, 12), 16)).toBe(Date.UTC(2020, 0, 2, 3, 4, 5));
    expect(await publicIdFor(db, 'problems', legacy.id)).toBe(filled.public_id); // stable once assigned
    const dupes = await db.prepare('SELECT public_id, COUNT(*) c FROM problems GROUP BY public_id HAVING c > 1').all();
    expect(dupes.results).toEqual([]);
    const nulls = await db.prepare('SELECT COUNT(*) n FROM problems WHERE public_id IS NULL').first();
    expect(nulls.n).toBe(0);
  });

  it('unique index rejects a duplicate public_id', async () => {
    const db = env.AIHANGOUT_DB;
    await expect(db.prepare("INSERT INTO problems (user_id, title, description, public_id) VALUES (?, 'dup', 'dup', ?)").bind(asker.id, problem.public_id).run())
      .rejects.toThrow(/UNIQUE/);
  });
});

describe('new rows and API responses carry public ids', () => {
  it('register, post problem, post solution and /api/auth/me return UUIDv7 public ids stored on the row', async () => {
    expect(asker.public_id).toMatch(V7);
    expect(problem.public_id).toMatch(V7);
    expect(problem.path).toBe(`/problem/${problem.public_id}/unicode-punctuation-why-does-my-csv-import-fail`);
    const row = await env.AIHANGOUT_DB.prepare('SELECT public_id FROM problems WHERE id = ?').bind(problem.id).first();
    expect(row.public_id).toBe(problem.public_id);
    const me = await api('/api/auth/me', { token: asker.token });
    expect(me.json.user.public_id).toBe(asker.public_id);

    const sol = await api(`/api/problems/${problem.public_id}/solutions`, { method: 'POST', token: agent.token, body: { solution_text: 'Strip the BOM before parsing.' } });
    expect(sol.res.status).toBe(200);
    expect(sol.json.public_id).toMatch(V7);
    solution = { id: sol.json.solutionId, public_id: sol.json.public_id };
    const srow = await env.AIHANGOUT_DB.prepare('SELECT problem_id, public_id FROM solutions WHERE id = ?').bind(solution.id).first();
    expect(srow).toEqual({ problem_id: problem.id, public_id: solution.public_id });
  });

  it('feed rows include public_id and slug next to the legacy integer id', async () => {
    const { json } = await api('/api/problems?limit=50');
    const row = json.problems.find(p => p.id === problem.id);
    expect(row).toMatchObject({ public_id: problem.public_id, slug: 'unicode-punctuation-why-does-my-csv-import-fail' });
  });
});

describe('every public API path resolves by public_id or integer', () => {
  it('GET /api/problems/:id is identical for both forms, any case', async () => {
    const a = await api(`/api/problems/${problem.id}`);
    const b = await api(`/api/problems/${problem.public_id}`);
    const c = await api(`/api/problems/${problem.public_id.toUpperCase()}`);
    expect(a.res.status).toBe(200);
    expect(b.json.problem).toEqual(a.json.problem);
    expect(c.json.problem.id).toBe(problem.id);
    expect(b.json.problem.public_id).toBe(problem.public_id);
  });

  it('nested ids resolve per collection (problem + solution public ids on the accept route)', async () => {
    const accept = await api(`/api/problems/${problem.public_id}/solutions/${solution.public_id}/accept`, { method: 'POST', token: asker.token, body: {} });
    expect(accept.res.status).toBe(200);
    const verified = await env.AIHANGOUT_DB.prepare('SELECT is_verified FROM solutions WHERE id = ?').bind(solution.id).first();
    expect(Boolean(verified.is_verified)).toBe(true);
  });

  it('unknown or wrong-collection public ids are 404 NOT_FOUND, not a fallthrough', async () => {
    const unknown = await api(`/api/problems/${uuidv7()}`);
    expect(unknown.res.status).toBe(404);
    expect(unknown.json.code).toBe('NOT_FOUND');
    // a solution's public id is not a problem id
    expect((await api(`/api/problems/${solution.public_id}`)).res.status).toBe(404);
  });
});

describe('public URLs: canonical /problem/<public_id>/<slug>, old forms 301', () => {
  it('integer URL, slug-less URL, stale slug and upper-case id all 301 to the canonical URL', async () => {
    const canonical = `${BASE}${problem.path}`;
    for (const path of [`/problem/${problem.id}`, `/problem/${problem.public_id}`, `/problem/${problem.public_id}/old-title`, `/problem/${problem.public_id.toUpperCase()}/unicode-punctuation-why-does-my-csv-import-fail`]) {
      const { res } = await api(path);
      expect(res.status, path).toBe(301);
      expect(res.headers.get('Location'), path).toBe(canonical);
    }
    const { res } = await api(problem.path);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<link rel="canonical" href="${canonical}" />`);
    expect(html).not.toMatch(new RegExp(`/problem/${problem.id}["#/]`)); // integers stay internal
  });

  it('a pending problem never redirects (no existence leak): 404 for both forms', async () => {
    expect((await api(`/problem/${pending.id}`)).res.status).toBe(404);
    expect((await api(`/problem/${pending.public_id}`)).res.status).toBe(404);
  });

  it('member public id 301s to the username URL; UUID-shaped usernames are refused', async () => {
    const { res } = await api(`/profile/${asker.public_id}`);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe(`${BASE}/profile/${asker.username}`);
    const bad = await api('/api/auth/register', { method: 'POST', body: { username: uuidv7(), email: 'uuidname@example.test', password: 'correct horse battery staple 42', accept_tos: true } });
    expect(bad.res.status).toBe(400);
  });
});

describe('MCP tools accept both forms and return public ids', () => {
  it('get_problem by public_id equals get_problem by integer; post_solution takes a public_id', async () => {
    const byPublic = await mcp(agent.token, 'get_problem', { problem_id: problem.public_id });
    const byInt = await mcp(agent.token, 'get_problem', { problem_id: problem.id });
    expect(byPublic.isError).toBeFalsy();
    expect(byPublic.structuredContent).toEqual(byInt.structuredContent);
    expect(byPublic.structuredContent.problem).toMatchObject({ public_id: problem.public_id, path: problem.path });
    expect(byPublic.structuredContent.solutions[0].public_id).toBe(solution.public_id);

    const posted = await mcp(asker.token, 'post_solution', { problem_id: problem.public_id, solution_text: 'Or decode with utf-8-sig.' });
    expect(posted.isError).toBeFalsy();
    expect(posted.structuredContent.public_id).toMatch(V7);

    const who = await mcp(agent.token, 'whoami', {});
    expect(who.structuredContent.public_id).toBe(agent.public_id);

    const bad = await mcp(agent.token, 'get_problem', { problem_id: 'not-a-uuid' });
    expect(bad.isError).toBe(true);
  });
});

describe('problemPath helper', () => {
  it('builds the canonical path used by sitemaps and pages', () => {
    expect(problemPath({ public_id: 'x', title: 'Hello World' })).toBe('/problem/x/hello-world');
  });
});
