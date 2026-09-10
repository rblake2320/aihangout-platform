import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Regression: a vote appeared applied and then reverted after the feed refetch
// (home) or a reload (detail page). Root cause: no read endpoint returned the
// caller's own vote, so the client had nothing to re-hydrate the highlight from.
// These tests hit the real handlers inside workerd against a real D1.

let clientSeq = 0;
function nextIp() {
  clientSeq += 1;
  return `203.0.113.${clientSeq % 250 + 1}`;
}

async function api(path, { method = 'GET', body, token, ip } = {}) {
  const headers = { 'CF-Connecting-IP': ip || nextIp() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await SELF.fetch(`https://aihangout.ai${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

let unique = 0;
async function registerUser(prefix) {
  unique += 1;
  const username = `${prefix}_c0910_${unique}`;
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

async function createProblem(user, overrides = {}) {
  return api('/api/problems', {
    method: 'POST',
    token: user.token,
    ip: user.ip,
    body: {
      title: 'Worker returns 500 on concurrent D1 writes',
      description: 'Two simultaneous writes to the same row intermittently produce a 500.',
      category: 'Programming',
      ...overrides
    }
  });
}

async function setupVotedProblem() {
  const owner = await registerUser('c0910owner');
  // Under the test runtime BETA_MODE=true, so a human's first post lands as
  // 'approved' (see the first-post gate in POST /api/problems). Assert that so
  // a config change cannot silently turn these tests into a 404 hunt.
  const created = await createProblem(owner, { title: `user_vote probe ${unique}` });
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  const problemId = created.json.problemId ?? created.json.problem?.id ?? created.json.id;
  expect(problemId).toBeDefined();

  const voter = await registerUser('c0910voter');
  const vote = await api('/api/vote', {
    method: 'POST', token: voter.token, ip: voter.ip,
    body: { targetType: 'problem', targetId: problemId, voteType: 'up' }
  });
  expect(vote.status, JSON.stringify(vote.json)).toBe(200);
  expect(vote.json.currentVote).toBe('up');
  return { owner, voter, problemId };
}

describe('GET /api/problems/:id returns the caller\'s own vote', () => {
  it('reports user_vote "up" to the voter after they upvoted', async () => {
    const { voter, problemId } = await setupVotedProblem();

    const detail = await api(`/api/problems/${problemId}`, { token: voter.token, ip: voter.ip });

    expect(detail.status).toBe(200);
    expect(detail.json.problem.upvotes).toBe(1);
    expect(detail.json.problem.user_vote).toBe('up');
  });

  it('reports user_vote "down" after the voter switches to a downvote', async () => {
    const { voter, problemId } = await setupVotedProblem();
    const down = await api('/api/vote', {
      method: 'POST', token: voter.token, ip: voter.ip,
      body: { targetType: 'problem', targetId: problemId, voteType: 'down' }
    });
    expect(down.status).toBe(200);

    const detail = await api(`/api/problems/${problemId}`, { token: voter.token, ip: voter.ip });

    expect(detail.json.problem.user_vote).toBe('down');
    expect(detail.json.problem.upvotes).toBe(0);
  });

  it('reports user_vote null to the owner, who has not voted', async () => {
    const { owner, problemId } = await setupVotedProblem();

    const detail = await api(`/api/problems/${problemId}`, { token: owner.token, ip: owner.ip });

    expect(detail.status).toBe(200);
    expect(detail.json.problem.upvotes).toBe(1); // someone else's vote is still counted
    expect(detail.json.problem.user_vote).toBeNull();
  });

  it('reports user_vote null to an anonymous reader and never leaks another user\'s vote', async () => {
    const { problemId } = await setupVotedProblem();

    const detail = await api(`/api/problems/${problemId}`);

    expect(detail.status).toBe(200);
    expect(detail.json.problem.upvotes).toBe(1);
    expect(detail.json.problem.user_vote).toBeNull();
  });

  it('attaches user_vote to every solution in the thread', async () => {
    const { voter, problemId } = await setupVotedProblem();
    const solver = await registerUser('c0910solver');
    const solution = await api(`/api/problems/${problemId}/solutions`, {
      method: 'POST', token: solver.token, ip: solver.ip,
      body: { solutionText: 'Use batch().', whyExplanation: 'Atomic.' }
    });
    expect(solution.status).toBe(200);

    // Voter has voted on the problem but not on the solution.
    const detail = await api(`/api/problems/${problemId}`, { token: voter.token, ip: voter.ip });
    const sol = detail.json.solutions.find((s) => s.id === solution.json.solutionId);
    expect(sol).toBeDefined();
    expect(sol.user_vote).toBeNull();
    expect(detail.json.problem.user_vote).toBe('up');
  });
});

describe('GET /api/problems (list) returns the caller\'s own vote per entry', () => {
  it('marks the voted problem user_vote "up" for the authenticated voter', async () => {
    const { voter, problemId } = await setupVotedProblem();

    const list = await api('/api/problems?limit=50&sortBy=new', { token: voter.token, ip: voter.ip });

    expect(list.status).toBe(200);
    const entry = list.json.problems.find((p) => p.id === problemId);
    expect(entry, `problem ${problemId} missing from list page: ${JSON.stringify(list.json.problems.map(p => p.id))}`).toBeDefined();
    expect(entry.user_vote).toBe('up');
    // Un-voted problems on the same page stay null (no cross-contamination).
    for (const p of list.json.problems) {
      if (p.id !== problemId) expect(p.user_vote).toBeNull();
    }
  });

  it('returns user_vote null on every entry for an anonymous (cacheable) request', async () => {
    const { problemId } = await setupVotedProblem();

    const list = await api('/api/problems?limit=50&sortBy=new');

    expect(list.status).toBe(200);
    const entry = list.json.problems.find((p) => p.id === problemId);
    expect(entry).toBeDefined();
    expect(entry.user_vote).toBeNull();
  });
});
