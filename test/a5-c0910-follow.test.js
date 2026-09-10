import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// A5 closure C0910: follow/unfollow returned HTTP 415.
//
// The frontend's followAPI.toggle sent a body-less POST; axios strips Content-Type
// on an empty body, and the global guard in the Worker fetch() rejected every
// POST/PUT/PATCH on /api/* without application/json before the route ran.
//
// These tests run the real src/worker.js inside workerd against a real D1 with the
// real migrations. No mocks. Same helper conventions as test/trust-path.test.js.

let clientSeq = 0;
function nextIp() {
  clientSeq += 1;
  return `203.0.113.${clientSeq % 250 + 1}`;
}

async function api(path, { method = 'GET', body, token, ip, rawBody, contentType } = {}) {
  const headers = { 'CF-Connecting-IP': ip || nextIp() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (contentType !== undefined) headers['Content-Type'] = contentType;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await SELF.fetch(`https://aihangout.ai${path}`, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body))
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
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
    body: { username, email, password, ai_agent_type: 'human' }
  });
  expect(res.status, `register ${username} failed: ${JSON.stringify(res.json)}`).toBe(200);
  expect(res.json.success).toBe(true);
  return { username, email, password, ip, token: res.json.token, id: res.json.user.id };
}

describe('follow toggle survives a body-less POST (C0910)', () => {
  it('follows then unfollows with no body and no Content-Type', async () => {
    const a = await registerUser('follower');
    const b = await registerUser('followee');

    // Exactly what axios sends for api.post(url) with no data: no body, no Content-Type.
    const follow = await api(`/api/users/${b.id}/follow`, {
      method: 'POST',
      token: a.token,
      ip: a.ip
    });
    expect(follow.status, `follow failed: ${JSON.stringify(follow.json)}`).toBe(200);
    expect(follow.json.success).toBe(true);
    expect(follow.json.following).toBe(true);

    const unfollow = await api(`/api/users/${b.id}/follow`, {
      method: 'POST',
      token: a.token,
      ip: a.ip
    });
    expect(unfollow.status, `unfollow failed: ${JSON.stringify(unfollow.json)}`).toBe(200);
    expect(unfollow.json.success).toBe(true);
    expect(unfollow.json.following).toBe(false);
  });

  it('still works when the frontend sends an empty JSON object body', async () => {
    const a = await registerUser('follower_json');
    const b = await registerUser('followee_json');

    const follow = await api(`/api/users/${b.id}/follow`, {
      method: 'POST',
      token: a.token,
      ip: a.ip,
      body: {}
    });
    expect(follow.status).toBe(200);
    expect(follow.json.following).toBe(true);
  });
});

describe('the Content-Type guard is otherwise unchanged (C0910 negative bounds)', () => {
  it('rejects POST /api/problems with a text body and no JSON Content-Type', async () => {
    const a = await registerUser('guard_text');
    const res = await api('/api/problems', {
      method: 'POST',
      token: a.token,
      ip: a.ip,
      rawBody: 'title=hello&description=world',
      contentType: 'text/plain'
    });
    expect(res.status).toBe(415);
    expect(res.json).toEqual({ success: false, error: 'Content-Type must be application/json' });
  });

  it('rejects a body-less POST to a non-allowlisted mutation path', async () => {
    const a = await registerUser('guard_empty');
    const res = await api('/api/problems/1/solutions', {
      method: 'POST',
      token: a.token,
      ip: a.ip
    });
    expect(res.status).toBe(415);
    expect(res.json).toEqual({ success: false, error: 'Content-Type must be application/json' });
  });

  it('does not widen the allowance to sibling user paths', async () => {
    const a = await registerUser('guard_sibling');
    // Same prefix, different tail: must still hit the guard.
    const res = await api(`/api/users/${a.id}/follow/extra`, {
      method: 'POST',
      token: a.token,
      ip: a.ip
    });
    expect(res.status).toBe(415);
  });
});
