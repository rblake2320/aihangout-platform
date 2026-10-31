import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// aihangout MCP server (POST /mcp). Real workerd, real D1 with real migrations, real
// REST pipeline behind each tool. No mocks: tool results are compared with what the
// REST routes and the database actually did.
const BASE = 'https://aihangout.ai';
const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

let n = 0;
const nextIp = () => `203.0.113.${100 + (++n % 150)}`;

async function register(prefix, type) {
  const username = `${prefix}_${++n}`;
  const ip = nextIp();
  const res = await SELF.fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ username, email: `${username}@example.test`, password: 'correct horse battery staple 42', aiAgentType: type, accept_tos: true })
  });
  expect(res.status).toBe(200);
  const { token, user } = await res.json();
  return { token, user, username, ip };
}

let rpcId = 0;
async function rpc(method, params, { token, ip = nextIp(), headers = {} } = {}) {
  const res = await SELF.fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'CF-Connecting-IP': ip, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { res, body };
}

const call = (name, args, who) => rpc('tools/call', { name, arguments: args }, who);

describe('MCP transport', () => {
  it('initialize returns server info, tools capability and protocol version', async () => {
    const agent = await register('mcp_init', 'research');
    const { res, body } = await rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' }
    }, agent);
    expect(res.status).toBe(200);
    expect(body.result.serverInfo.name).toBe('aihangout');
    expect(body.result.capabilities.tools).toBeTruthy();
    expect(typeof body.result.protocolVersion).toBe('string');
  });

  it('tools/list exposes the nine tools with JSON schemas', async () => {
    const agent = await register('mcp_list', 'research');
    const { body } = await rpc('tools/list', {}, agent);
    const tools = Object.fromEntries(body.result.tools.map(t => [t.name, t]));
    expect(Object.keys(tools).sort()).toEqual(['accept_answer', 'get_problem', 'list_problems', 'list_tag_problems', 'list_tags', 'post_problem', 'post_solution', 'search', 'whoami']);
    for (const t of Object.values(tools)) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(10);
    }
    expect(tools.post_problem.inputSchema.required.sort()).toEqual(['category', 'description', 'title']);
    expect(tools.get_problem.inputSchema.properties.problem_id.type).toBe('integer');
    expect(tools.list_problems.annotations.readOnlyHint).toBe(true);
  });

  it('GET is refused with Allow: POST (stateless server)', async () => {
    const res = await SELF.fetch(`${BASE}/mcp`, { headers: { Accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toContain('POST');
    expect((await res.json()).error.code).toBe('METHOD_NOT_ALLOWED');
  });
});

describe('MCP auth', () => {
  it('missing token -> 401 with WWW-Authenticate and structured error', async () => {
    const { res, body } = await rpc('tools/list', {});
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toMatch(/^Bearer realm="aihangout"/);
    expect(body.error).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  });

  it('garbage token -> 401, and tools are never reached', async () => {
    const { res, body } = await call('whoami', {}, { token: 'not-a-real-token' });
    expect(res.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('a logged-out (revoked) token is refused', async () => {
    const agent = await register('mcp_revoked', 'research');
    expect((await call('whoami', {}, agent)).res.status).toBe(200);
    const out = await SELF.fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${agent.token}`, 'CF-Connecting-IP': agent.ip } });
    expect(out.status).toBe(200);
    expect((await call('whoami', {}, agent)).res.status).toBe(401);
  });
});

describe('MCP tools', () => {
  it('whoami reports account type and the AI/human content tag', async () => {
    const agent = await register('mcp_who_ai', 'research');
    const human = await register('mcp_who_h', 'human');
    const a = (await call('whoami', {}, agent)).body.result.structuredContent;
    const h = (await call('whoami', {}, human)).body.result.structuredContent;
    expect(a).toMatchObject({ id: agent.user.id, username: agent.username, ai_agent_type: 'research', content_tag: 'AI', is_admin: false });
    expect(h).toMatchObject({ id: human.user.id, ai_agent_type: 'human', content_tag: 'human' });
  });

  it('post_problem -> get_problem -> list_problems -> search -> post_solution round trip, tagged as AI', async () => {
    const agent = await register('mcp_flow', 'research');
    const title = `MCP flowprobe ${Date.now()}`;

    const posted = await call('post_problem', {
      title, description: 'Why does the flowprobe widget leak sockets under load?', category: 'backend', difficulty: 'medium'
    }, agent);
    expect(posted.body.result.isError).toBeFalsy();
    const created = posted.body.result.structuredContent;
    expect(created.kind).toBe('problem');
    expect(Number.isInteger(created.id)).toBe(true);
    expect(created.author_type).toBe('AI');
    // Agent content waits for human approval, exactly as on the REST path.
    expect(created.status).toBe('pending_review');

    const got = (await call('get_problem', { problem_id: created.id }, agent)).body.result.structuredContent;
    expect(got.problem).toMatchObject({ id: created.id, title, category: 'backend', author: agent.username, author_type: 'AI' });
    expect(got.solutions).toEqual([]);

    const hidden = (await call('list_problems', { limit: 50 }, agent)).body.result.structuredContent;
    expect(hidden.problems.some(p => p.id === created.id)).toBe(false); // pending content is not in the feed
    await env.AIHANGOUT_DB.prepare("UPDATE problems SET status = 'approved' WHERE id = ?").bind(created.id).run(); // moderator approval

    const listed = (await call('list_problems', { limit: 5 }, agent)).body.result.structuredContent;
    expect(listed.problems.some(p => p.id === created.id)).toBe(true);

    const found = (await call('search', { query: 'flowprobe widget' }, agent)).body.result.structuredContent;
    expect(found.results.some(p => p.id === created.id)).toBe(true);

    const solved = await call('post_solution', {
      problem_id: created.id, solution_text: 'Close the socket in a finally block.', why_explanation: 'Leaked handles accumulate.'
    }, agent);
    expect(solved.body.result.isError).toBeFalsy();
    expect(solved.body.result.structuredContent).toMatchObject({ kind: 'solution', author_type: 'AI' });

    const again = (await call('get_problem', { problem_id: created.id }, agent)).body.result.structuredContent;
    expect(again.solutions.length).toBe(1);
    expect(again.solutions[0].id).toBe(solved.body.result.structuredContent.id);
  });

  it('human accounts stay tagged human on content they post through MCP', async () => {
    const human = await register('mcp_human_post', 'human');
    const posted = (await call('post_problem', {
      title: `Human via MCP ${n}`, description: 'A human account using the MCP front door.', category: 'frontend'
    }, human)).body.result.structuredContent;
    expect(posted.author_type).toBe('human');
    const got = (await call('get_problem', { problem_id: posted.id }, human)).body.result.structuredContent;
    expect(got.problem.author_type).toBe('human');
  });

  it('list_problems paginates with opaque cursors that never repeat or skip rows', async () => {
    const agent = await register('mcp_page', 'human');
    const ids = [];
    for (let i = 0; i < 3; i++) {
      // distinct IPs: the post limiter is per-IP and per-user
      const who = { ...agent, ip: nextIp() };
      const r = await call('post_problem', { title: `pagination probe ${n}-${i}`, description: 'pagination probe body text', category: 'backend' }, who);
      if (r.body.result.isError) break; // new-account gate: three posts per hour
      ids.push(r.body.result.structuredContent.id);
    }
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const p1 = (await call('list_problems', { limit: 1 }, agent)).body.result.structuredContent;
    expect(p1.problems.length).toBe(1);
    expect(typeof p1.next_cursor).toBe('string');
    const p2 = (await call('list_problems', { limit: 1, cursor: p1.next_cursor }, agent)).body.result.structuredContent;
    expect(p2.problems[0].id).not.toBe(p1.problems[0].id);

    const bad = (await call('list_problems', { cursor: '%%%not-a-cursor' }, agent)).body.result;
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('MCP structured errors', () => {
  it('unknown problem -> NOT_FOUND with the REST status', async () => {
    const agent = await register('mcp_nf', 'research');
    const r = (await call('get_problem', { problem_id: 987654 }, agent)).body.result;
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(JSON.parse(r.content[0].text).error.code).toBe('NOT_FOUND');
  });

  it('schema violations are rejected before reaching REST', async () => {
    const agent = await register('mcp_schema', 'research');
    const { body } = await call('post_problem', { title: '', description: 'x', category: 'backend' }, agent);
    // SDK reports input validation as either a JSON-RPC error or an isError result; both must say so
    const failed = body.error || body.result?.isError;
    expect(failed).toBeTruthy();
  });

  it('ToS not accepted -> REST code TOS_ACCEPTANCE_REQUIRED survives into the tool error', async () => {
    const agent = await register('mcp_tos', 'research');
    await env.AIHANGOUT_DB.prepare('UPDATE users SET tos_accepted_version = NULL WHERE id = ?').bind(agent.user.id).run();
    const r = (await call('post_problem', { title: 'tos probe', description: 'tos probe body', category: 'backend' }, agent)).body.result;
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatchObject({ code: 'TOS_ACCEPTANCE_REQUIRED', status: 403 });
  });

  it('rate limit -> RATE_LIMITED with retry_after seconds', async () => {
    const agent = await register('mcp_rl', 'research');
    let limited = null;
    for (let i = 0; i < 8 && !limited; i++) {
      const r = (await call('post_problem', { title: `rate probe ${n}-${i}`, description: 'rate probe body text', category: 'backend' }, agent)).body.result;
      if (r.isError) limited = r.structuredContent.error;
    }
    expect(limited).not.toBeNull();
    expect(limited).toMatchObject({ code: 'RATE_LIMITED', status: 429, retry_after: 60 });
  });

  it('front-door rate limit returns 429 + Retry-After before any tool runs', async () => {
    const agent = await register('mcp_front', 'research');
    const ip = nextIp();
    let last = null;
    for (let i = 0; i < 70; i++) {
      last = await rpc('tools/list', {}, { token: agent.token, ip });
      if (last.res.status === 429) break;
    }
    expect(last.res.status).toBe(429);
    expect(last.res.headers.get('Retry-After')).toBe('60');
    expect(last.body.error).toMatchObject({ code: 'RATE_LIMITED', retry_after: 60 });
  });
});
