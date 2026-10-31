import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { titleTokens, jaccard } from '../src/qa.js';

// AIH-R7 step 4: duplicate suggestion. Real D1 and real routes.
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

describe('Q&A similarity helpers', () => {
  it('ranks title overlap with Jaccard over distinctive words', () => {
    const a = titleTokens('Kubernetes pod crashloop after upgrade');
    const b = titleTokens('Kubernetes pod crashloop after upgrade again');
    expect(jaccard(a, b)).toBeGreaterThanOrEqual(0.8);
    expect(jaccard(a, titleTokens('Best budget espresso grinder'))).toBe(0);
    expect(titleTokens('How do I fix the issue?').size).toBe(1); // only "fix" survives the stop list
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe('duplicate suggestion on post', () => {
  it('suggests the closest existing problem when a post is made, and never the new post itself', async () => {
    const a = await user('qa_dup_a');
    const first = await problem(a, 'Kubernetes pod crashloop after upgrade');
    const b = await user('qa_dup_b');
    const second = await problem(b, 'Kubernetes pod crashloop after upgrade again');
    expect(second.possible_duplicates.map(d => d.id)).toContain(first.id);
    expect(second.possible_duplicates.every(d => d.id !== second.id && d.score >= 0.5)).toBe(true);

    const sim = await api(`/api/problems/${second.id}/similar`);
    expect(sim.status).toBe(200);
    expect(sim.json.similar.map(s => s.id)).toContain(first.id);
  });

  it('suggests nothing for an unrelated title, and a missing problem is a 404', async () => {
    const a = await user('qa_dup_c');
    const p = await problem(a, 'Best budget espresso grinder recommendation');
    expect(p.possible_duplicates).toEqual([]);
    expect((await api('/api/problems/999999999/similar')).status).toBe(404);
  });
});

