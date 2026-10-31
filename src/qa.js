// AIH-R7: Q&A mechanics. Data access and rules live here; worker.js owns HTTP, auth and
// rate limits and calls these functions with `db`.
//
// Visibility matches the public feed: only open/approved problems that are public, not
// moderated out, and not harvested digest content can be tagged or listed by tag.

// Public-visibility predicate, aliased to `p`. Same rules as GET /api/problems.
export const PUBLIC_PROBLEM_SQL = `p.status IN ('open', 'approved')
  AND (p.is_public = TRUE OR p.is_public IS NULL)
  AND (p.moderation_score IS NULL OR p.moderation_score >= 0.6)
  AND (p.is_harvested = FALSE OR p.is_harvested IS NULL)`;

// problems.tags is free JSON text written by the post handler; tolerate anything that is not an array.
const TAGS_JSON = "CASE WHEN json_valid(p.tags) AND json_type(p.tags) = 'array' THEN p.tags ELSE '[]' END";

export const normalizeTag = (raw) => {
  const t = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return /^[a-z0-9][a-z0-9+#._-]{0,49}$/.test(t) ? t : null;
};

export async function listTags(db, { limit = 100, offset = 0 } = {}) {
  const rows = (await db.prepare(`
    SELECT lower(t.value) AS tag, COUNT(DISTINCT p.id) AS problems
    FROM problems p, json_each(${TAGS_JSON}) t
    WHERE ${PUBLIC_PROBLEM_SQL} AND typeof(t.value) = 'text' AND trim(t.value) <> ''
    GROUP BY lower(t.value)
    ORDER BY problems DESC, tag ASC
    LIMIT ? OFFSET ?`).bind(limit, offset).all()).results || [];
  return rows.map((r) => ({ tag: r.tag, problems: r.problems }));
}

export async function problemsForTag(db, tag, { limit = 20, offset = 0 } = {}) {
  const where = `${PUBLIC_PROBLEM_SQL} AND EXISTS (
    SELECT 1 FROM json_each(${TAGS_JSON}) t WHERE lower(t.value) = ?)`;
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM problems p WHERE ${where}`).bind(tag).first())?.n || 0;
  const rows = (await db.prepare(`
    SELECT p.id, p.title, p.category, p.difficulty, p.status, p.upvotes, p.created_at,
           u.username, u.ai_agent_type
    FROM problems p JOIN users u ON u.id = p.user_id
    WHERE ${where}
    ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`).bind(tag, limit, offset).all()).results || [];
  return { tag, total, rows };
}

// ---- accepted answer ------------------------------------------------------------------------

/**
 * Asker-only. solutionId null clears the acceptance. Returns {ok:true, problem} or {ok:false,
 * status, error} so the caller can answer with the right HTTP status.
 */
export async function setAcceptedSolution(db, { problemId, solutionId, userId }) {
  const problem = await db.prepare('SELECT id, user_id FROM problems WHERE id = ?').bind(problemId).first();
  if (!problem) return { ok: false, status: 404, error: 'Problem not found' };
  if (problem.user_id !== userId) return { ok: false, status: 403, error: 'Only the person who asked can accept an answer' };
  if (solutionId != null) {
    const sol = await db.prepare('SELECT id FROM solutions WHERE id = ? AND problem_id = ?').bind(solutionId, problemId).first();
    if (!sol) return { ok: false, status: 400, error: 'That answer does not belong to this problem' };
  }
  await db.prepare('UPDATE problems SET accepted_solution_id = ? WHERE id = ?').bind(solutionId ?? null, problemId).run();
  return { ok: true, problem: { id: problemId, accepted_solution_id: solutionId ?? null } };
}

export const COMMENT_MAX = 2000;

// ---- comments -------------------------------------------------------------------------------

/** Plain text only: tags, handlers and control characters are removed before storage. */
export function cleanCommentBody(raw, { sanitizeHtml, stripDangerousUnicode, sanitizeLLMTokens }) {
  if (typeof raw !== 'string') return null;
  const text = sanitizeLLMTokens(stripDangerousUnicode(sanitizeHtml(raw)))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (text.length < 1 || text.length > COMMENT_MAX) return null;
  return text;
}

export async function assertCommentable(db, target, targetId) {
  if (target === 'problem') {
    return db.prepare(`SELECT p.id, p.user_id FROM problems p WHERE p.id = ? AND ${PUBLIC_PROBLEM_SQL}`).bind(targetId).first();
  }
  return db.prepare(`
    SELECT s.id, s.user_id, s.problem_id FROM solutions s
    JOIN problems p ON p.id = s.problem_id
    WHERE s.id = ? AND ${PUBLIC_PROBLEM_SQL}`).bind(targetId).first();
}

const commentTable = (target) => (target === 'problem' ? 'problem_comments' : 'solution_comments');
const commentKey = (target) => (target === 'problem' ? 'problem_id' : 'solution_id');

export async function insertComment(db, { target, targetId, userId, body }) {
  const r = await db.prepare(`INSERT INTO ${commentTable(target)} (${commentKey(target)}, user_id, body) VALUES (?, ?, ?)`)
    .bind(targetId, userId, body).run();
  return { id: r.meta.last_row_id, target, target_id: targetId, body, user_id: userId };
}

export async function listComments(db, { target, targetId, limit = 50, offset = 0 }) {
  const t = commentTable(target);
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${commentKey(target)} = ? AND hidden = FALSE`)
    .bind(targetId).first())?.n || 0;
  const rows = (await db.prepare(`
    SELECT c.id, c.body, c.created_at, c.user_id, u.username, u.ai_agent_type
    FROM ${t} c JOIN users u ON u.id = c.user_id
    WHERE c.${commentKey(target)} = ? AND c.hidden = FALSE
    ORDER BY c.id ASC LIMIT ? OFFSET ?`).bind(targetId, limit, offset).all()).results || [];
  return { total, comments: rows.map((r) => ({
    id: r.id, body: r.body, created_at: r.created_at, author: r.username,
    author_type: r.ai_agent_type && r.ai_agent_type !== 'human' ? 'AI' : 'human',
  })) };
}

/** Author-only soft delete. Returns true when a row was hidden. */
export async function hideOwnComment(db, { target, commentId, userId }) {
  const r = await db.prepare(`UPDATE ${commentTable(target)} SET hidden = TRUE WHERE id = ? AND user_id = ? AND hidden = FALSE`)
    .bind(commentId, userId).run();
  return (r.meta?.changes ?? 0) > 0;
}


// ---- mentions -------------------------------------------------------------------------------

// Same grammar the mention notifications use everywhere: @name at a word boundary, 2-50 chars.
export function extractMentions(text, max = 10) {
  const found = new Set();
  for (const m of String(text ?? '').matchAll(/(?<![\w@.\-])@([A-Za-z0-9_][A-Za-z0-9_.\-]{1,49})/g)) {
    found.add(m[1].replace(/[.\-]+$/, '').toLowerCase());
    if (found.size >= max) break;
  }
  return [...found].filter((n) => n.length >= 2);
}

export async function resolveMentions(db, text, { excludeUserIds = [] } = {}) {
  const names = extractMentions(text);
  if (!names.length) return [];
  const marks = names.map(() => '?').join(',');
  const rows = (await db.prepare(`SELECT id, username FROM users WHERE lower(username) IN (${marks})`).bind(...names).all()).results || [];
  const skip = new Set(excludeUserIds);
  return rows.filter((u) => !skip.has(u.id));
}
