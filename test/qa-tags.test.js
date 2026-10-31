import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { normalizeTag } from '../src/qa.js';

// AIH-R7 step 1: tags. Real D1 and real routes; MCP goes through POST /mcp as an agent would.
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

async function problem(owner, title, tags) {
  const res = await api('/api/problems', {
    method: 'POST', token: owner.token, ip: owner.ip,
    body: { title, description: 'A fixture description that is long enough to pass validation.', category: 'Programming', tags }
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.problemId;
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

describe('tag normalisation', () => {
  it('lower-cases, folds spaces to hyphens, and rejects anything that is not a plain tag', () => {
    expect(normalizeTag('  Machine Learning ')).toBe('machine-learning');
    expect(normalizeTag('c++')).toBe('c++');
    expect(normalizeTag('node.js')).toBe('node.js');
    expect(normalizeTag('a/b')).toBeNull();
    expect(normalizeTag('')).toBeNull();
    expect(normalizeTag('-leading')).toBeNull();
    expect(normalizeTag('x'.repeat(51))).toBeNull();
  });
});

describe('tag listing and tag pages (JSON)', () => {
  it('counts tags case-insensitively, lists a tag\'s public problems, and rejects bad tags', async () => {
    const a = await user('qa_tag_a');
    const tag = uniq('tagx').toLowerCase();
    const p1 = await problem(a, `Tagged fixture one ${uniq('t')}`, [tag, 'rust']);
    await problem(a, `Tagged fixture two ${uniq('t')}`, [tag.toUpperCase()]);

    const tags = (await api('/api/tags?limit=200')).json.tags;
    expect(tags.find(t => t.tag === tag).problems).toBe(2);

    const page = await api(`/api/tags/${tag}/problems`);
    expect(page.status).toBe(200);
    expect(page.json.total).toBe(2);
    expect(page.json.problems.map(p => p.id)).toContain(p1);

    expect((await api(`/api/tags/${encodeURIComponent('bad/tag')}/problems`)).status).toBe(404);
    expect((await api(`/api/tags/${tag}/problems?limit=0`)).status).toBe(400); // platform-wide limit validation
  });

  it('does not list tags from problems that are not public', async () => {
    const a = await user('qa_tag_hidden');
    const secret = uniq('hiddentag').toLowerCase();
    const pid = await problem(a, `Pending fixture ${uniq('p')}`, [secret]);
    await env.AIHANGOUT_DB.prepare("UPDATE problems SET status = 'pending_review' WHERE id = ?").bind(pid).run();
    const tags = (await api('/api/tags?limit=200')).json.tags;
    expect(tags.find(t => t.tag === secret)).toBeUndefined();
    expect((await api(`/api/tags/${secret}/problems`)).json.total).toBe(0);
  });
});

describe('tools for tags over MCP', () => {
  it('list_tags and list_tag_problems return the same data as the REST routes', async () => {
    const agent = await user('qa_tag_mcp');
    const tag = uniq('mcptag').toLowerCase();
    const id = await problem(agent, `MCP tag fixture ${uniq('m')}`, [tag]);

    const tags = await call('list_tags', { limit: 200 }, agent);
    expect(tags.isError).toBeFalsy();
    expect(tags.structuredContent.tags.find(t => t.tag === tag).problems).toBe(1);

    const page = await call('list_tag_problems', { tag, limit: 10 }, agent);
    expect(page.isError).toBeFalsy();
    expect(page.structuredContent.total).toBe(1);
    expect(page.structuredContent.problems.map(p => p.id)).toContain(id);
    expect(page.structuredContent.next_cursor).toBeNull();
  });
});
