// AIH-R5: email that reaches people. Everything here takes `env` and an injected `send`
// function (sendTransactionalEmail in worker.js) so there is no import cycle and tests can
// observe exactly what would be sent.
//
// Guarantees (each covered in test/email-outbox.test.js):
//  - one row, and so one email, per event: dedupe_key is UNIQUE and is also the provider
//    idempotency key
//  - sending is claimed (pending -> sending) before the provider call, so overlapping cron runs
//    cannot double-send
//  - eligibility (verified address, category on, not unsubscribed) is re-checked at send time,
//    so unsubscribing after something was queued still stops it
//  - every email carries a signed one-click unsubscribe link and List-Unsubscribe headers

export const CATEGORIES = ['solutions', 'mentions', 'digest'];
const TYPE_TO_CATEGORY = {
  new_solution: 'solutions',
  solution_verified: 'solutions',
  mention: 'mentions',
  comment: 'mentions',
};
const COLUMN = { solutions: 'email_solutions', mentions: 'email_mentions', digest: 'email_digest' };
const MAX_ATTEMPTS = 5;

export const emailCategoryFor = (notificationType) => TYPE_TO_CATEGORY[notificationType] || null;

export const publicBaseUrl = (env) => (env.PUBLIC_BASE_URL || 'https://aihangout.ai').replace(/\/+$/, '');

export const escapeHtml = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

// Header-injection guard for anything user-controlled that ends up in a subject line.
const oneLine = (s, max = 150) => String(s ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim().slice(0, max);

// ---- unsubscribe tokens (stateless, HMAC-SHA256 over the server secret) ---------------------

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

async function hmac(env, message) {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET is required to sign unsubscribe tokens');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`unsubscribe-v1:${env.JWT_SECRET}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

export async function makeUnsubscribeToken(env, userId, category) {
  const scope = category === 'all' ? 'all' : category;
  if (scope !== 'all' && !CATEGORIES.includes(scope)) throw new Error(`unknown email category: ${category}`);
  return `${userId}.${scope}.${await hmac(env, `${userId}.${scope}`)}`;
}

export async function verifyUnsubscribeToken(env, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [id, scope, sig] = parts;
  const userId = Number(id);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (scope !== 'all' && !CATEGORIES.includes(scope)) return null;
  const expected = await hmac(env, `${userId}.${scope}`);
  if (expected.length !== sig.length) return null;
  let diff = 0; // constant-time compare
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? { userId, scope } : null;
}

export async function applyUnsubscribe(env, { userId, scope }) {
  const db = env.AIHANGOUT_DB;
  await db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').bind(userId).run();
  if (scope === 'all') {
    await db.prepare('UPDATE user_settings SET email_unsubscribed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').bind(userId).run();
  } else {
    await db.prepare(`UPDATE user_settings SET ${COLUMN[scope]} = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).bind(userId).run();
  }
  // Anything already queued for that scope must not go out.
  const where = scope === 'all' ? '' : ' AND category = ?';
  const binds = scope === 'all' ? [userId] : [userId, scope];
  await db.prepare(`UPDATE email_outbox SET status = 'suppressed', last_error = 'unsubscribed' WHERE user_id = ? AND status IN ('pending', 'sending')${where}`)
    .bind(...binds).run();
}

export async function getEmailPreferences(env, userId) {
  const s = await env.AIHANGOUT_DB.prepare('SELECT * FROM user_settings WHERE user_id = ?').bind(userId).first();
  return {
    solutions: s ? !!s.email_solutions : true,
    mentions: s ? !!s.email_mentions : true,
    digest: s ? !!s.email_digest : true,
    unsubscribed_all: !!(s && s.email_unsubscribed_at),
  };
}

export async function setEmailPreferences(env, userId, prefs) {
  const db = env.AIHANGOUT_DB;
  await db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').bind(userId).run();
  for (const c of CATEGORIES) {
    if (typeof prefs[c] === 'boolean') {
      await db.prepare(`UPDATE user_settings SET ${COLUMN[c]} = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).bind(prefs[c] ? 1 : 0, userId).run();
    }
  }
  if (prefs.unsubscribed_all === true) {
    await db.prepare('UPDATE user_settings SET email_unsubscribed_at = COALESCE(email_unsubscribed_at, CURRENT_TIMESTAMP) WHERE user_id = ?').bind(userId).run();
  } else if (prefs.unsubscribed_all === false) {
    await db.prepare('UPDATE user_settings SET email_unsubscribed_at = NULL WHERE user_id = ?').bind(userId).run();
  }
  return getEmailPreferences(env, userId);
}

// ---- enqueue --------------------------------------------------------------------------------

/** Queue one email. Returns true if a new row was created, false if this event was already queued. */
export async function enqueueEmail(env, { userId, category, kind, dedupeKey, subject, text, html, linkPath }) {
  if (!CATEGORIES.includes(category)) throw new Error(`unknown email category: ${category}`);
  if (!userId || !dedupeKey) throw new Error('enqueueEmail needs userId and dedupeKey');
  const r = await env.AIHANGOUT_DB.prepare(`
    INSERT OR IGNORE INTO email_outbox (user_id, category, kind, dedupe_key, subject, body_text, body_html, link_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(userId, category, kind, dedupeKey.slice(0, 200), oneLine(subject), String(text), String(html), linkPath ?? null).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** Queue the email for an in-app notification, if its type is one that is emailed. */
export async function enqueueNotificationEmail(env, { userId, actorId, type, targetType, targetId, message, sourceType, sourceId }) {
  const category = emailCategoryFor(type);
  if (!category) return false;
  const linkPath = targetType === 'problem' && targetId ? `/problem/${targetId}` : '/';
  const subject = {
    new_solution: 'New answer to your question on AI Hangout',
    solution_verified: 'Your answer was verified on AI Hangout',
    mention: 'You were mentioned on AI Hangout',
    comment: 'New comment on AI Hangout',
  }[type];
  return enqueueEmail(env, {
    userId, category, kind: type,
    dedupeKey: `${type}:${userId}:${actorId ?? 0}:${sourceType ?? targetType ?? 'x'}:${sourceId ?? targetId ?? 0}`,
    subject,
    text: String(message),
    html: `<p>${escapeHtml(message)}</p>`,
    linkPath,
  });
}

// ---- mentions -------------------------------------------------------------------------------

export function extractMentions(text, max = 10) {
  const found = new Set();
  const re = /(?<![\w@.\-])@([A-Za-z0-9_][A-Za-z0-9_.\-]{1,49})/g;
  for (const m of String(text ?? '').matchAll(re)) {
    found.add(m[1].replace(/[.\-]+$/, '').toLowerCase());
    if (found.size >= max) break;
  }
  return [...found].filter((n) => n.length >= 2);
}

export async function resolveMentions(env, text, { excludeUserIds = [] } = {}) {
  const names = extractMentions(text);
  if (!names.length) return [];
  const marks = names.map(() => '?').join(',');
  const rows = await env.AIHANGOUT_DB.prepare(
    `SELECT id, username FROM users WHERE lower(username) IN (${marks})`).bind(...names).all();
  const skip = new Set(excludeUserIds);
  return (rows.results || []).filter((u) => !skip.has(u.id));
}

// ---- flush (cron) ---------------------------------------------------------------------------

async function recipientFor(env, userId, category) {
  const row = await env.AIHANGOUT_DB.prepare(`
    SELECT u.email, u.email_verified_at, u.username,
           s.email_unsubscribed_at, s.email_solutions, s.email_mentions, s.email_digest
    FROM users u LEFT JOIN user_settings s ON s.user_id = u.id WHERE u.id = ?`).bind(userId).first();
  if (!row || !row.email || !row.email_verified_at) return { ok: false, why: 'no_verified_email' };
  if (row.email_unsubscribed_at) return { ok: false, why: 'unsubscribed' };
  const flag = row[COLUMN[category]];
  if (flag === 0) return { ok: false, why: 'category_off' };
  return { ok: true, email: row.email, username: row.username };
}

export async function renderEmail(env, row, recipient) {
  const base = publicBaseUrl(env);
  const link = `${base}${row.link_path || '/'}`;
  const unsub = `${base}/api/email/unsubscribe?t=${await makeUnsubscribeToken(env, row.user_id, row.category)}`;
  const unsubAll = `${base}/api/email/unsubscribe?t=${await makeUnsubscribeToken(env, row.user_id, 'all')}`;
  const label = { solutions: 'answer notifications', mentions: 'mention notifications', digest: 'the weekly digest' }[row.category];
  return {
    to: recipient.email,
    subject: row.subject,
    text: `${row.body_text}\n\nOpen AI Hangout: ${link}\n\n--\nStop ${label}: ${unsub}\nStop all email from AI Hangout: ${unsubAll}`,
    html: `${row.body_html}<p><a href="${escapeHtml(link)}">Open AI Hangout</a></p>`
      + `<hr><p style="font-size:12px;color:#666">`
      + `<a href="${escapeHtml(unsub)}">Stop ${label}</a> · <a href="${escapeHtml(unsubAll)}">Stop all email</a></p>`,
    idempotencyKey: row.dedupe_key,
    headers: {
      'List-Unsubscribe': `<${unsub}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

/**
 * Send pending rows. `send(env, message)` must return {skipped:true} when no provider is
 * configured (rows then stay pending untouched) and throw on a provider rejection.
 */
export async function flushOutbox(env, send, { limit = 50 } = {}) {
  const db = env.AIHANGOUT_DB;
  const out = { sent: 0, suppressed: 0, failed: 0, retry: 0, claimed_elsewhere: 0, provider_unconfigured: false };
  // A run that died after claiming leaves 'sending' behind; hand those back.
  await db.prepare(`UPDATE email_outbox SET status = 'pending' WHERE status = 'sending' AND claimed_at < datetime('now', '-15 minutes')`).run();
  const pending = await db.prepare(`SELECT * FROM email_outbox WHERE status = 'pending' ORDER BY id LIMIT ?`).bind(limit).all();
  for (const row of pending.results || []) {
    const claim = await db.prepare(
      `UPDATE email_outbox SET status = 'sending', claimed_at = CURRENT_TIMESTAMP, attempts = attempts + 1 WHERE id = ? AND status = 'pending'`
    ).bind(row.id).run();
    if (!(claim.meta?.changes > 0)) { out.claimed_elsewhere++; continue; }

    const recipient = await recipientFor(env, row.user_id, row.category);
    if (!recipient.ok) {
      await db.prepare(`UPDATE email_outbox SET status = 'suppressed', last_error = ? WHERE id = ?`).bind(recipient.why, row.id).run();
      out.suppressed++;
      continue;
    }
    try {
      const result = await send(env, await renderEmail(env, row, recipient));
      if (result?.skipped) {
        // No provider configured: not a delivery attempt. Put it back and stop the run.
        await db.prepare(`UPDATE email_outbox SET status = 'pending', attempts = attempts - 1 WHERE id = ?`).bind(row.id).run();
        out.provider_unconfigured = true;
        break;
      }
      await db.prepare(`UPDATE email_outbox SET status = 'sent', sent_at = CURRENT_TIMESTAMP, provider_id = ?, last_error = NULL WHERE id = ?`)
        .bind(result?.id ?? null, row.id).run();
      out.sent++;
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 500);
      const final = row.attempts + 1 >= MAX_ATTEMPTS;
      await db.prepare(`UPDATE email_outbox SET status = ?, last_error = ? WHERE id = ?`).bind(final ? 'failed' : 'pending', msg, row.id).run();
      if (final) out.failed++; else out.retry++;
    }
  }
  return out;
}

// ---- weekly digest --------------------------------------------------------------------------

export function weekStartUtc(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
  return d.toISOString().slice(0, 10);
}

/**
 * Queue one digest per eligible user for the week containing `now`. Idempotent: a user is
 * decided exactly once per week (a 'suppressed' row records "nothing to report"), so running the
 * cron twice, or paging through a large user table, never duplicates or starves anyone.
 */
export async function enqueueWeeklyDigests(env, { now = new Date(), limit = 500 } = {}) {
  const db = env.AIHANGOUT_DB;
  const week = weekStartUtc(now);
  const base = publicBaseUrl(env);
  const candidates = await db.prepare(`
    SELECT u.id, u.username FROM users u LEFT JOIN user_settings s ON s.user_id = u.id
    WHERE u.email_verified_at IS NOT NULL
      AND COALESCE(s.email_digest, 1) = 1 AND s.email_unsubscribed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM email_outbox o WHERE o.dedupe_key = 'digest:' || u.id || ':' || ?)
    ORDER BY u.id LIMIT ?`).bind(week, limit).all();
  const out = { week, queued: 0, nothing_to_report: 0 };
  for (const u of candidates.results || []) {
    const answered = await db.prepare(`
      SELECT p.id, p.title, COUNT(s.id) AS n FROM problems p JOIN solutions s ON s.problem_id = p.id
      WHERE p.user_id = ? AND s.user_id <> p.user_id AND s.created_at > datetime('now', '-7 days')
      GROUP BY p.id ORDER BY n DESC, p.id DESC LIMIT 5`).bind(u.id).all();
    const unread = await db.prepare(`
      SELECT message FROM notifications WHERE user_id = ? AND is_read = FALSE AND created_at > datetime('now', '-7 days')
      ORDER BY created_at DESC LIMIT 5`).bind(u.id).all();
    const unreadCount = await db.prepare(`
      SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = FALSE AND created_at > datetime('now', '-7 days')`).bind(u.id).first();
    const key = `digest:${u.id}:${week}`;
    if (!(answered.results || []).length && !(unreadCount?.n > 0)) {
      await db.prepare(`INSERT OR IGNORE INTO email_outbox (user_id, category, kind, dedupe_key, subject, body_text, body_html, status, last_error)
        VALUES (?, 'digest', 'weekly_digest', ?, '', '', '', 'suppressed', 'nothing_to_report')`).bind(u.id, key).run();
      out.nothing_to_report++;
      continue;
    }
    const lines = [`Your week on AI Hangout, ${u.username}:`];
    const htmlParts = [`<p>Your week on AI Hangout, ${escapeHtml(u.username)}:</p>`];
    if (answered.results?.length) {
      lines.push('', 'New answers to your questions:');
      htmlParts.push('<p><strong>New answers to your questions</strong></p><ul>');
      for (const p of answered.results) {
        const t = oneLine(p.title, 120);
        lines.push(`- ${t} (${p.n} new) ${base}/problem/${p.id}`);
        htmlParts.push(`<li><a href="${escapeHtml(`${base}/problem/${p.id}`)}">${escapeHtml(t)}</a> (${p.n} new)</li>`);
      }
      htmlParts.push('</ul>');
    }
    if (unreadCount?.n > 0) {
      lines.push('', `${unreadCount.n} unread notification${unreadCount.n === 1 ? '' : 's'}:`);
      htmlParts.push(`<p><strong>${unreadCount.n} unread notification${unreadCount.n === 1 ? '' : 's'}</strong></p><ul>`);
      for (const n of unread.results || []) {
        lines.push(`- ${oneLine(n.message, 160)}`);
        htmlParts.push(`<li>${escapeHtml(oneLine(n.message, 160))}</li>`);
      }
      htmlParts.push('</ul>');
    }
    const made = await enqueueEmail(env, {
      userId: u.id, category: 'digest', kind: 'weekly_digest', dedupeKey: key,
      subject: 'Your weekly AI Hangout digest', text: lines.join('\n'), html: htmlParts.join(''), linkPath: '/',
    });
    if (made) out.queued++;
  }
  return out;
}

// ---- unsubscribe page -----------------------------------------------------------------------

export function unsubscribePage({ token, scope, done, error }) {
  const body = error
    ? `<p>${escapeHtml(error)}</p>`
    : done
      ? `<p>Done. You will no longer receive ${scope === 'all' ? 'any email' : `${escapeHtml(scope)} email`} from AI Hangout.</p>`
      : `<p>Stop ${scope === 'all' ? 'all email' : escapeHtml(scope) + ' email'} from AI Hangout?</p>`
        + `<form method="post" action="/api/email/unsubscribe"><input type="hidden" name="t" value="${escapeHtml(token)}">`
        + `<button type="submit">Unsubscribe</button></form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Email preferences - AI Hangout</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem">${body}</body></html>`;
}
