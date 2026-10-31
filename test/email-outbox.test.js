import { SELF, env, createScheduledController, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/worker.js';
import {
  enqueueNotificationEmail, flushOutbox, enqueueWeeklyDigests, extractMentions,
  makeUnsubscribeToken, verifyUnsubscribeToken, weekStartUtc,
} from '../src/email-outbox.js';

// AIH-R5. Real D1 and real routes in workerd. The only fake is the network edge to the email
// provider: globalThis.fetch is spied for api.resend.com so we can assert exactly what would
// leave the building, and everything else passes through.
//
// Synthetic client IPs come from 198.51.100.0/24 (TEST-NET-2) so rate-limit buckets never
// collide with the other test files under the shared singleWorker instance.

let ipSeq = 0;
const nextIp = () => `198.51.100.${(++ipSeq % 250) + 1}`;
let unique = 0;

async function api(path, { method = 'GET', body, token, ip, form } = {}) {
  const headers = { 'CF-Connecting-IP': ip || nextIp() };
  let payload;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await SELF.fetch(`https://aihangout.ai${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function user(prefix, { verified = true } = {}) {
  const username = `${prefix}_${++unique}`;
  const ip = nextIp();
  const res = await api('/api/auth/register', {
    method: 'POST', ip,
    body: { username, email: `${username}@example.test`, password: 'correct horse battery staple 42', ai_agent_type: 'human', accept_tos: true }
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  if (verified) await env.AIHANGOUT_DB.prepare('UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = ?').bind(res.json.user.id).run();
  return { id: res.json.user.id, username, email: `${username}@example.test`, token: res.json.token, ip };
}

async function problemBy(owner) {
  const res = await api('/api/problems', {
    method: 'POST', token: owner.token, ip: owner.ip,
    body: { title: `R5 fixture ${++unique}`, description: 'fixture description long enough', category: 'Programming' }
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.problemId;
}

async function answer(solver, problemId, text = 'a real fix') {
  const res = await api(`/api/problems/${problemId}/solutions`, {
    method: 'POST', token: solver.token, ip: solver.ip, body: { solutionText: text, whyExplanation: 'because it works' }
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.solutionId;
}

const outbox = async (where = '1=1', ...b) => (await env.AIHANGOUT_DB.prepare(`SELECT * FROM email_outbox WHERE ${where} ORDER BY id`).bind(...b).all()).results;
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for background work');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---- provider spy ----------------------------------------------------------------------------

let sent;
let providerStatus;
let realFetch;
beforeEach(async () => {
  await env.AIHANGOUT_DB.prepare('DELETE FROM email_outbox').run();
  sent = [];
  providerStatus = 200;
  realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.resend.com/')) {
      const body = JSON.parse(init.body);
      sent.push({ url, body, headers: init.headers });
      return new Response(JSON.stringify(providerStatus === 200 ? { id: `re_${sent.length}` } : { message: 'boom' }), { status: providerStatus });
    }
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const mailEnv = () => ({ ...env, RESEND_API_KEY: 're_test_key' });
async function runCron(cron) {
  const ctrl = createScheduledController({ scheduledTime: Date.now(), cron });
  const ctx = createExecutionContext();
  await worker.scheduled(ctrl, mailEnv(), ctx);
  await waitOnExecutionContext(ctx);
}

describe('one email per event', () => {
  it('queues a single email when someone answers my question, and the cron sends it exactly once', async () => {
    const owner = await user('r5owner');
    const solver = await user('r5solver');
    const pid = await problemBy(owner);
    const sid = await answer(solver, pid);

    const rows = await until(async () => { const r = await outbox('user_id = ?', owner.id); return r.length ? r : null; });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: 'solutions', kind: 'new_solution', status: 'pending' });
    expect(rows[0].dedupe_key).toBe(`new_solution:${owner.id}:${solver.id}:solution:${sid}`);
    expect(sent).toHaveLength(0); // nothing is sent inside the request

    await runCron('*/10 * * * *');
    expect(sent).toHaveLength(1);
    const mail = sent[0];
    expect(mail.body.to).toEqual([owner.email]);
    expect(mail.body.subject).toBe('New answer to your question on AI Hangout');
    expect(mail.body.text).toContain(`${solver.username} answered your question`);
    expect(mail.body.text).toContain(`https://aihangout.ai/problem/${pid}`);
    expect(mail.headers['Idempotency-Key']).toBe(rows[0].dedupe_key);
    expect(mail.body.headers['List-Unsubscribe']).toMatch(/^<https:\/\/aihangout\.ai\/api\/email\/unsubscribe\?t=/);
    expect(mail.body.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect((await outbox('id = ?', rows[0].id))[0]).toMatchObject({ status: 'sent', provider_id: 're_1' });

    await runCron('*/10 * * * *'); // a later run must not resend
    expect(sent).toHaveLength(1);

    // The in-app notification is unchanged.
    const inApp = await env.AIHANGOUT_DB.prepare("SELECT message FROM notifications WHERE user_id = ? AND type = 'new_solution'").bind(owner.id).all();
    expect(inApp.results).toHaveLength(1);
  });

  it('re-enqueueing the same event creates no second row', async () => {
    const owner = await user('r5dup');
    const e = { userId: owner.id, actorId: 99, type: 'new_solution', targetType: 'problem', targetId: 5, message: 'x answered your question', sourceType: 'solution', sourceId: 7 };
    expect(await enqueueNotificationEmail(env, e)).toBe(true);
    expect(await enqueueNotificationEmail(env, e)).toBe(false);
    expect(await outbox('user_id = ?', owner.id)).toHaveLength(1);
  });

  it('two overlapping flushes still send once', async () => {
    const owner = await user('r5race');
    await enqueueNotificationEmail(env, { userId: owner.id, actorId: 1, type: 'new_solution', targetType: 'problem', targetId: 1, message: 'm', sourceType: 'solution', sourceId: 1 });
    const send = vi.fn(async () => ({ id: 're_x' }));
    await Promise.all([flushOutbox(env, send), flushOutbox(env, send)]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('only emails the categories that are meant to be emailed (votes and follows stay in-app)', async () => {
    const owner = await user('r5cat');
    const made = await enqueueNotificationEmail(env, { userId: owner.id, actorId: 2, type: 'vote_on_content', targetType: 'problem', targetId: 1, message: 'm', sourceType: 'vote', sourceId: 1 });
    expect(made).toBe(false);
    expect(await outbox('user_id = ?', owner.id)).toHaveLength(0);
  });

  it('escapes user-controlled text in the HTML part', async () => {
    const owner = await user('r5xss');
    await enqueueNotificationEmail(env, { userId: owner.id, actorId: 3, type: 'new_solution', targetType: 'problem', targetId: 1, message: '<script>alert(1)</script> answered', sourceType: 'solution', sourceId: 11 });
    await runCron('*/10 * * * *');
    expect(sent[0].body.html).not.toContain('<script>');
    expect(sent[0].body.html).toContain('&lt;script&gt;');
  });
});

describe('unsubscribe is honoured', () => {
  async function queuedFor(owner) {
    await enqueueNotificationEmail(env, { userId: owner.id, actorId: 1, type: 'new_solution', targetType: 'problem', targetId: 1, message: 'm', sourceType: 'solution', sourceId: Math.floor(Math.random() * 1e9) });
  }

  it('GET shows a confirmation and changes nothing; POST unsubscribes and suppresses what is queued', async () => {
    const owner = await user('r5unsub');
    await queuedFor(owner);
    const token = await makeUnsubscribeToken(env, owner.id, 'solutions');

    const page = await api(`/api/email/unsubscribe?t=${token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('<form method="post"');
    expect((await outbox('user_id = ?', owner.id))[0].status).toBe('pending'); // prefetch must not unsubscribe

    const done = await api(`/api/email/unsubscribe?t=${token}`, { method: 'POST', form: { 'List-Unsubscribe': 'One-Click' } });
    expect(done.status).toBe(200);
    expect(done.text).toContain('Done');
    expect((await outbox('user_id = ?', owner.id))[0]).toMatchObject({ status: 'suppressed', last_error: 'unsubscribed' });

    // and later events for that category are suppressed at send time
    await queuedFor(owner);
    await runCron('*/10 * * * *');
    expect(sent).toHaveLength(0);
    expect((await outbox('user_id = ? AND status = ?', owner.id, 'suppressed')).length).toBe(2);
  });

  it('a category unsubscribe leaves the other categories on; "all" turns everything off', async () => {
    const u = await user('r5scope');
    await api(`/api/email/unsubscribe?t=${await makeUnsubscribeToken(env, u.id, 'digest')}`, { method: 'POST', form: { 'List-Unsubscribe': 'One-Click' } });
    let prefs = (await api('/api/users/me/email-preferences', { token: u.token })).json.preferences;
    expect(prefs).toEqual({ solutions: true, mentions: true, digest: false, unsubscribed_all: false });
    await api(`/api/email/unsubscribe?t=${await makeUnsubscribeToken(env, u.id, 'all')}`, { method: 'POST', form: { 'List-Unsubscribe': 'One-Click' } });
    prefs = (await api('/api/users/me/email-preferences', { token: u.token })).json.preferences;
    expect(prefs.unsubscribed_all).toBe(true);
    await queuedFor(u);
    await runCron('*/10 * * * *');
    expect(sent).toHaveLength(0);
  });

  it('rejects forged, truncated and cross-user tokens', async () => {
    const a = await user('r5forgeA');
    const b = await user('r5forgeB');
    const good = await makeUnsubscribeToken(env, a.id, 'all');
    const [, scope, sig] = good.split('.');
    for (const bad of [`${a.id}.all.AAAA`, `${b.id}.all.${sig}`, `${a.id}.digestx.${sig}`, `${a.id}.all`, '', 'x.y.z', `0.all.${sig}`]) {
      expect((await api(`/api/email/unsubscribe?t=${bad}`, { method: 'POST', form: { 'List-Unsubscribe': 'One-Click' } })).status).toBe(400);
    }
    expect(await verifyUnsubscribeToken(env, good)).toEqual({ userId: a.id, scope });
    expect((await api('/api/users/me/email-preferences', { token: b.token })).json.preferences.unsubscribed_all).toBe(false);
  });

  it('the preferences API round-trips and a re-subscribe works', async () => {
    const u = await user('r5prefs');
    expect((await api('/api/users/me/email-preferences')).status).toBe(401);
    const put = await api('/api/users/me/email-preferences', { method: 'PUT', token: u.token, body: { mentions: false, unsubscribed_all: true } });
    expect(put.json.preferences).toEqual({ solutions: true, mentions: false, digest: true, unsubscribed_all: true });
    const back = await api('/api/users/me/email-preferences', { method: 'PUT', token: u.token, body: { unsubscribed_all: false } });
    expect(back.json.preferences.unsubscribed_all).toBe(false);
  });

  it('never emails an unverified address', async () => {
    const u = await user('r5unverified', { verified: false });
    await queuedFor(u);
    await runCron('*/10 * * * *');
    expect(sent).toHaveLength(0);
    expect((await outbox('user_id = ?', u.id))[0]).toMatchObject({ status: 'suppressed', last_error: 'no_verified_email' });
  });
});

describe('delivery failures', () => {
  it('retries a provider rejection, then gives up after 5 attempts', async () => {
    const u = await user('r5retry');
    await enqueueNotificationEmail(env, { userId: u.id, actorId: 1, type: 'new_solution', targetType: 'problem', targetId: 1, message: 'm', sourceType: 'solution', sourceId: 4242 });
    const failing = async () => { throw new Error('Resend rejected email (500): boom'); };
    for (let i = 1; i <= 4; i++) {
      const r = await flushOutbox(env, failing);
      expect(r.retry).toBe(1);
      expect((await outbox('user_id = ?', u.id))[0]).toMatchObject({ status: 'pending', attempts: i });
    }
    const last = await flushOutbox(env, failing);
    expect(last.failed).toBe(1);
    expect((await outbox('user_id = ?', u.id))[0]).toMatchObject({ status: 'failed', attempts: 5 });
    expect((await outbox('user_id = ?', u.id))[0].last_error).toContain('boom');
  });

  it('a failure then a success sends once', async () => {
    const u = await user('r5recover');
    await enqueueNotificationEmail(env, { userId: u.id, actorId: 1, type: 'new_solution', targetType: 'problem', targetId: 1, message: 'm', sourceType: 'solution', sourceId: 4343 });
    await flushOutbox(env, async () => { throw new Error('transient'); });
    const ok = vi.fn(async () => ({ id: 're_ok' }));
    await flushOutbox(env, ok);
    await flushOutbox(env, ok);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('without a provider key nothing is consumed: rows stay pending with no attempt counted', async () => {
    const u = await user('r5nokey');
    await enqueueNotificationEmail(env, { userId: u.id, actorId: 1, type: 'new_solution', targetType: 'problem', targetId: 1, message: 'm', sourceType: 'solution', sourceId: 4444 });
    const r = await flushOutbox(env, async () => ({ skipped: true }));
    expect(r.provider_unconfigured).toBe(true);
    expect((await outbox('user_id = ?', u.id))[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('the real sender surfaces a provider rejection to the outbox', async () => {
    const u = await user('r5real');
    await enqueueNotificationEmail(env, { userId: u.id, actorId: 1, type: 'new_solution', targetType: 'problem', targetId: 1, message: 'm', sourceType: 'solution', sourceId: 4545 });
    providerStatus = 500;
    await runCron('*/10 * * * *');
    expect(sent).toHaveLength(1);
    expect((await outbox('user_id = ?', u.id))[0]).toMatchObject({ status: 'pending', attempts: 1 });
  });
});

describe('mentions', () => {
  it('extracts real mentions only', () => {
    expect(extractMentions('thanks @alice and @Bob_2, see mail me at a@b.com or @@x or email@host')).toEqual(['alice', 'bob_2']);
    expect(extractMentions('@carol. @dave-')).toEqual(['carol', 'dave']);
    expect(extractMentions('@a @' + 'x'.repeat(80))).toEqual(['x'.repeat(50)]);
    expect(extractMentions(null)).toEqual([]);
  });

  it('an @mention in an answer notifies that user once, in-app and by email, not the asker twice', async () => {
    const owner = await user('r5mowner');
    const solver = await user('r5msolver');
    const friend = await user('r5mfriend');
    const pid = await problemBy(owner);
    await answer(solver, pid, `Try this, @${friend.username} knows more. cc @${owner.username} and @${solver.username} and @nobody_here_xyz`);

    const friendRows = await until(async () => { const r = await outbox('user_id = ?', friend.id); return r.length ? r : null; });
    expect(friendRows).toHaveLength(1);
    expect(friendRows[0]).toMatchObject({ category: 'mentions', kind: 'mention' });
    const ownerRows = await outbox('user_id = ?', owner.id);
    expect(ownerRows.map((r) => r.kind)).toEqual(['new_solution']); // asker gets the answer email only
    expect(await outbox('user_id = ?', solver.id)).toHaveLength(0); // no self-mention
    const inApp = await env.AIHANGOUT_DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND type = 'mention'").bind(friend.id).first();
    expect(inApp.n).toBe(1);
  });
});

describe('weekly digest', () => {
  it('queues one digest per user per week with the week\'s answers, skips quiet users, and never repeats', async () => {
    const owner = await user('r5dg_owner');
    const quiet = await user('r5dg_quiet');
    const solver = await user('r5dg_solver');
    const pid = await problemBy(owner);
    await answer(solver, pid);
    await until(async () => (await outbox('user_id = ?', owner.id)).length);
    await env.AIHANGOUT_DB.prepare('DELETE FROM email_outbox').run(); // isolate the digest from the instant email

    const r1 = await enqueueWeeklyDigests(env);
    expect(r1.queued).toBeGreaterThanOrEqual(1);
    const mine = await outbox("user_id = ? AND category = 'digest'", owner.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].dedupe_key).toBe(`digest:${owner.id}:${weekStartUtc()}`);
    expect(mine[0].body_text).toContain('New answers to your questions');
    expect(mine[0].body_text).toContain(`/problem/${pid}`);
    expect((await outbox("user_id = ? AND category = 'digest'", quiet.id))[0]).toMatchObject({ status: 'suppressed', last_error: 'nothing_to_report' });

    const r2 = await enqueueWeeklyDigests(env); // a second run in the same week
    expect(r2.queued).toBe(0);
    expect(await outbox("user_id = ? AND category = 'digest'", owner.id)).toHaveLength(1);

    await runCron('0 14 * * 1');
    const digests = sent.filter((m) => m.body.subject === 'Your weekly AI Hangout digest' && m.body.to[0] === owner.email);
    expect(digests).toHaveLength(1);
    expect(digests[0].body.headers['List-Unsubscribe']).toContain('/api/email/unsubscribe?t=');
    expect(sent.filter((m) => m.body.to[0] === quiet.email)).toHaveLength(0);
  });

  it('respects a digest opt-out', async () => {
    const owner = await user('r5dg_optout');
    const solver = await user('r5dg_optsolver');
    await answer(solver, await problemBy(owner));
    await api('/api/users/me/email-preferences', { method: 'PUT', token: owner.token, body: { digest: false } });
    await env.AIHANGOUT_DB.prepare('DELETE FROM email_outbox').run();
    await enqueueWeeklyDigests(env);
    expect(await outbox("user_id = ? AND category = 'digest'", owner.id)).toHaveLength(0);
  });
});

describe('cron dispatch', () => {
  it('keeps the daily harvest cron separate from the email flush', async () => {
    const u = await user('r5cron');
    await enqueueNotificationEmail(env, { userId: u.id, actorId: 1, type: 'new_solution', targetType: 'problem', targetId: 1, message: 'm', sourceType: 'solution', sourceId: 5151 });
    const ctrl = createScheduledController({ scheduledTime: Date.now(), cron: '*/10 * * * *' });
    const ctx = createExecutionContext();
    const log = vi.spyOn(console, 'log');
    await worker.scheduled(ctrl, mailEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(log.mock.calls.flat().join('\n')).toContain('[Cron] email flush');
    expect(log.mock.calls.flat().join('\n')).not.toContain('Daily harvest');
    expect(sent).toHaveLength(1);
  });
});
