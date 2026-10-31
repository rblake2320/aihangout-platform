// AIH-R2: stable public identifiers.
//
// Integer ids stay internal (joins, foreign keys, existing API fields). Every public
// URL and API path also accepts a UUIDv7 public_id, and always will. Slugs are a pure
// function of the current title: they are never an identity, and a URL carrying a
// missing or stale slug redirects to the current one.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isPublicId = (value) => typeof value === 'string' && UUID_RE.test(value);

// RFC 9562 UUIDv7: 48-bit Unix ms timestamp, version 7, variant 10, 74 random bits.
export function uuidv7(now = Date.now()) {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let ts = BigInt(now);
  for (let i = 5; i >= 0; i--) { b[i] = Number(ts & 0xffn); ts >>= 8n; }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Same construction in SQL, for backfilling rows written by paths that do not set it.
// Matches migrations/0023_public_ids.sql.
export function uuidv7Sql(timestampColumn) {
  const ms = `printf('%012x', CAST(round((julianday(COALESCE(${timestampColumn}, CURRENT_TIMESTAMP)) - 2440587.5) * 86400000) AS INTEGER))`;
  return `lower(substr(${ms}, 1, 8) || '-' || substr(${ms}, 9, 4) || '-7' || substr(hex(randomblob(2)), 2, 3) || '-' || ` +
    `substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6)))`;
}

export function slugify(title) {
  const slug = String(title ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'problem';
}

export const problemPath = (p) => `/problem/${p.public_id}/${slugify(p.title)}`;

const TABLES = {
  problems: { table: 'problems', ts: 'created_at' },
  solutions: { table: 'solutions', ts: 'created_at' },
  users: { table: 'users', ts: 'join_date' }
};

// Assign a public_id to rows that lack one (rows written before this migration ran, or
// by an insert path that does not set it). Idempotent; bounded per call.
export async function backfillPublicIds(db, kind, limit = 500) {
  const t = TABLES[kind];
  await db.prepare(`UPDATE ${t.table} SET public_id = ${uuidv7Sql(t.ts)}
    WHERE id IN (SELECT id FROM ${t.table} WHERE public_id IS NULL ORDER BY id LIMIT ?)`).bind(limit).run();
}

// public_id for one internal id, assigning it on first use. The conditional UPDATE is
// atomic, so concurrent first readers converge on one value.
export async function publicIdFor(db, kind, id) {
  const t = TABLES[kind];
  const row = await db.prepare(`SELECT public_id FROM ${t.table} WHERE id = ?`).bind(id).first();
  if (!row) return null;
  if (row.public_id) return row.public_id;
  await db.prepare(`UPDATE ${t.table} SET public_id = ${uuidv7Sql(t.ts)} WHERE id = ? AND public_id IS NULL`).bind(id).run();
  return (await db.prepare(`SELECT public_id FROM ${t.table} WHERE id = ?`).bind(id).first())?.public_id ?? null;
}

export async function internalIdFor(db, kind, publicId) {
  const t = TABLES[kind];
  const row = await db.prepare(`SELECT id FROM ${t.table} WHERE public_id = ?`).bind(String(publicId).toLowerCase()).first();
  return row ? row.id : null;
}

// /api/problems/<uuid>/solutions/<uuid>/accept -> /api/problems/12/solutions/34/accept.
// A UUID segment is resolved by the collection named just before it; every existing
// integer route therefore accepts public ids without per-handler changes.
// Returns { pathname } (unchanged when nothing to resolve) or { notFound: kind }.
export async function resolvePublicPath(db, pathname) {
  const parts = pathname.split('/');
  let changed = false;
  for (let i = 1; i < parts.length; i++) {
    const kind = parts[i - 1];
    if (!TABLES[kind] || !isPublicId(parts[i])) continue;
    const id = await internalIdFor(db, kind, parts[i]);
    if (id == null) return { notFound: kind };
    parts[i] = String(id);
    changed = true;
  }
  return { pathname: changed ? parts.join('/') : pathname, changed };
}
