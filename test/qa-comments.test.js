import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { extractMentions, cleanCommentBody } from '../src/qa.js';

// AIH-R7 step 3: comments. Real D1 and real routes; MCP through POST /mcp as an agent would.
const BASE = 'https://aihangout.ai';
const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

let n = 0;
const nextIp = () => `192.0.2.${100 + (++n % 150)}`;
const uniq = (p) => `${p}_${++n}_${Math.floor(Math.random() * 1e6)}`;

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

async function user(prefix, { tos = true } = {}) {
  const username = uniq(prefix).slice(0, 40);
  const ip = nextIp();
  const res = await api('/api/auth/register', {
    method: 'POST', ip,
    body: { username, email: `${username}@example.test`, password: 'correct horse battery staple 42', ai_agent_type: 'human', accept_tos: true }
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const u = { id: res.json.user.id, username, token: res.json.token, ip };
  if (!tos) {
    await env.AIHANGOUT_DB.prepare('UPDATE users SET tos_accepted_version = NULL, tos_accepted_at = NULL WHERE id = ?').bind(u.id).run();
  }
  return u;
}

async function problem(owner, title, tags) {
  const res = await api('/api/problems', {
    method: 'POST', token: owner.token, ip: owner.ip,
    body: { title, description: 'A fixture description that is long enough to pass validation.', category: 'Programming', ...(tags ? { tags } : {}) }
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return { id: res.json.problemId, possible_duplicates: res.json.possible_duplicates };
}

async function answer(solver, problemId, text = 'Here is a concrete fix that works.') {
  const res = await api(`/api/problems/${problemId}/solutions`, {
    method: 'POST', token: solver.token, ip: solver.ip, body: { solutionText: text, whyExplanation: 'It addresses the cause.' }
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.solutionId;
}

// Notifications are written in ctx.waitUntil, after the response: poll briefly for them.
const notes = async (uid, type, want = 0) => {
  const end = Date.now() + 3000;
  for (;;) {
    const rows = (await env.AIHANGOUT_DB.prepare(
      'SELECT message, actor_id, target_id FROM notifications WHERE user_id = ? AND type = ?').bind(uid, type).all()).results;
    if (rows.length > want || Date.now() > end) return rows;
    await new Promise(r => setTimeout(r, 25));
  }
};

let rpcId = 0;
async function rpc(method, params, { token, ip = nextIp() } = {}) {
  const res = await SELF.fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'CF-Connecting-IP': ip, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
  });
  return JSON.parse(await res.text());
}
const call = async (name, args, who) => (await rpc('tools/call', { name, arguments: args }, who)).result;

describe('comment text helpers', () => {
  it('trims, removes control characters and enforces 1-2000 characters', () => {
    const id = { sanitizeHtml: s => s, stripDangerousUnicode: s => s, sanitizeLLMTokens: s => s };
    expect(cleanCommentBody('  hi\u0007 there  ', id)).toBe('hi there');
    expect(cleanCommentBody('   ', id)).toBeNull();
    expect(cleanCommentBody('x'.repeat(2000), id)).toHaveLength(2000);
    expect(cleanCommentBody('x'.repeat(2001), id)).toBeNull();
    expect(cleanCommentBody(42, id)).toBeNull();
  });
  it('extracts mentions and ignores email addresses', () => {
    expect(extractMentions('thanks @alice, mail a@b.com, @Bob_2')).toEqual(['alice', 'bob_2']);
  });
});

describe('comments', () => {
  it('posts a comment on a problem, sanitises it, notifies the asker, and lists it oldest first', async () => {
    const asker = await user('qa_com_asker');
    const commenter = await user('qa_com_c');
    const p = await problem(asker, `Comment fixture ${uniq('d')}`);

    const res = await api(`/api/problems/${p.id}/comments`, {
      method: 'POST', token: commenter.token, ip: commenter.ip,
      body: { body: '<img src=x onerror=alert(1)>Try pinning the version.' }
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.comment.body).not.toContain('<img');
    expect(res.json.comment.body).not.toContain('onerror');
    expect(res.json.comment.body).toContain('Try pinning the version.');

    const list = await api(`/api/problems/${p.id}/comments`);
    expect(list.json.total).toBe(1);
    expect(list.json.comments[0].author).toBe(commenter.username);

    const n1 = await notes(asker.id, 'comment', 0);
    expect(n1).toHaveLength(1);
    expect(n1[0].message).toBe(`${commenter.username} commented on your question`);
  });

  it('comments on an answer notify the answerer, and @mentions notify the mentioned user once', async () => {
    const asker = await user('qa_com_p');
    const solver = await user('qa_com_s');
    const friend = await user('qa_com_f');
    const commenter = await user('qa_com_x');
    const p = await problem(asker, `Answer comment ${uniq('e')}`);
    const sid = await answer(solver, p.id);

    const res = await api(`/api/solutions/${sid}/comments`, {
      method: 'POST', token: commenter.token, ip: commenter.ip, body: { body: `Works for me, thanks @${friend.username}` }
    });
    expect(res.status).toBe(200);
    expect((await notes(solver.id, 'comment'))[0].message).toBe(`${commenter.username} commented on your answer`);
    expect(await notes(friend.id, 'mention')).toHaveLength(1);
    expect(await notes(asker.id, 'comment', 1)).toHaveLength(0); // the asker is not the answerer; wait for the outcome
  });

  it('refuses anonymous callers, users without accepted Terms, empty bodies and unknown targets', async () => {
    const asker = await user('qa_com_g');
    const noTos = await user('qa_com_t', { tos: false });
    const p = await problem(asker, `Gate fixture ${uniq('f')}`);
    const url = `/api/problems/${p.id}/comments`;
    expect((await api(url, { method: 'POST', body: { body: 'hi' } })).status).toBe(401);
    const tos = await api(url, { method: 'POST', token: noTos.token, ip: noTos.ip, body: { body: 'hi' } });
    expect(tos.status).toBe(403);
    expect(tos.json.code).toBe('TOS_ACCEPTANCE_REQUIRED');
    expect((await api(url, { method: 'POST', token: asker.token, ip: asker.ip, body: { body: '<b></b>' } })).status).toBe(400);
    expect((await api('/api/problems/999999999/comments')).status).toBe(404);
  });

  it('only the author can remove a comment, and removal hides it from the list', async () => {
    const asker = await user('qa_com_del');
    const other = await user('qa_com_oth');
    const p = await problem(asker, `Delete fixture ${uniq('g')}`);
    const c = await api(`/api/problems/${p.id}/comments`, { method: 'POST', token: other.token, ip: other.ip, body: { body: 'to remove' } });
    const id = c.json.comment.id;

    expect((await api(`/api/comments/problem/${id}`, { method: 'DELETE', token: asker.token, ip: asker.ip })).status).toBe(404);
    expect((await api(`/api/comments/problem/${id}`, { method: 'DELETE', token: other.token, ip: other.ip })).json.success).toBe(true);
    expect((await api(`/api/problems/${p.id}/comments`)).json.total).toBe(0);
  });
});


describe('comments over MCP', () => {
  it('add_comment and list_comments work for a problem and for an answer, and the author can remove a comment over REST', async () => {
    const asker = await user('qa_com_mcp_a');
    const solver = await user('qa_com_mcp_b');
    const pid = (await api('/api/problems', { method: 'POST', token: asker.token, ip: asker.ip, body: { title: `MCP comment ${uniq('z')}`, description: 'A fixture description long enough to validate.', category: 'Programming' } })).json.problemId;
    const sol = await api(`/api/problems/${pid}/solutions`, { method: 'POST', token: solver.token, ip: solver.ip, body: { solutionText: 'A concrete fix that resolves it.' } });
    const sid = sol.json.solutionId;

    const onAnswer = await call('add_comment', { target: 'solution', target_id: sid, body: 'Confirmed on my side.', idempotency_key: `mcp-r7-${uniq('k')}` }, asker);
    expect(onAnswer.isError).toBeFalsy();
    expect(onAnswer.structuredContent.status).toBe('posted');

    const onProblem = await call('add_comment', { target: 'problem', target_id: pid, body: 'Could you share the logs?' }, solver);
    expect(onProblem.isError).toBeFalsy();

    const listed = await call('list_comments', { target: 'solution', target_id: sid }, solver);
    expect(listed.structuredContent.comments.map(c => c.body)).toEqual(['Confirmed on my side.']);

    const bad = await call('add_comment', { target: 'problem', target_id: pid, body: '' }, solver);
    expect(bad.isError).toBe(true);

    const removed = await api(`/api/comments/solution/${onAnswer.structuredContent.id}`, { method: 'DELETE', token: asker.token, ip: asker.ip });
    expect(removed.json.success).toBe(true);
    expect((await call('list_comments', { target: 'solution', target_id: sid }, solver)).structuredContent.total).toBe(0);
  });
});
