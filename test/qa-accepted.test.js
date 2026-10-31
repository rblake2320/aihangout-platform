import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// AIH-R7 step 2: accepted answer. Real D1 and real routes; MCP through POST /mcp.
const BASE = 'https://aihangout.ai';
const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

let n = 0;
const nextIp = () => `192.0.2.${100 + (++n % 150)}`;
const uniq = (p) => `${p}${++n}x${Math.floor(Math.random() * 1e6)}`;

async function api(path, { method = 'GET', body, token, ip = nextIp() } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await SELF.fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

async function user(prefix) {
  const username = uniq(prefix).slice(0, 40);
  const ip = nextIp();
  const res = await api('/api/auth/register', {
    method: 'POST', ip,
    body: { username, email: `${username}@example.test`, password: 'correct horse battery staple 42', ai_agent_type: 'human', accept_tos: true }
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return { id: res.json.user.id, username, token: res.json.token, ip };
}

async function problem(owner, title) {
  const res = await api('/api/problems', {
    method: 'POST', token: owner.token, ip: owner.ip,
    body: { title, description: 'A fixture description that is long enough to pass validation.', category: 'Programming' }
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.problemId;
}

async function answer(solver, problemId, text = 'Here is a concrete fix that works.') {
  const res = await api(`/api/problems/${problemId}/solutions`, {
    method: 'POST', token: solver.token, ip: solver.ip, body: { solutionText: text, whyExplanation: 'It addresses the cause.' }
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.solutionId;
}

// Notifications are written in ctx.waitUntil, after the response: poll briefly for them.
async function notes(uid, type, want = 1) {
  const end = Date.now() + 3000;
  for (;;) {
    const rows = (await env.AIHANGOUT_DB.prepare(
      'SELECT message, actor_id, target_id FROM notifications WHERE user_id = ? AND type = ?').bind(uid, type).all()).results;
    if (rows.length >= want || Date.now() > end) return rows;
    await new Promise(r => setTimeout(r, 25));
  }
}

let rpcId = 0;
async function call(name, args, who) {
  const res = await SELF.fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'CF-Connecting-IP': nextIp(), Authorization: `Bearer ${who.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
  });
  return JSON.parse(await res.text()).result;
}

describe('accepted answer', () => {
  it('lets only the asker accept, checks the answer belongs to the question, and shows it on the problem', async () => {
    const asker = await user('qa_acc_asker');
    const solver = await user('qa_acc_solver');
    const other = await user('qa_acc_other');
    const p = await problem(asker, `Accept fixture ${uniq('a')}`);
    const sid = await answer(solver, p);

    const denied = await api(`/api/problems/${p}/accept`, { method: 'POST', token: other.token, ip: other.ip, body: { solution_id: sid } });
    expect(denied.status).toBe(403);

    const otherProblem = await problem(asker, `Accept other ${uniq('b')}`);
    const wrong = await api(`/api/problems/${otherProblem}/accept`, { method: 'POST', token: asker.token, ip: asker.ip, body: { solution_id: sid } });
    expect(wrong.status).toBe(400);

    const ok = await api(`/api/problems/${p}/accept`, { method: 'POST', token: asker.token, ip: asker.ip, body: { solution_id: sid } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.problem.accepted_solution_id).toBe(sid);

    const got = await api(`/api/problems/${p}`);
    expect(got.json.problem.accepted_solution_id).toBe(sid);
  });

  it('notifies the answerer in-app, and not the asker when they accept their own answer', async () => {
    const asker = await user('qa_acc_n1');
    const solver = await user('qa_acc_n2');
    const p = await problem(asker, `Accept notify ${uniq('c')}`);
    const sid = await answer(solver, p);
    await api(`/api/problems/${p}/accept`, { method: 'POST', token: asker.token, ip: asker.ip, body: { solution_id: sid } });
    const rows = await notes(solver.id, 'solution_accepted');
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe(`${asker.username} accepted your answer`);

    const own = await answer(asker, p, 'My own answer, which I accept.');
    await api(`/api/problems/${p}/accept`, { method: 'POST', token: asker.token, ip: asker.ip, body: { solution_id: own } });
    expect(await notes(asker.id, 'solution_accepted', 1)).toHaveLength(0);
  });

  it('can be cleared by the asker, and a bad solution id or no login is refused', async () => {
    const asker = await user('qa_acc_c1');
    const solver = await user('qa_acc_c2');
    const p = await problem(asker, `Accept clear ${uniq('d')}`);
    const sid = await answer(solver, p);
    await api(`/api/problems/${p}/accept`, { method: 'POST', token: asker.token, ip: asker.ip, body: { solution_id: sid } });

    const cleared = await api(`/api/problems/${p}/accept`, { method: 'DELETE', token: asker.token, ip: asker.ip });
    expect(cleared.json.problem.accepted_solution_id).toBeNull();
    expect((await api(`/api/problems/${p}`)).json.problem.accepted_solution_id).toBeNull();

    expect((await api(`/api/problems/${p}/accept`, { method: 'POST', token: asker.token, ip: asker.ip, body: { solution_id: 'x' } })).status).toBe(400);
    expect((await api(`/api/problems/${p}/accept`, { method: 'POST', body: { solution_id: sid } })).status).toBe(401);
    expect((await api('/api/problems/999999999/accept', { method: 'POST', token: asker.token, ip: asker.ip, body: { solution_id: sid } })).status).toBe(404);
  });

  it('accept_answer works over MCP with the same ownership rule', async () => {
    const asker = await user('qa_acc_mcp1');
    const solver = await user('qa_acc_mcp2');
    const pid = (await call('post_problem', { title: `MCP accept ${uniq('e')}`, description: 'A fixture description long enough to validate.', category: 'Programming' }, asker)).structuredContent.id;
    const sid = (await call('post_solution', { problem_id: pid, solution_text: 'A concrete fix that resolves it.' }, solver)).structuredContent.id;

    const denied = await call('accept_answer', { problem_id: pid, solution_id: sid }, solver);
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent.error.code).toBe('FORBIDDEN');

    const acc = await call('accept_answer', { problem_id: pid, solution_id: sid }, asker);
    expect(acc.structuredContent).toEqual({ problem_id: pid, accepted_solution_id: sid });
    expect((await call('get_problem', { problem_id: pid }, asker)).structuredContent.problem.accepted_solution_id).toBe(sid);

    const cleared = await call('accept_answer', { problem_id: pid }, asker);
    expect(cleared.structuredContent.accepted_solution_id).toBeNull();
  });
});
