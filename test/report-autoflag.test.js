import { SELF, env } from 'cloudflare:test';
import { it, expect } from 'vitest';

// POST /api/reports: five reports hold a problem for review. Solutions have no status column, so the
// fifth report on a solution used to throw "no such column: status" and answer 500 after recording the report.
const base = 'https://aihangout.ai';
let ipCounter = 10;
async function register(name) {
  const res = await SELF.fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `203.0.113.${ipCounter++}` },
    body: JSON.stringify({ username: name, email: `${name}@example.test`, password: 'test-only-strong-password-123', ai_agent_type: 'human', accept_tos: true })
  });
  expect(res.status).toBe(200);
  return res.json();
}
const report = (token, content_type, content_id) => SELF.fetch(`${base}/api/reports`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.99', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ content_type, content_id, reason: 'spam' })
});

async function setup(tag) {
  const author = await register(`rep_author_${tag}`);
  const reporters = [];
  for (let i = 0; i < 5; i++) reporters.push(await register(`rep_user_${tag}_${i}`));
  const problemId = (await env.AIHANGOUT_DB.prepare(
    `INSERT INTO problems (user_id, title, description, category, status, is_public) VALUES (?, 'Reported problem', 'desc', 'general', 'approved', 1)`
  ).bind(author.user.id).run()).meta.last_row_id;
  const solutionId = (await env.AIHANGOUT_DB.prepare(
    `INSERT INTO solutions (problem_id, user_id, solution_text) VALUES (?, ?, 'Reported solution')`
  ).bind(problemId, author.user.id).run()).meta.last_row_id;
  return { reporters, problemId, solutionId };
}

it('five reports on a problem hold it for review', async () => {
  const { reporters, problemId } = await setup('p');
  for (const r of reporters) expect((await report(r.token, 'problem', problemId)).status).toBe(200);
  const row = await env.AIHANGOUT_DB.prepare('SELECT status, report_count FROM problems WHERE id = ?').bind(problemId).first();
  expect(row).toEqual({ status: 'pending_review', report_count: 5 });
});

it('five reports on a solution all succeed (no 500) and are counted', async () => {
  const { reporters, solutionId } = await setup('s');
  const statuses = [];
  for (const r of reporters) statuses.push((await report(r.token, 'solution', solutionId)).status);
  expect(statuses).toEqual([200, 200, 200, 200, 200]);
  const row = await env.AIHANGOUT_DB.prepare('SELECT report_count FROM solutions WHERE id = ?').bind(solutionId).first();
  expect(row.report_count).toBe(5);
});
