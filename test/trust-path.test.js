import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

// These tests run the real src/worker.js inside workerd against a real D1 database
// with the real migrations applied. Nothing here is mocked or stubbed: every
// assertion is the actual HTTP response the deployed Worker would produce.
//
// They cover the "trust path" — the chain that has to be correct for this platform's
// core claim (human-validated answers) to mean anything: register -> login ->
// post problem -> post solution -> vote -> human-verify.
//
// Rate limiting is real and enforced (post: 3/min/user, 5/min/IP; vote: 10/min/user).
// Each simulated client therefore gets its own CF-Connecting-IP so that tests
// exercise business logic instead of colliding in the shared IP bucket.

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

describe('auth', () => {
  it('registers a user and logs that same user back in', async () => {
    const user = await registerUser('authuser');

    const login = await api('/api/auth/login', {
      method: 'POST',
      ip: user.ip,
      body: { email: user.email, password: user.password }
    });

    expect(login.status).toBe(200);
    expect(login.json.success).toBe(true);
    expect(typeof login.json.token).toBe('string');
    expect(login.json.token.length).toBeGreaterThan(20);
  });

  it('logs in with the username as well as the email', async () => {
    const user = await registerUser('byusername');

    const byUsername = await api('/api/auth/login', {
      method: 'POST',
      ip: user.ip,
      body: { username: user.username, password: user.password }
    });

    // Registration requires a username, so users reasonably treat it as their
    // credential. Login previously matched on email only and gave them no way in.
    expect(byUsername.status).toBe(200);
    expect(byUsername.json.success).toBe(true);
    expect(typeof byUsername.json.token).toBe('string');
  });

  it('matches the username case-insensitively', async () => {
    const user = await registerUser('CaseCheck');

    const upper = await api('/api/auth/login', {
      method: 'POST',
      ip: user.ip,
      body: { username: user.username.toUpperCase(), password: user.password }
    });

    expect(upper.status).toBe(200);
  });

  it('still rejects an unknown username without leaking that it is unknown', async () => {
    const unknown = await api('/api/auth/login', {
      method: 'POST',
      ip: nextIp(),
      body: { username: 'no_such_username_at_all', password: 'whatever it is' }
    });
    const knownUser = await registerUser('leakcheck');
    const wrongPass = await api('/api/auth/login', {
      method: 'POST',
      ip: knownUser.ip,
      body: { username: knownUser.username, password: 'wrong password entirely' }
    });

    expect(unknown.status).toBe(401);
    expect(wrongPass.status).toBe(401);
    // Widening login to usernames must not open a username-enumeration oracle.
    expect(unknown.json.error).toBe(wrongPass.json.error);
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const user = await registerUser('authwrong');

    const bad = await api('/api/auth/login', {
      method: 'POST',
      ip: user.ip,
      body: { email: user.email, password: 'definitely not the password' }
    });
    const unknown = await api('/api/auth/login', {
      method: 'POST',
      ip: nextIp(),
      body: { email: 'no-such-account@example.test', password: 'definitely not the password' }
    });

    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    // Same status and same message for "wrong password" and "no such user" —
    // otherwise login becomes an account-enumeration oracle.
    expect(bad.json.error).toBe(unknown.json.error);
  });

  it('requires authentication to post a problem', async () => {
    const res = await api('/api/problems', {
      method: 'POST',
      body: { title: 'x', description: 'y', category: 'Programming' }
    });
    expect(res.status).toBe(401);
  });
});

describe('problem ingest', () => {
  it('creates a problem', async () => {
    const user = await registerUser('poster');
    const res = await createProblem(user);
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
  });

  it('rejects the same user submitting identical content twice (ingest dedup)', async () => {
    const user = await registerUser('duper');

    const first = await createProblem(user, { title: 'Duplicate submission probe' });
    expect(first.status).toBe(200);

    const second = await createProblem(user, { title: 'Duplicate submission probe' });

    // Regression guard: problems 277 and 278 in production are byte-identical
    // rows created 2 seconds apart because dedup only covered external_id.
    expect(second.status).toBe(409);
    expect(second.json.success).toBe(false);
    expect(second.json.duplicate_of).toBeDefined();
  });

  it('treats differing whitespace/case as the same content', async () => {
    const user = await registerUser('dupecase');
    const first = await createProblem(user, { title: 'Whitespace Probe' });
    expect(first.status).toBe(200);

    const second = await createProblem(user, { title: '  whitespace probe  ' });
    expect(second.status).toBe(409);
  });

  it('allows a different user to post the same problem', async () => {
    const userA = await registerUser('shareA');
    const userB = await registerUser('shareB');

    const a = await createProblem(userA, { title: 'Independently common issue' });
    const b = await createProblem(userB, { title: 'Independently common issue' });

    // Dedup is scoped per user on purpose: two people hitting the same bug is
    // signal, not spam.
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe('solution contract', () => {
  it('accepts camelCase and snake_case field names', async () => {
    const owner = await registerUser('solowner');
    const problem = await createProblem(owner, { title: 'Field casing probe' });
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;
    expect(problemId, `could not read problem id from ${JSON.stringify(problem.json)}`).toBeDefined();

    const camelAuthor = await registerUser('camel');
    const camel = await api(`/api/problems/${problemId}/solutions`, {
      method: 'POST',
      token: camelAuthor.token,
      ip: camelAuthor.ip,
      body: { solutionText: 'Wrap both writes in a single D1 batch.', whyExplanation: 'batch() is one transaction.' }
    });
    expect(camel.status).toBe(200);
    expect(camel.json.success).toBe(true);

    const snakeAuthor = await registerUser('snake');
    const snake = await api(`/api/problems/${problemId}/solutions`, {
      method: 'POST',
      token: snakeAuthor.token,
      ip: snakeAuthor.ip,
      body: { solution_text: 'Add a UNIQUE index as a backstop.', why_explanation: 'DB-level guarantee.' }
    });
    // The handler previously read only camelCase while its 400 message named
    // solution_text, so a client that believed the error text could never succeed.
    expect(snake.status).toBe(200);
    expect(snake.json.success).toBe(true);
  });

  it('names a field the caller can actually send when the body is empty', async () => {
    const owner = await registerUser('emptybody');
    const problem = await createProblem(owner, { title: 'Empty solution probe' });
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;

    const author = await registerUser('emptyauthor');
    const res = await api(`/api/problems/${problemId}/solutions`, {
      method: 'POST',
      token: author.token,
      ip: author.ip,
      body: { whyExplanation: 'no solution text supplied' }
    });

    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/solutionText/);
  });
});

describe('voting', () => {
  async function setupSolution() {
    const owner = await registerUser('voteowner');
    const problem = await createProblem(owner, { title: `Vote probe ${unique}` });
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;

    const solver = await registerUser('votesolver');
    const solution = await api(`/api/problems/${problemId}/solutions`, {
      method: 'POST',
      token: solver.token,
      ip: solver.ip,
      body: { solutionText: 'Use batch().', whyExplanation: 'Atomic.' }
    });
    expect(solution.status).toBe(200);
    return { owner, solver, problemId, solutionId: solution.json.solutionId };
  }

  it('blocks voting on your own content', async () => {
    const { solver, solutionId } = await setupSolution();

    const res = await api('/api/vote', {
      method: 'POST',
      token: solver.token,
      ip: solver.ip,
      body: { targetType: 'solution', targetId: solutionId, voteType: 'up' }
    });

    expect(res.status).toBe(403);
  });

  it('counts a repeated upvote from the same user only once', async () => {
    const { owner, solutionId, problemId } = await setupSolution();

    const first = await api('/api/vote', {
      method: 'POST', token: owner.token, ip: owner.ip,
      body: { targetType: 'solution', targetId: solutionId, voteType: 'up' }
    });
    expect(first.status).toBe(200);

    const second = await api('/api/vote', {
      method: 'POST', token: owner.token, ip: owner.ip,
      body: { targetType: 'solution', targetId: solutionId, voteType: 'up' }
    });
    expect(second.status).toBe(200);

    // Upvotes are recomputed from the votes table, so a duplicate row would
    // show up here as an inflated count.
    const thread = await api(`/api/problems/${problemId}`);
    const solution = thread.json.solutions.find((s) => s.id === solutionId);
    expect(solution.upvotes).toBe(1);
  });

  it('switching from up to down leaves exactly one vote', async () => {
    const { owner, solutionId, problemId } = await setupSolution();

    await api('/api/vote', {
      method: 'POST', token: owner.token, ip: owner.ip,
      body: { targetType: 'solution', targetId: solutionId, voteType: 'up' }
    });
    await api('/api/vote', {
      method: 'POST', token: owner.token, ip: owner.ip,
      body: { targetType: 'solution', targetId: solutionId, voteType: 'down' }
    });

    const thread = await api(`/api/problems/${problemId}`);
    const solution = thread.json.solutions.find((s) => s.id === solutionId);
    expect(solution.upvotes).toBe(0);
  });
});

describe('human verification', () => {
  async function setupForVerification() {
    const owner = await registerUser('verowner');
    const problem = await createProblem(owner, { title: `Verify probe ${unique}` });
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;

    const solver = await registerUser('versolver');
    const solution = await api(`/api/problems/${problemId}/solutions`, {
      method: 'POST',
      token: solver.token,
      ip: solver.ip,
      body: { solutionText: 'Documented fix.', whyExplanation: 'Explains the mechanism.' }
    });
    return { owner, solver, problemId, solutionId: solution.json.solutionId };
  }

  it('lets the problem owner verify someone else\'s solution', async () => {
    const { owner, problemId, solutionId } = await setupForVerification();

    const res = await api(`/api/problems/${problemId}/solutions/${solutionId}/accept`, {
      method: 'POST', token: owner.token, ip: owner.ip, body: {}
    });

    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.verification_type).toBe('human_owner');

    const thread = await api(`/api/problems/${problemId}`);
    const solution = thread.json.solutions.find((s) => s.id === solutionId);
    expect(solution.is_verified).toBe(1);
  });

  it('refuses to let an author verify their own solution', async () => {
    const { solver, problemId, solutionId } = await setupForVerification();

    const res = await api(`/api/problems/${problemId}/solutions/${solutionId}/accept`, {
      method: 'POST', token: solver.token, ip: solver.ip, body: {}
    });

    // The whole value proposition is that verification is independent of authorship.
    expect(res.status).toBe(403);
  });

  it('refuses verification by an unrelated third party', async () => {
    const { problemId, solutionId } = await setupForVerification();
    const stranger = await registerUser('stranger');

    const res = await api(`/api/problems/${problemId}/solutions/${solutionId}/accept`, {
      method: 'POST', token: stranger.token, ip: stranger.ip, body: {}
    });

    expect(res.status).toBe(403);
  });

  it('keeps at most one verified solution per problem', async () => {
    const { owner, problemId, solutionId } = await setupForVerification();

    const second = await registerUser('secondsolver');
    const otherSolution = await api(`/api/problems/${problemId}/solutions`, {
      method: 'POST', token: second.token, ip: second.ip,
      body: { solutionText: 'A better fix.', whyExplanation: 'Simpler.' }
    });

    await api(`/api/problems/${problemId}/solutions/${solutionId}/accept`, {
      method: 'POST', token: owner.token, ip: owner.ip, body: {}
    });
    await api(`/api/problems/${problemId}/solutions/${otherSolution.json.solutionId}/accept`, {
      method: 'POST', token: owner.token, ip: owner.ip, body: {}
    });

    const thread = await api(`/api/problems/${problemId}`);
    const verified = thread.json.solutions.filter((s) => s.is_verified === 1);
    expect(verified).toHaveLength(1);
    expect(verified[0].id).toBe(otherSolution.json.solutionId);
  });
});

describe('activity log', () => {
  // The log is written from ctx.waitUntil, so it lands just after the response.
  // Poll the DB directly rather than sleeping a fixed amount.
  async function waitForEntry(predicate, attempts = 40) {
    const { env } = await import('cloudflare:test');
    for (let i = 0; i < attempts; i++) {
      const rows = await env.AIHANGOUT_DB
        .prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT 60').all();
      const hit = (rows.results || []).find(predicate);
      if (hit) return hit;
      await new Promise(r => setTimeout(r, 25));
    }
    return null;
  }

  it('records an accepted problem submission with its payload', async () => {
    const user = await registerUser('logaccept');
    const title = `Activity log accepted probe ${unique}`;
    const res = await createProblem(user, { title });
    expect(res.status).toBe(200);

    const entry = await waitForEntry(e => e.action === 'problem.create' && (e.payload || '').includes(title));
    expect(entry, 'no activity_log row for the accepted submission').not.toBeNull();
    expect(entry.outcome).toBe('accepted');
    expect(entry.http_status).toBe(200);
    expect(entry.user_id).toBe(user.id);
    expect(entry.quarantined).toBe(0);
  });

  it('records a REJECTED submission, preserving the content that was refused', async () => {
    const user = await registerUser('logreject');
    const title = `Activity log duplicate probe ${unique}`;
    await createProblem(user, { title });
    const dup = await createProblem(user, { title });
    expect(dup.status).toBe(409);

    // Match on this test's own title — other tests also produce 409s, and a loose
    // predicate would happily assert against theirs.
    const entry = await waitForEntry(e =>
      e.outcome === 'rejected' && e.http_status === 409 && (e.payload || '').includes(title));
    // The whole point: a refused submission leaves no row in `problems`, so without
    // this log the content and the reason would both be gone.
    expect(entry, 'no activity_log row for the rejected submission').not.toBeNull();
    expect(entry.reason).toMatch(/already submitted/i);
    expect(entry.payload).toContain(title);
    expect(entry.quarantined).toBe(1);
    expect(entry.quarantine_reason).toBe('rejected_409');
  });

  it('records deletions so content cannot vanish without a trace', async () => {
    const user = await registerUser('logdelete');
    const created = await createProblem(user, { title: `Activity log delete probe ${unique}` });
    const problemId = created.json.problemId ?? created.json.problem?.id ?? created.json.id;

    await api(`/api/problems/${problemId}`, { method: 'DELETE', token: user.token, ip: user.ip, body: {} });

    const entry = await waitForEntry(e => e.action === 'problem.delete' && e.target_id === problemId);
    expect(entry, 'a delete left no audit trail').not.toBeNull();
    expect(entry.user_id).toBe(user.id);
  });

  it('never stores passwords or tokens', async () => {
    const secret = 'SuperSecretPassphrase!2026';
    await api('/api/auth/login', {
      method: 'POST',
      ip: nextIp(),
      body: { email: 'nobody-at-all@example.test', password: secret }
    });

    const entry = await waitForEntry(e => e.path === '/api/auth/login');
    expect(entry, 'login attempt was not logged').not.toBeNull();
    // Redaction is the reason this table is safe to keep forever.
    expect(entry.payload).not.toContain(secret);
    expect(entry.payload).toContain('[REDACTED]');
  });

  it('attributes a FAILED login to the account that was targeted', async () => {
    const target = `brute_target_${unique}_${Date.now()}`;
    await api('/api/auth/login', {
      method: 'POST',
      ip: nextIp(),
      body: { username: target, password: 'wrong on purpose' }
    });

    const entry = await waitForEntry(e => e.path === '/api/auth/login' && e.username === target);
    // Without this, every failed-auth row has username = NULL, so a detection engine
    // can correlate a brute-force burst but cannot say which account was under attack.
    // Sentinel Blue's BT-IDENTITY-001 alert came back with user: null for exactly this.
    expect(entry, 'failed login was not attributed to the targeted account').not.toBeNull();
    expect(entry.user_id).toBeNull();
    expect(entry.outcome).toBe('rejected');
  });

  // Promote a real registered user to admin in the real database. This is test
  // setup, not a stand-in for the behaviour under test: the prune itself runs
  // through the actual HTTP route.
  async function adminUser(prefix) {
    const { env } = await import('cloudflare:test');
    const user = await registerUser(prefix);
    await env.AIHANGOUT_DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?')
      .bind(user.id).run();
    return user;
  }

  it('prunes routine traffic past retention but keeps quarantined evidence', async () => {
    const { env } = await import('cloudflare:test');
    // Seed aged rows directly: there is no honest way to age a row through the API,
    // and the retention boundary is exactly what needs proving.
    for (const [outcome, status, quarantined] of [
      ['accepted', 200, 0],
      ['rejected', 409, 1],
    ]) {
      await env.AIHANGOUT_DB.prepare(`
        INSERT INTO activity_log
          (occurred_at, method, path, action, outcome, http_status, quarantined)
        VALUES (datetime('now','-90 days'), 'POST', '/api/problems', 'retention.probe', ?, ?, ?)
      `).bind(outcome, status, quarantined).run();
    }

    const admin = await adminUser('pruneadmin');
    const res = await api('/api/admin/activity-log/prune', {
      method: 'POST', token: admin.token, ip: admin.ip, body: {},
    });

    expect(res.status).toBe(200);
    expect(res.json.error).toBeUndefined();
    expect(res.json.pruned_accepted).toBeGreaterThanOrEqual(1);
    // 90 days old is inside the 180-day quarantine window, so evidence survives.
    expect(res.json.pruned_quarantined).toBe(0);

    const remaining = await env.AIHANGOUT_DB.prepare(
      `SELECT outcome, quarantined FROM activity_log WHERE action = 'retention.probe'`
    ).all();
    const rows = remaining.results || [];
    expect(rows.every((r) => r.quarantined === 1)).toBe(true);
  });

  it('refuses a prune that would erase evidence sooner than routine traffic', async () => {
    const admin = await adminUser('pruneorder');
    const res = await api('/api/admin/activity-log/prune', {
      method: 'POST', token: admin.token, ip: admin.ip,
      body: { retention_days: 30, quarantine_retention_days: 1 },
    });
    // Otherwise this endpoint becomes a way to delete the interesting rows first.
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/greater than or equal/);
  });

  it('the database refuses to delete a row still inside its retention window', async () => {
    const { env } = await import('cloudflare:test');
    await env.AIHANGOUT_DB.prepare(`
      INSERT INTO activity_log
        (occurred_at, method, path, action, outcome, http_status, quarantined)
      VALUES (datetime('now','-1 day'), 'POST', '/api/problems', 'floor.recent', 'accepted', 200, 0)
    `).run();

    // Not "the route declines to" — the storage layer itself must refuse, so a future
    // endpoint or a bug cannot rewrite recent history.
    await expect(
      env.AIHANGOUT_DB.prepare(`DELETE FROM activity_log WHERE action = 'floor.recent'`).run()
    ).rejects.toThrow(/retention window/);
  });

  it('the database refuses to delete quarantined evidence early', async () => {
    const { env } = await import('cloudflare:test');
    await env.AIHANGOUT_DB.prepare(`
      INSERT INTO activity_log
        (occurred_at, method, path, action, outcome, http_status, quarantined)
      VALUES (datetime('now','-60 days'), 'POST', '/api/problems', 'floor.evidence', 'rejected', 409, 1)
    `).run();

    // 60 days is past the 30-day routine window but well inside the 180-day evidence
    // window: deleting the record of refused requests is exactly the attacker move.
    await expect(
      env.AIHANGOUT_DB.prepare(`DELETE FROM activity_log WHERE action = 'floor.evidence'`).run()
    ).rejects.toThrow(/retention window/);
  });

  it('allows deletion once evidence is past its longer window', async () => {
    const { env } = await import('cloudflare:test');
    await env.AIHANGOUT_DB.prepare(`
      INSERT INTO activity_log
        (occurred_at, method, path, action, outcome, http_status, quarantined)
      VALUES (datetime('now','-400 days'), 'POST', '/api/problems', 'floor.ancient', 'rejected', 409, 1)
    `).run();

    const del = await env.AIHANGOUT_DB
      .prepare(`DELETE FROM activity_log WHERE action = 'floor.ancient'`).run();
    expect(del.meta.changes).toBe(1);
  });

  it('still refuses to rewrite an immutable field', async () => {
    const { env } = await import('cloudflare:test');
    await env.AIHANGOUT_DB.prepare(`
      INSERT INTO activity_log
        (occurred_at, method, path, action, outcome, http_status, quarantined)
      VALUES (datetime('now'), 'POST', '/api/problems', 'floor.immutable', 'rejected', 409, 1)
    `).run();

    // Retention must not have weakened field immutability.
    await expect(
      env.AIHANGOUT_DB.prepare(
        `UPDATE activity_log SET outcome = 'accepted' WHERE action = 'floor.immutable'`
      ).run()
    ).rejects.toThrow(/append-only/);
  });

  it('prune is admin-only', async () => {
    const user = await registerUser('prunenonadmin');
    const res = await api('/api/admin/activity-log/prune', {
      method: 'POST', token: user.token, ip: user.ip, body: {},
    });
    expect(res.status).toBe(403);
  });

  it('is admin-only', async () => {
    const user = await registerUser('lognonadmin');
    const anon = await api('/api/admin/activity-log');
    const asUser = await api('/api/admin/activity-log', { token: user.token, ip: user.ip });

    expect(anon.status).toBe(401);
    expect(asUser.status).toBe(403);
  });
});

describe('health', () => {
  it('reports database connectivity', async () => {
    const res = await api('/api/health');
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('ok');
  });

  it('passes the in-process auth hashing self-check', async () => {
    const res = await api('/api/health/auth');
    expect(res.status).toBe(200);
    expect(res.json.checks.hash).toBe('ok');
    expect(res.json.checks.verify).toBe('ok');
    expect(res.json.checks.reject).toBe('ok');
  });
});
