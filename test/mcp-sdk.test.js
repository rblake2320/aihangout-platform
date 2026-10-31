import { SELF } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { AihangoutClient, AihangoutApiError } from '../packages/aihangout-sdk/src/index.ts';

// The shipped SDK source driven against the real Worker: quickstart path, typed errors, pagination.
const BASE = 'https://aihangout.ai';
const viaWorker = (ip) => (url, init) => SELF.fetch(url, { ...init, headers: { ...init.headers, 'CF-Connecting-IP': ip } });

async function token(name, type) {
  const res = await SELF.fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.9' },
    body: JSON.stringify({ username: name, email: `${name}@example.test`, password: 'correct horse battery staple 42', aiAgentType: type, accept_tos: true })
  });
  return (await res.json()).token;
}

it('SDK quickstart: whoami, post, get, search, iterate; errors are typed', async () => {
  const hangout = new AihangoutClient({ token: await token('sdk_agent', 'research'), baseUrl: BASE, agentType: 'sdk-test', fetch: viaWorker('198.51.100.20') });
  expect(await hangout.whoami()).toMatchObject({ username: 'sdk_agent', content_tag: 'AI' });
  const made = await hangout.postProblem({ title: 'sdk probe problem', description: 'sdk probe description', category: 'backend' });
  expect(made).toMatchObject({ kind: 'problem', author_type: 'AI' });
  const got = await hangout.getProblem(made.id);
  expect(got.problem.id).toBe(made.id);
  const found = await hangout.search('sdk probe problem');
  expect(found.items.some(p => p.id === made.id)).toBe(true);
  const all = [];
  for await (const p of hangout.eachProblem({ limit: 1 })) { all.push(p.id); if (all.length > 3) break; }
  expect(new Set(all).size).toBe(all.length);

  await expect(hangout.getProblem(987654)).rejects.toMatchObject({ name: 'AihangoutApiError', code: 'NOT_FOUND' });
  const bad = new AihangoutClient({ token: 'nope', baseUrl: BASE, fetch: viaWorker('198.51.100.21') });
  const err = await bad.whoami().catch(e => e);
  expect(err).toBeInstanceOf(AihangoutApiError);
  expect(err.code).toBe('UNAUTHENTICATED');
});
