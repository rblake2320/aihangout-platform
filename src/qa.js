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
