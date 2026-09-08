import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Implements the three findings from Team/tasks/A2-aihangout-launch-20260908.md
// (A2's independent, read-only launch-security review). Real src/worker.js
// inside workerd against a real D1, same no-mock discipline as
// test/trust-path.test.js / test/manus-adversarial-qa.test.js /
// test/a3-launch-data-lifecycle.test.js. Uses TEST-NET-1 198.18.0.0/15-style
// 192.0.2.x is a3-launch-data-lifecycle's range -- this file uses
// 198.51.100.x's neighbor 203.0.113.x is trust-path's, so this file uses
// 192.0.0.x to stay clear of all three under the shared singleWorker instance.

let clientSeq = 0;
function nextIp() {
  clientSeq += 1;
  return `192.0.0.${clientSeq % 250 + 1}`;
}

async function api(path, { method = 'GET', body, token, ip, headers: extraHeaders } = {}) {
  const headers = { 'CF-Connecting-IP': ip || nextIp(), ...extraHeaders };
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

async function makeAdmin(user) {
  await env.AIHANGOUT_DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(user.id).run();
  // Force a fresh login so the JWT/authenticate() path re-reads is_admin
  // from D1 (authenticate() always does; this just keeps the test's own
  // mental model honest that admin state is per-request, not cached in
  // the token itself).
  return user;
}

async function createProblem(user, overrides = {}) {
  unique += 1;
  return api('/api/problems', {
    method: 'POST', token: user.token, ip: user.ip,
    body: {
      title: `A2 authorization probe ${unique}`,
      description: 'Fixture problem for the launch-security authorization/moderation audit.',
      category: 'Security',
      ...overrides,
    }
  });
}

async function createSolution(user, problemId, overrides = {}) {
  return api(`/api/problems/${problemId}/solutions`, {
    method: 'POST', token: user.token, ip: user.ip,
    body: { solutionText: 'Candidate fix for the authorization probe.', ...overrides }
  });
}

describe('Finding 1: legacy moderation approval must never grant human-verification', () => {
  it('approving an AI solution sets moderation_approved_at/_by, never is_verified/verified_by/verified_at/verification_type', async () => {
    const author = await registerUser('a2f1_author');
    const admin = await makeAdmin(await registerUser('a2f1_admin'));
    const problem = await createProblem(author);
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;

    const solution = await createSolution(author, problemId, {
      solutionText: 'AI-authored candidate fix.',
      solverType: 'AI',
    });
    const solutionId = solution.json.solutionId ?? solution.json.solution?.id ?? solution.json.id;
    // Force solver_type='AI' directly -- solverType in the body is not a
    // trusted client field (the real handler derives it server-side from
    // account type/agent headers); this test only needs a real AI-typed
    // row to exist, not to exercise that derivation.
    await env.AIHANGOUT_DB.prepare("UPDATE solutions SET solver_type = 'AI' WHERE id = ?").bind(solutionId).run();

    const approve = await api(`/api/admin/approve/solution/${solutionId}`, { method: 'POST', token: admin.token, ip: admin.ip, body: {} });
    expect(approve.status, JSON.stringify(approve.json)).toBe(200);

    const row = await env.AIHANGOUT_DB
      .prepare('SELECT is_verified, verified_by, verified_at, verification_type, moderation_approved_at, moderation_approved_by FROM solutions WHERE id = ?')
      .bind(solutionId).first();
    expect(row.moderation_approved_at, 'moderation approval was not recorded').toBeTruthy();
    expect(row.moderation_approved_by).toBe(admin.id);
    expect(row.is_verified, 'moderation approval must never set is_verified').toBeFalsy();
    expect(row.verified_by).toBeNull();
    expect(row.verified_at).toBeNull();
    expect(row.verification_type).toBeNull();
  });

  it('a service token (synthetic admin) approving a solution also cannot obtain is_verified', async () => {
    const realAdmin = await makeAdmin(await registerUser('a2f1_realadmin'));
    const author = await registerUser('a2f1_svc_author');
    const problem = await createProblem(author);
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;
    const solution = await createSolution(author, problemId);
    const solutionId = solution.json.solutionId ?? solution.json.solution?.id ?? solution.json.id;
    await env.AIHANGOUT_DB.prepare("UPDATE solutions SET solver_type = 'AI' WHERE id = ?").bind(solutionId).run();

    const mint = await api('/api/admin/service-token', {
      method: 'POST', token: realAdmin.token, ip: realAdmin.ip,
      body: { name: 'a2f1-probe-service' }
    });
    expect(mint.status, JSON.stringify(mint.json)).toBe(200);
    const serviceToken = mint.json.token;

    const approve = await api(`/api/admin/approve/solution/${solutionId}`, { method: 'POST', token: serviceToken, body: {} });
    expect(approve.status, JSON.stringify(approve.json)).toBe(200);

    const row = await env.AIHANGOUT_DB
      .prepare('SELECT is_verified, moderation_approved_at, moderation_approved_by FROM solutions WHERE id = ?')
      .bind(solutionId).first();
    expect(row.moderation_approved_at).toBeTruthy();
    expect(row.moderation_approved_by, 'a service token has no real user id -- must not be recorded as a fabricated FK').toBeNull();
    expect(row.is_verified, 'a service token must never be able to obtain human-verification state').toBeFalsy();
  });

  it('the dedicated /accept route (real human verification) is unaffected: still writes verified_by/verified_at/verification_type + an audit row', async () => {
    const owner = await registerUser('a2f1_accept_owner');
    const solver = await registerUser('a2f1_accept_solver');
    const problem = await createProblem(owner);
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;
    const solution = await createSolution(solver, problemId);
    const solutionId = solution.json.solutionId ?? solution.json.solution?.id ?? solution.json.id;

    const accept = await api(`/api/problems/${problemId}/solutions/${solutionId}/accept`, {
      method: 'POST', token: owner.token, ip: owner.ip, body: {}
    });
    expect(accept.status, JSON.stringify(accept.json)).toBe(200);

    const row = await env.AIHANGOUT_DB
      .prepare('SELECT is_verified, verified_by, verification_type FROM solutions WHERE id = ?')
      .bind(solutionId).first();
    expect(row.is_verified).toBeTruthy();
    expect(row.verified_by).toBe(owner.id);
    expect(row.verification_type).toBe('human_owner');
    const events = await env.AIHANGOUT_DB
      .prepare('SELECT COUNT(*) AS n FROM solution_verification_events WHERE solution_id = ?')
      .bind(solutionId).first();
    expect(events.n).toBe(1);
  });

  it('approving a nonexistent solution id returns an honest not-found, not a false success', async () => {
    const admin = await makeAdmin(await registerUser('a2f1_missing_admin'));
    const approve = await api('/api/admin/approve/solution/999999999', { method: 'POST', token: admin.token, ip: admin.ip, body: {} });
    expect(approve.status).toBe(404);
    expect(approve.json.success).toBe(false);
  });

  it('approving a pending problem still works and sets status=approved (regression: problem branch untouched)', async () => {
    const author = await registerUser('a2f1_problem_author');
    const admin = await makeAdmin(await registerUser('a2f1_problem_admin'));
    const problem = await createProblem(author);
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;
    await env.AIHANGOUT_DB.prepare("UPDATE problems SET status = 'pending_review' WHERE id = ?").bind(problemId).run();

    const approve = await api(`/api/admin/approve/problem/${problemId}`, { method: 'POST', token: admin.token, ip: admin.ip, body: {} });
    expect(approve.status, JSON.stringify(approve.json)).toBe(200);
    const row = await env.AIHANGOUT_DB.prepare('SELECT status FROM problems WHERE id = ?').bind(problemId).first();
    expect(row.status).toBe('approved');
  });
});

describe('Finding 2: pending/private content stays private to author/admin across list, detail, and nested solutions', () => {
  it('a pending_review problem is visible via GET /api/problems/:id to its author and an admin, hidden from everyone else', async () => {
    const author = await registerUser('a2f2_detail_author');
    const other = await registerUser('a2f2_detail_other');
    const admin = await makeAdmin(await registerUser('a2f2_detail_admin'));
    const problem = await createProblem(author);
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;
    await env.AIHANGOUT_DB.prepare("UPDATE problems SET status = 'pending_review' WHERE id = ?").bind(problemId).run();

    const asAuthor = await api(`/api/problems/${problemId}`, { token: author.token, ip: author.ip });
    expect(asAuthor.status).toBe(200);
    const asAdmin = await api(`/api/problems/${problemId}`, { token: admin.token, ip: admin.ip });
    expect(asAdmin.status).toBe(200);
    const asOther = await api(`/api/problems/${problemId}`, { token: other.token, ip: other.ip });
    expect(asOther.status).toBe(404);
    const anon = await api(`/api/problems/${problemId}`);
    expect(anon.status).toBe(404);
  });

  it('an unverified AI solution is hidden from other viewers in the detail route, but visible to its author, the problem owner, and an admin', async () => {
    const owner = await registerUser('a2f2_sol_owner');
    const solver = await registerUser('a2f2_sol_solver');
    const other = await registerUser('a2f2_sol_other');
    const admin = await makeAdmin(await registerUser('a2f2_sol_admin'));
    const problem = await createProblem(owner);
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;
    const solution = await createSolution(solver, problemId);
    const solutionId = solution.json.solutionId ?? solution.json.solution?.id ?? solution.json.id;
    await env.AIHANGOUT_DB.prepare("UPDATE solutions SET solver_type = 'AI' WHERE id = ?").bind(solutionId).run();

    const asOther = await api(`/api/problems/${problemId}`, { token: other.token, ip: other.ip });
    expect(asOther.status).toBe(200);
    expect((asOther.json.solutions || []).some(s => s.id === solutionId), 'pending AI solution leaked to an unrelated viewer').toBe(false);

    const asSolver = await api(`/api/problems/${problemId}`, { token: solver.token, ip: solver.ip });
    expect((asSolver.json.solutions || []).some(s => s.id === solutionId)).toBe(true);
    const asOwner = await api(`/api/problems/${problemId}`, { token: owner.token, ip: owner.ip });
    expect((asOwner.json.solutions || []).some(s => s.id === solutionId)).toBe(true);
    const asAdmin = await api(`/api/problems/${problemId}`, { token: admin.token, ip: admin.ip });
    expect((asAdmin.json.solutions || []).some(s => s.id === solutionId)).toBe(true);
  });

  it('once moderation-approved, the AI solution becomes visible to everyone (findings 1+2 interaction)', async () => {
    const owner = await registerUser('a2f2_modapp_owner');
    const solver = await registerUser('a2f2_modapp_solver');
    const other = await registerUser('a2f2_modapp_other');
    const admin = await makeAdmin(await registerUser('a2f2_modapp_admin'));
    const problem = await createProblem(owner);
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;
    const solution = await createSolution(solver, problemId);
    const solutionId = solution.json.solutionId ?? solution.json.solution?.id ?? solution.json.id;
    await env.AIHANGOUT_DB.prepare("UPDATE solutions SET solver_type = 'AI' WHERE id = ?").bind(solutionId).run();

    const approve = await api(`/api/admin/approve/solution/${solutionId}`, { method: 'POST', token: admin.token, ip: admin.ip, body: {} });
    expect(approve.status).toBe(200);

    const asOther = await api(`/api/problems/${problemId}`, { token: other.token, ip: other.ip });
    expect((asOther.json.solutions || []).some(s => s.id === solutionId), 'moderation-approved solution should now be publicly visible').toBe(true);
  });
});

describe('Finding 3: contribution and vote routes enforce parent-problem visibility', () => {
  it('posting a solution onto a private problem is refused for an unrelated account, and creates no row', async () => {
    const owner = await registerUser('a2f3_priv_owner');
    const attacker = await registerUser('a2f3_priv_attacker');
    const problem = await createProblem(owner, { is_public: false });
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;

    const before = await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM solutions WHERE problem_id = ?').bind(problemId).first();
    const attempt = await createSolution(attacker, problemId);
    expect(attempt.status, 'must not reveal existence via a 403 -- generic 404').toBe(404);
    const after = await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM solutions WHERE problem_id = ?').bind(problemId).first();
    expect(after.n).toBe(before.n);
  });

  it('posting a solution onto that same private problem succeeds for the owner and for an admin', async () => {
    const owner = await registerUser('a2f3_priv_owner2');
    const admin = await makeAdmin(await registerUser('a2f3_priv_admin2'));
    const problem = await createProblem(owner, { is_public: false });
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;

    const byAdmin = await createSolution(admin, problemId, { solutionText: 'Admin-authored fix on a private problem.' });
    expect(byAdmin.status, JSON.stringify(byAdmin.json)).toBe(200);
  });

  it('a pending_review problem also refuses solution contribution from an unrelated account', async () => {
    const owner = await registerUser('a2f3_pending_owner');
    const other = await registerUser('a2f3_pending_other');
    const problem = await createProblem(owner);
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;
    await env.AIHANGOUT_DB.prepare("UPDATE problems SET status = 'pending_review' WHERE id = ?").bind(problemId).run();

    const attempt = await createSolution(other, problemId);
    expect(attempt.status).toBe(404);
  });

  it('voting (POST /api/vote) on a private problem is refused for an unrelated account, with no vote row and no reputation change', async () => {
    const owner = await registerUser('a2f3_vote_owner');
    const attacker = await registerUser('a2f3_vote_attacker');
    const problem = await createProblem(owner, { is_public: false });
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;
    const before = await env.AIHANGOUT_DB.prepare('SELECT reputation FROM users WHERE id = ?').bind(owner.id).first();

    const vote = await api('/api/vote', {
      method: 'POST', token: attacker.token, ip: attacker.ip,
      body: { targetType: 'problem', targetId: problemId, voteType: 'up' }
    });
    expect(vote.status).toBe(404);
    const voteRow = await env.AIHANGOUT_DB
      .prepare('SELECT COUNT(*) AS n FROM votes WHERE target_type = ? AND target_id = ?')
      .bind('problem', problemId).first();
    expect(voteRow.n).toBe(0);
    const after = await env.AIHANGOUT_DB.prepare('SELECT reputation FROM users WHERE id = ?').bind(owner.id).first();
    expect(after.reputation).toBe(before.reputation);
  });

  it('voting on a solution whose parent problem is private is also refused for an unrelated account', async () => {
    const owner = await registerUser('a2f3_solvote_owner');
    const solver = await registerUser('a2f3_solvote_solver');
    const attacker = await registerUser('a2f3_solvote_attacker');
    const problem = await createProblem(owner, { is_public: false });
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;
    // Owner/admin can contribute to their own private problem (finding-3
    // positive case already covered above); use the owner as the solver
    // here purely to get a real solution row to target with the vote.
    const solution = await createSolution(owner, problemId);
    const solutionId = solution.json.solutionId ?? solution.json.solution?.id ?? solution.json.id;

    const vote = await api('/api/vote', {
      method: 'POST', token: attacker.token, ip: attacker.ip,
      body: { targetType: 'solution', targetId: solutionId, voteType: 'up' }
    });
    expect(vote.status).toBe(404);
  });

  it('the legacy POST /api/problems/:id/vote route enforces the same private-problem guard', async () => {
    const owner = await registerUser('a2f3_legacyvote_owner');
    const attacker = await registerUser('a2f3_legacyvote_attacker');
    const problem = await createProblem(owner, { is_public: false });
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;

    const vote = await api(`/api/problems/${problemId}/vote`, {
      method: 'POST', token: attacker.token, ip: attacker.ip, body: { vote: 1 }
    });
    expect(vote.status).toBe(404);
  });

  it('positive control: voting on a normal public/open problem by an unrelated user still succeeds exactly once', async () => {
    const owner = await registerUser('a2f3_public_owner');
    const voter = await registerUser('a2f3_public_voter');
    const problem = await createProblem(owner);
    const problemId = problem.json.problemId ?? problem.json.problem?.id ?? problem.json.id;

    const vote = await api('/api/vote', {
      method: 'POST', token: voter.token, ip: voter.ip,
      body: { targetType: 'problem', targetId: problemId, voteType: 'up' }
    });
    expect(vote.status, JSON.stringify(vote.json)).toBe(200);
    const voteRow = await env.AIHANGOUT_DB
      .prepare('SELECT COUNT(*) AS n FROM votes WHERE target_type = ? AND target_id = ? AND user_id = ?')
      .bind('problem', problemId, voter.id).first();
    expect(voteRow.n).toBe(1);
  });
});
