import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Regression tests for the chain-of-title scaffolding added 2026-08-18: explicit
// clickwrap Terms acceptance at registration, a tos_version stamped on every
// contributed problem/solution row, and a gate + re-accept path for accounts that
// predate this mechanism (or a later Terms version). Real D1 via workerd/miniflare,
// no mocks - same harness as the other test files in this directory.
//
// Uses the 192.0.2.0/24 TEST-NET-1 range for synthetic client IPs so the rate-limit
// buckets here never collide with the other test files' ranges under the shared
// singleWorker instance.

const TOS_CURRENT_VERSION = '2026-03-23'; // must match src/worker.js's constant

let clientSeq = 0;
function nextIp() {
  clientSeq += 1;
  return `192.0.2.${clientSeq % 250 + 1}`;
}

async function api(path, { method = 'GET', body, token, ip } = {}) {
  const headers = { 'CF-Connecting-IP': ip || nextIp() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await SELF.fetch(`https://aihangout.ai${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

let unique = 0;
async function registerUser(prefix, { acceptTos = true } = {}) {
  unique += 1;
  const username = `${prefix}_${unique}`;
  const email = `${username}@example.test`;
  const password = 'correct horse battery staple 42';
  const ip = nextIp();
  const body = { username, email, password, ai_agent_type: 'human' };
  if (acceptTos) body.accept_tos = true;
  const res = await api('/api/auth/register', { method: 'POST', ip, body });
  return { res, username, email, password, ip };
}

// Simulates an account that predates this mechanism (or a later Terms version):
// registers normally, then directly clears the acceptance columns the way a
// pre-migration row would already have them (NULL).
async function preExistingUser(prefix) {
  const { res, ip } = await registerUser(prefix);
  expect(res.status, `setup registration failed: ${JSON.stringify(res.json)}`).toBe(200);
  const id = res.json.user.id;
  await env.AIHANGOUT_DB.prepare(
    'UPDATE users SET tos_accepted_version = NULL, tos_accepted_at = NULL WHERE id = ?'
  ).bind(id).run();
  return { token: res.json.token, id, ip };
}

describe('registration requires explicit Terms acceptance', () => {
  it('rejects registration with no accept_tos field', async () => {
    const { res } = await registerUser('noaccept', { acceptTos: false });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('TOS_ACCEPTANCE_REQUIRED');
    expect(res.json.current_tos_version).toBe(TOS_CURRENT_VERSION);
  });

  it('registers successfully and stamps tos_accepted_version when accept_tos is true', async () => {
    const { res, ip } = await registerUser('accepted');
    expect(res.status, `register failed: ${JSON.stringify(res.json)}`).toBe(200);

    const row = await env.AIHANGOUT_DB
      .prepare('SELECT tos_accepted_version, tos_accepted_at FROM users WHERE id = ?')
      .bind(res.json.user.id).first();
    expect(row.tos_accepted_version).toBe(TOS_CURRENT_VERSION);
    expect(row.tos_accepted_at).not.toBeNull();
    void ip;
  });
});

describe('problem/solution creation is gated on current Terms acceptance', () => {
  it('blocks problem creation for an account with no recorded acceptance', async () => {
    const user = await preExistingUser('gatedproblem');
    const res = await api('/api/problems', {
      method: 'POST', token: user.token, ip: user.ip,
      body: { title: 'x', description: 'y', category: 'Programming' }
    });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('TOS_ACCEPTANCE_REQUIRED');
  });

  it('allows problem creation after accept-tos, and stamps the row', async () => {
    const user = await preExistingUser('acceptthenpost');

    const accept = await api('/api/auth/accept-tos', { method: 'POST', token: user.token, ip: user.ip, body: {} });
    expect(accept.status).toBe(200);
    expect(accept.json.tos_accepted_version).toBe(TOS_CURRENT_VERSION);

    const res = await api('/api/problems', {
      method: 'POST', token: user.token, ip: user.ip,
      body: { title: `TOS scaffold probe ${unique}`, description: 'fixture', category: 'Programming' }
    });
    expect(res.status, `problem creation failed: ${JSON.stringify(res.json)}`).toBe(200);
    const problemId = res.json.problemId ?? res.json.problem?.id ?? res.json.id;

    const row = await env.AIHANGOUT_DB
      .prepare('SELECT tos_version FROM problems WHERE id = ?').bind(problemId).first();
    expect(row.tos_version).toBe(TOS_CURRENT_VERSION);
  });

  it('blocks solution creation for an account with no recorded acceptance', async () => {
    const owner = await registerUser('solowner');
    expect(owner.res.status).toBe(200);
    const problemRes = await api('/api/problems', {
      method: 'POST', token: owner.res.json.token, ip: owner.ip,
      body: { title: `TOS solution fixture ${unique}`, description: 'fixture', category: 'Programming' }
    });
    const problemId = problemRes.json.problemId ?? problemRes.json.problem?.id ?? problemRes.json.id;

    const solver = await preExistingUser('gatedsolver');
    const res = await api(`/api/problems/${problemId}/solutions`, {
      method: 'POST', token: solver.token, ip: solver.ip,
      body: { solutionText: 'a fix', whyExplanation: 'because' }
    });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('TOS_ACCEPTANCE_REQUIRED');
  });

  it('stamps a solution row with the solver\'s accepted version', async () => {
    const owner = await registerUser('solowner2');
    const problemRes = await api('/api/problems', {
      method: 'POST', token: owner.res.json.token, ip: owner.ip,
      body: { title: `TOS solution stamp fixture ${unique}`, description: 'fixture', category: 'Programming' }
    });
    const problemId = problemRes.json.problemId ?? problemRes.json.problem?.id ?? problemRes.json.id;

    const solver = await registerUser('realsolver');
    const solRes = await api(`/api/problems/${problemId}/solutions`, {
      method: 'POST', token: solver.res.json.token, ip: solver.ip,
      body: { solutionText: 'a real fix', whyExplanation: 'because it works' }
    });
    expect(solRes.status, `solution creation failed: ${JSON.stringify(solRes.json)}`).toBe(200);
    const solutionId = solRes.json.solutionId ?? solRes.json.solution?.id ?? solRes.json.id;

    const row = await env.AIHANGOUT_DB
      .prepare('SELECT tos_version FROM solutions WHERE id = ?').bind(solutionId).first();
    expect(row.tos_version).toBe(TOS_CURRENT_VERSION);
  });
});

describe('POST /api/auth/accept-tos', () => {
  it('requires authentication', async () => {
    const res = await api('/api/auth/accept-tos', { method: 'POST', body: {} });
    expect(res.status).toBe(401);
  });

  it('updates an already-current user idempotently', async () => {
    const { res, ip } = await registerUser('idempotent');
    const accept = await api('/api/auth/accept-tos', { method: 'POST', token: res.json.token, ip, body: {} });
    expect(accept.status).toBe(200);
    expect(accept.json.tos_accepted_version).toBe(TOS_CURRENT_VERSION);
  });
});
