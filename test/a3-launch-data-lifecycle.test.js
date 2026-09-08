import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// A3 launch-readiness backend data-lifecycle audit (Team/tasks/AIHANGOUT-launch-20260908.md).
// Real src/worker.js inside workerd against a real D1, same no-mock discipline as
// test/trust-path.test.js and test/manus-adversarial-qa.test.js. TEST-NET-3
// 203.0.113.x range is trust-path's; 198.51.100.x is manus-qa's -- this file uses
// 192.0.2.x (TEST-NET-1) to avoid colliding with either under the shared
// singleWorker instance.

let clientSeq = 0;
function nextIp() {
  clientSeq += 1;
  return `192.0.2.${clientSeq % 250 + 1}`;
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
    method: 'POST', ip,
    body: { username, email, password, aiAgentType: 'human' }
  });
  expect(res.status, `register ${username} failed: ${JSON.stringify(res.json)}`).toBe(200);
  return { username, email, password, ip, token: res.json.token, id: res.json.user.id };
}

async function createProblem(user, overrides = {}) {
  unique += 1;
  return api('/api/problems', {
    method: 'POST', token: user.token, ip: user.ip,
    body: {
      title: `A3 data-lifecycle probe ${unique}`,
      description: 'Fixture problem for the launch-readiness backend data-lifecycle audit.',
      category: 'Security',
      spofIndicators: ['single-vendor-dependency'],
      ...overrides,
    }
  });
}

async function createSolution(user, problemId, overrides = {}) {
  return api(`/api/problems/${problemId}/solutions`, {
    method: 'POST', token: user.token, ip: user.ip,
    body: {
      solutionText: 'Mitigate by introducing a fallback provider.',
      whyExplanation: 'Root cause was a single point of failure with no fallback path.',
      ...overrides,
    }
  });
}

describe('Defect 1: ai_learning_data.spof_categories was never populated', () => {
  it('copies the parent problem\'s category + spof_indicators into ai_learning_data.spof_categories on solution creation', async () => {
    const author = await registerUser('a3spof_author');
    const solver = await registerUser('a3spof_solver');
    const problem = await createProblem(author);
    expect(problem.status).toBe(200);
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;

    const solution = await createSolution(solver, problemId);
    expect(solution.status, JSON.stringify(solution.json)).toBe(200);
    const solutionId = solution.json.solutionId ?? solution.json.solution?.id ?? solution.json.id;

    const row = await env.AIHANGOUT_DB
      .prepare('SELECT why_vector, spof_categories FROM ai_learning_data WHERE solution_id = ?')
      .bind(solutionId).first();
    expect(row, 'no ai_learning_data row was written for this solution').toBeTruthy();
    expect(row.spof_categories, 'spof_categories is still NULL -- the defect is unfixed').toBeTruthy();

    const parsed = JSON.parse(row.spof_categories);
    expect(parsed.category).toBe('Security');
    expect(parsed.spof_indicators).toContain('single-vendor-dependency');

    // why_vector's existing (pre-fix) behaviour must be unchanged by this fix.
    expect(JSON.parse(row.why_vector).whyExplanation).toBe('Root cause was a single point of failure with no fallback path.');
  });

  it('does not fail the solution write when the parent problem\'s spof_indicators is malformed JSON', async () => {
    const author = await registerUser('a3spof_malformed_author');
    const solver = await registerUser('a3spof_malformed_solver');
    const problem = await createProblem(author);
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;

    // Simulate a corrupt spof_indicators value directly (never possible through the
    // normal API, which always JSON.stringifies an array) -- this is exactly the
    // kind of malformed-legacy-row case a fix must fail closed/soft on, not throw.
    await env.AIHANGOUT_DB.prepare("UPDATE problems SET spof_indicators = 'not-json' WHERE id = ?")
      .bind(problemId).run();

    const solution = await createSolution(solver, problemId);
    expect(solution.status, JSON.stringify(solution.json)).toBe(200);
  });
});

describe('Defect 2: an author\'s own pending_review problem was invisible on their own profile', () => {
  it('is visible to the author via GET /api/problems?username=<self> once authenticated', async () => {
    const author = await registerUser('a3pending_author');
    const problem = await createProblem(author, { title: `A3 pending-visibility probe ${++unique}` });
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;

    // Reproduces the reported state (posts stuck in pending_review invisible to
    // their own author) directly, rather than fighting BETA_MODE's first-post gate
    // logic to get there incidentally.
    await env.AIHANGOUT_DB.prepare("UPDATE problems SET status = 'pending_review' WHERE id = ?")
      .bind(problemId).run();

    const ownView = await api(`/api/problems?username=${author.username}&limit=20`, {
      token: author.token, ip: author.ip
    });
    expect(ownView.status).toBe(200);
    const ids = (ownView.json.problems || ownView.json.data || []).map(p => p.id);
    expect(ids, 'author\'s own pending_review problem is still missing from their own profile list').toContain(problemId);
  });

  it('stays invisible to a DIFFERENT authenticated caller viewing that same profile (no visibility leak)', async () => {
    const author = await registerUser('a3pending_author2');
    const viewer = await registerUser('a3pending_viewer');
    const problem = await createProblem(author, { title: `A3 pending-leak probe ${++unique}` });
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;
    await env.AIHANGOUT_DB.prepare("UPDATE problems SET status = 'pending_review' WHERE id = ?")
      .bind(problemId).run();

    const otherView = await api(`/api/problems?username=${author.username}&limit=20`, {
      token: viewer.token, ip: viewer.ip
    });
    expect(otherView.status).toBe(200);
    const ids = (otherView.json.problems || otherView.json.data || []).map(p => p.id);
    expect(ids, 'a pending_review problem leaked to a caller who is not its author').not.toContain(problemId);
  });

  it('stays invisible to an anonymous caller viewing that same profile', async () => {
    const author = await registerUser('a3pending_author3');
    const problem = await createProblem(author, { title: `A3 pending-anon probe ${++unique}` });
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;
    await env.AIHANGOUT_DB.prepare("UPDATE problems SET status = 'pending_review' WHERE id = ?")
      .bind(problemId).run();

    const anonView = await api(`/api/problems?username=${author.username}&limit=20`);
    expect(anonView.status).toBe(200);
    const ids = (anonView.json.problems || anonView.json.data || []).map(p => p.id);
    expect(ids).not.toContain(problemId);
  });

  it('an explicit ?status= filter is unaffected by the fix (exact behaviour preserved)', async () => {
    const author = await registerUser('a3pending_author4');
    const problem = await createProblem(author, { title: `A3 explicit-status probe ${++unique}` });
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;
    await env.AIHANGOUT_DB.prepare("UPDATE problems SET status = 'pending_review' WHERE id = ?")
      .bind(problemId).run();

    // Explicit status=open, authenticated as the author -- must NOT return the
    // pending_review problem, because an explicit filter is a hard constraint,
    // not the "no filter given" default this fix touches.
    const filtered = await api(`/api/problems?username=${author.username}&status=open`, {
      token: author.token, ip: author.ip
    });
    expect(filtered.status).toBe(200);
    const ids = (filtered.json.problems || filtered.json.data || []).map(p => p.id);
    expect(ids).not.toContain(problemId);
  });
});

describe('Defect 3 (gap): no self-service export of a user\'s own data existed', () => {
  it('GET /api/users/me/export requires authentication', async () => {
    const res = await api('/api/users/me/export');
    expect(res.status).toBe(401);
  });

  it('returns the caller\'s own problems, solutions and bug reports', async () => {
    const author = await registerUser('a3export_author');
    const problem = await createProblem(author, { title: `A3 export probe ${++unique}` });
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;
    const solution = await createSolution(author, problemId, { solutionText: 'Self-authored fix for export test.' });
    expect(solution.status, JSON.stringify(solution.json)).toBe(200);

    const bug = await api('/api/bug-reports', {
      method: 'POST', token: author.token, ip: author.ip,
      body: { title: 'A3 export probe bug', description: 'fixture', bugType: 'Other' }
    });
    expect(bug.status).toBe(200);

    const exported = await api('/api/users/me/export', { token: author.token, ip: author.ip });
    expect(exported.status).toBe(200);
    expect(exported.json.profile.username).toBe(author.username);
    expect(exported.json.problems.some(p => p.id === problemId)).toBe(true);
    expect(exported.json.solutions.some(s => s.problem_id === problemId)).toBe(true);
    expect(exported.json.bug_reports.some(b => b.id === bug.json.bugReportId)).toBe(true);
  });

  it('never returns another user\'s data', async () => {
    const victim = await registerUser('a3export_victim');
    await createProblem(victim, { title: `A3 export isolation probe ${++unique}` });
    const attacker = await registerUser('a3export_attacker');

    const exported = await api('/api/users/me/export', { token: attacker.token, ip: attacker.ip });
    expect(exported.status).toBe(200);
    expect(exported.json.profile.username).toBe(attacker.username);
    expect(exported.json.problems.length).toBe(0);
  });
});
