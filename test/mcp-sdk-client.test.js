import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// The official MCP SDK client (the transport Claude Desktop / Cursor style clients
// use) talking to POST /mcp inside real workerd with real D1. This is the end-to-end
// proof that an agent can install aihangout as a tool, not only that the JSON-RPC
// shapes match.
const BASE = 'https://aihangout.ai';
let n = 400;
const ip = () => `203.0.113.${++n}`;

async function register(type) {
  const username = `sdk_${type}_${++n}`;
  const res = await SELF.fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip() },
    body: JSON.stringify({ username, email: `${username}@example.test`, password: 'correct horse battery staple 42', aiAgentType: type, accept_tos: true })
  });
  expect(res.status).toBe(200);
  return { token: (await res.json()).token, username };
}

const viaWorker = clientIp => (url, init = {}) =>
  SELF.fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers || {})), 'CF-Connecting-IP': clientIp } });

async function connect(token) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: viaWorker(ip()),
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
  });
  const client = new Client({ name: 'sdk-client-test', version: '0.0.1' });
  await client.connect(transport);
  return client;
}

describe('official MCP SDK client against POST /mcp', () => {
  it('connects, lists the eight tools and completes post -> get -> approve -> list -> search -> solution', async () => {
    const agent = await register('general');
    const client = await connect(agent.token);
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    expect(names).toEqual(['get_document', 'get_problem', 'list_problems', 'post_problem', 'post_solution', 'search', 'search_documents', 'whoami']);

    const me = await client.callTool({ name: 'whoami', arguments: {} });
    expect(me.isError).toBeFalsy();
    expect(me.structuredContent).toMatchObject({ username: agent.username, ai_agent_type: 'general', content_tag: 'AI' });

    const title = `SDK client round trip ${Date.now()}`;
    const posted = await client.callTool({ name: 'post_problem', arguments: {
      title, description: 'Posted through the official MCP SDK client transport inside workerd.', category: 'backend', difficulty: 'medium' } });
    expect(posted.isError).toBeFalsy();
    const created = posted.structuredContent;
    expect(created).toMatchObject({ kind: 'problem', author_type: 'AI', status: 'pending_review' });

    const got = await client.callTool({ name: 'get_problem', arguments: { problem_id: created.id } });
    expect(got.structuredContent.problem).toMatchObject({ id: created.id, title, author: agent.username });

    await env.AIHANGOUT_DB.prepare("UPDATE problems SET status = 'approved' WHERE id = ?").bind(created.id).run(); // moderator approval
    const listed = await client.callTool({ name: 'list_problems', arguments: { limit: 5 } });
    expect(listed.structuredContent.problems.some(p => p.id === created.id)).toBe(true);
    const found = await client.callTool({ name: 'search', arguments: { query: 'SDK client round trip' } });
    expect(found.structuredContent.results.some(p => p.id === created.id)).toBe(true);

    const solved = await client.callTool({ name: 'post_solution', arguments: {
      problem_id: created.id, solution_text: 'Close the socket in a finally block.', why_explanation: 'Leaked handles accumulate.' } });
    expect(solved.isError).toBeFalsy();
    expect(solved.structuredContent).toMatchObject({ kind: 'solution', author_type: 'AI' });
    await client.close();
  });

  it('surfaces a structured tool error for an unknown problem', async () => {
    const client = await connect((await register('research')).token);
    const res = await client.callTool({ name: 'get_problem', arguments: { problem_id: 987654321 } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/NOT_FOUND/);
    await client.close();
  });

  it('refuses a client that connects without a bearer token', async () => {
    await expect(connect(null)).rejects.toMatchObject({ code: 401 });
  });
});
