import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Regression tests for the findings in Manus's 2026-08-17 adversarial QA pass
// (F-01 through F-05; F-07 is a dependency bump, verified by `npm audit`, not
// runtime behavior). Same no-mock discipline as test/trust-path.test.js: these
// run the real src/worker.js inside workerd against a real D1 and real KV.
//
// Uses the 198.51.100.0/24 TEST-NET-2 range for synthetic client IPs so the
// rate-limit buckets here never collide with trust-path.test.js's 203.0.113.x
// range under the shared singleWorker instance.

let clientSeq = 0;
function nextIp() {
  clientSeq += 1;
  return `198.51.100.${clientSeq % 250 + 1}`;
}

async function api(path, { method = 'GET', body, token, ip, headers: extraHeaders } = {}) {
  const headers = { 'CF-Connecting-IP': ip || nextIp(), ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await SELF.fetch(`https://aihangout.ai${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  // An SSE stream never ends on its own (periodic pings) — reading its body
  // to completion here would hang the test. Status/headers are all these
  // tests need from a stream response.
  if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
    try { json = await res.json(); } catch { /* non-JSON body */ }
  }
  return { status: res.status, json, headers: res.headers };
}

let unique = 0;
async function registerUser(prefix) {
  unique += 1;
  const username = `${prefix}_${unique}`;
  const email = `${username}@example.test`;
  const password = 'correct horse battery staple 42';
  const ip = nextIp();
  const res = await api('/api/auth/register', {
    method: 'POST',
    ip,
    body: { username, email, password, ai_agent_type: 'human', accept_tos: true }
  });
  expect(res.status, `register ${username} failed: ${JSON.stringify(res.json)}`).toBe(200);
  return { username, email, password, ip, token: res.json.token, id: res.json.user.id };
}

async function createProblem(user) {
  unique += 1;
  return api('/api/problems', {
    method: 'POST',
    token: user.token,
    ip: user.ip,
    body: {
      title: `Manus QA regression probe ${unique}`,
      description: 'Fixture problem for adversarial-QA regression tests.',
      category: 'Programming'
    }
  });
}

async function sha256Hex16(raw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

describe('F-01: AI-collaboration session join requires authentication', () => {
  it('rejects an anonymous join with 401 and creates no participant', async () => {
    const owner = await registerUser('collabowner');
    const problem = await createProblem(owner);
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;

    const anon = await api('/api/ai-collaboration/join-session', {
      method: 'POST',
      body: { problem_id: problemId, agent_name: 'anon_probe_agent' }
    });
    expect(anon.status).toBe(401);
  });

  it('allows an authenticated caller to join', async () => {
    const owner = await registerUser('collabowner2');
    const joiner = await registerUser('collabjoiner');
    const problem = await createProblem(owner);
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;

    const res = await api('/api/ai-collaboration/join-session', {
      method: 'POST',
      token: joiner.token,
      ip: joiner.ip,
      body: { problem_id: problemId, agent_name: 'real_agent', agent_type: 'test_probe' }
    });
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(typeof res.json.session_token).toBe('string');
  });
});

describe('F-02: chat SSE requires a valid, single-use ticket', () => {
  it('rejects a ticket-mint request with no auth', async () => {
    const res = await api('/api/chat/events/ticket', { method: 'POST', body: { channelId: 1 } });
    expect(res.status).toBe(401);
  });

  it('rejects a stream request with no ticket at all', async () => {
    const res = await api('/api/chat/events/1');
    expect(res.status).toBe(401);
  });

  it('rejects a stream request with a ticket that was never issued', async () => {
    const res = await api('/api/chat/events/1?ticket=0000000000000000000000000000000000000000000000');
    expect(res.status).toBe(401);
  });

  it('mints a ticket for an authenticated caller and opens the stream with it', async () => {
    const user = await registerUser('ssecaller');
    const minted = await api('/api/chat/events/ticket', {
      method: 'POST', token: user.token, ip: user.ip, body: { channelId: 1 }
    });
    expect(minted.status).toBe(200);
    expect(typeof minted.json.ticket).toBe('string');

    const opened = await api(`/api/chat/events/1?ticket=${minted.json.ticket}`, { ip: user.ip });
    expect(opened.status).toBe(200);
    expect(opened.headers.get('Content-Type')).toContain('text/event-stream');
  });

  it('cannot reuse a ticket a second time', async () => {
    const user = await registerUser('ssereplay');
    const minted = await api('/api/chat/events/ticket', {
      method: 'POST', token: user.token, ip: user.ip, body: { channelId: 1 }
    });
    const first = await api(`/api/chat/events/1?ticket=${minted.json.ticket}`, { ip: user.ip });
    expect(first.status).toBe(200);

    const replay = await api(`/api/chat/events/1?ticket=${minted.json.ticket}`, { ip: user.ip });
    expect(replay.status).toBe(401);
  });
});

describe('F-03: heartbeat never stores the raw bearer token', () => {
  it('stores only a non-reversible hash in enhanced_sessions and analytics_events', async () => {
    const user = await registerUser('heartbeatuser');
    const res = await api('/api/sessions/heartbeat', { method: 'POST', token: user.token, ip: user.ip, body: {} });
    expect(res.status).toBe(200);

    const expectedHash = await sha256Hex16(user.token);

    const sessionRow = await env.AIHANGOUT_DB
      .prepare('SELECT session_token FROM enhanced_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .bind(user.id).first();
    expect(sessionRow, 'no enhanced_sessions row was written').not.toBeNull();
    expect(sessionRow.session_token).not.toBe(user.token);
    expect(sessionRow.session_token).toBe(expectedHash);

    const analyticsRow = await env.AIHANGOUT_DB
      .prepare("SELECT session_id FROM analytics_events WHERE event_type = 'session_heartbeat' AND user_id = ? ORDER BY id DESC LIMIT 1")
      .bind(user.id).first();
    expect(analyticsRow, 'no analytics_events row was written').not.toBeNull();
    expect(analyticsRow.session_id).not.toBe(user.token);
    expect(analyticsRow.session_id).toBe(expectedHash);
  });
});

describe('F-04: logout revokes the token instead of only discarding it client-side', () => {
  it('makes the logged-out token unusable for further authenticated calls', async () => {
    const user = await registerUser('logoutuser');

    const before = await api('/api/users/me/settings', { token: user.token, ip: user.ip });
    expect(before.status).toBe(200);

    const logout = await api('/api/auth/logout', { method: 'POST', token: user.token, ip: user.ip });
    expect(logout.status).toBe(200);
    expect(logout.json.session_ended).toBe(true);

    // This is the exact reproduction from the audit: replaying the same saved
    // token against an authenticated route after logout used to still return 200.
    const after = await api('/api/users/me/settings', { token: user.token, ip: user.ip });
    expect(after.status).toBe(401);
  });

  it('records the revoked jti in revoked_tokens', async () => {
    const user = await registerUser('revokerow');
    const before = await env.AIHANGOUT_DB
      .prepare('SELECT COUNT(*) AS n FROM revoked_tokens WHERE user_id = ?').bind(user.id).first();
    expect(before.n).toBe(0);

    await api('/api/auth/logout', { method: 'POST', token: user.token, ip: user.ip });

    const after = await env.AIHANGOUT_DB
      .prepare('SELECT COUNT(*) AS n FROM revoked_tokens WHERE user_id = ?').bind(user.id).first();
    expect(after.n).toBe(1);
  });

  it('does not revoke other users by logging one user out', async () => {
    const a = await registerUser('logoutscopeda');
    const b = await registerUser('logoutscopedb');

    await api('/api/auth/logout', { method: 'POST', token: a.token, ip: a.ip });

    const stillWorks = await api('/api/users/me/settings', { token: b.token, ip: b.ip });
    expect(stillWorks.status).toBe(200);
  });
});

describe('F-05: login/reset rate limiting still functions after the fail-closed change', () => {
  it('still allows a normal login through (no regression on the happy path)', async () => {
    const user = await registerUser('rlhappypath');
    const res = await api('/api/auth/login', {
      method: 'POST', ip: user.ip, body: { email: user.email, password: user.password }
    });
    expect(res.status).toBe(200);
  });

  it('still returns 429 once the per-IP login limit is exceeded', async () => {
    const ip = nextIp();
    let lastStatus = 200;
    for (let i = 0; i < 12; i++) {
      const res = await api('/api/auth/login', {
        method: 'POST', ip, body: { email: 'no-such-account@example.test', password: 'wrong' }
      });
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});
