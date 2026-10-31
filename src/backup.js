// AIH-R3: nightly D1 -> R2 export, verification, retention and restore.
//
// Layout in the bucket (manifest is written LAST, so a prefix without
// manifest.json is an incomplete run and is never trusted or restored):
//   backups/<YYYY-MM-DD>/schema.json                  tables, indexes, triggers, views (sqlite_master)
//   backups/<YYYY-MM-DD>/<table>/part-00001.jsonl.gz  one JSON object per row, gzip
//   backups/<YYYY-MM-DD>/manifest.json                tables, parts, row counts, SHA-256 of every object
//   backups/latest.json                               pointer to the newest complete prefix
//
// Values: null/number/string as-is; BLOBs as {"$b64": "..."}.

export const BACKUP_ROOT = 'backups';
export const PART_MAX_ROWS = 2000;
export const PART_MAX_BYTES = 8 * 1024 * 1024;
export const RETENTION = { dailyDays: 14, weeklyDays: 56, monthlyDays: 366 };
const MANIFEST_VERSION = 1;
const INSERT_BATCH = 50;

const enc = new TextEncoder();
const dec = new TextDecoder();
const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

export async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function pipeThrough(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const gzip = (text) => pipeThrough(enc.encode(text), new CompressionStream('gzip'));
const gunzip = async (bytes) => dec.decode(await pipeThrough(bytes, new DecompressionStream('gzip')));

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const encodeValue = (v) => (Array.isArray(v) ? { $b64: b64(Uint8Array.from(v)) } : v);
export const decodeValue = (v) => (v && typeof v === 'object' && '$b64' in v ? unb64(v.$b64).buffer : v);

export const backupPrefix = (date) => `${BACKUP_ROOT}/${date}/`;
export const dateKey = (d) => d.toISOString().slice(0, 10);

async function readSchema(db) {
  const { results } = await db.prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE type IN ('table','index','trigger','view') AND sql IS NOT NULL
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name`
  ).all();
  return results;
}

/** Export every row of one table as gzipped JSONL parts; returns the part descriptors. */
async function exportTable(db, bucket, prefix, table) {
  const parts = [];
  let lines = [];
  let bytes = 0;
  let rows = 0;
  const flush = async () => {
    if (!lines.length) return;
    const n = parts.length + 1;
    const key = `${prefix}${table}/part-${String(n).padStart(5, '0')}.jsonl.gz`;
    const body = await gzip(lines.join('\n') + '\n');
    await bucket.put(key, body, { httpMetadata: { contentType: 'application/gzip' } });
    parts.push({ key, rows: lines.length, bytes: body.length, sha256: await sha256Hex(body) });
    lines = [];
    bytes = 0;
  };
  let lastRowid = -1;
  for (;;) {
    const { results } = await db.prepare(
      `SELECT rowid AS __rid, * FROM ${q(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`
    ).bind(lastRowid, PART_MAX_ROWS).all();
    if (!results.length) break;
    for (const row of results) {
      lastRowid = row.__rid;
      delete row.__rid;
      const obj = {};
      for (const [k, v] of Object.entries(row)) obj[k] = encodeValue(v);
      const line = JSON.stringify(obj);
      lines.push(line);
      bytes += line.length;
      rows += 1;
      if (lines.length >= PART_MAX_ROWS || bytes >= PART_MAX_BYTES) await flush();
    }
    if (results.length < PART_MAX_ROWS) break;
  }
  await flush();
  return { name: table, rows, parts };
}

/**
 * Export the whole database. Throws on any failure (fail loud); an incomplete
 * run has no manifest.json and is therefore ignored by verify/restore/retention.
 */
export async function runBackup(env, { now = new Date() } = {}) {
  const db = env.AIHANGOUT_DB;
  const bucket = env.BACKUP_BUCKET;
  if (!bucket) throw new Error('BACKUP_BUCKET binding missing');
  const date = dateKey(now);
  const prefix = backupPrefix(date);
  await bucket.delete(`${prefix}manifest.json`); // a re-run on the same day is incomplete until it finishes

  const schema = await readSchema(db);
  const schemaBytes = enc.encode(JSON.stringify(schema));
  await bucket.put(`${prefix}schema.json`, schemaBytes, { httpMetadata: { contentType: 'application/json' } });

  const tables = [];
  for (const t of schema.filter((s) => s.type === 'table')) {
    tables.push(await exportTable(db, bucket, prefix, t.name));
  }
  const manifest = {
    version: MANIFEST_VERSION,
    created_at: now.toISOString(),
    prefix,
    schema: { key: `${prefix}schema.json`, bytes: schemaBytes.length, sha256: await sha256Hex(schemaBytes) },
    tables,
    totals: { tables: tables.length, rows: tables.reduce((n, t) => n + t.rows, 0), parts: tables.reduce((n, t) => n + t.parts.length, 0) },
  };
  const manifestBytes = enc.encode(JSON.stringify(manifest, null, 2));
  await bucket.put(`${prefix}manifest.json`, manifestBytes, { httpMetadata: { contentType: 'application/json' } });
  await bucket.put(`${BACKUP_ROOT}/latest.json`, JSON.stringify({
    prefix, created_at: manifest.created_at, manifest_sha256: await sha256Hex(manifestBytes),
  }), { httpMetadata: { contentType: 'application/json' } });
  return manifest;
}

async function getBytes(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`missing object ${key}`);
  return new Uint8Array(await obj.arrayBuffer());
}

/** Re-hash every object named by the manifest. Returns { ok, errors, manifest }. */
export async function verifyBackup(bucket, prefix) {
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(dec.decode(await getBytes(bucket, `${prefix}manifest.json`)));
  } catch (e) {
    return { ok: false, errors: [`manifest: ${e.message}`], manifest: null };
  }
  if (manifest.version !== MANIFEST_VERSION) errors.push(`unsupported manifest version ${manifest.version}`);
  const check = async (key, sha256, bytes) => {
    try {
      const b = await getBytes(bucket, key);
      if (b.length !== bytes) errors.push(`${key}: size ${b.length} != ${bytes}`);
      if ((await sha256Hex(b)) !== sha256) errors.push(`${key}: sha256 mismatch`);
    } catch (e) {
      errors.push(e.message);
    }
  };
  await check(manifest.schema.key, manifest.schema.sha256, manifest.schema.bytes);
  for (const t of manifest.tables) for (const p of t.parts) await check(p.key, p.sha256, p.bytes);
  return { ok: errors.length === 0, errors, manifest };
}

/**
 * Restore a verified backup into `db` (intended for a scratch database). Refuses
 * to run if verification fails, or if the target already has user tables.
 * Returns per-table { expected, restored } and ok = every count matches.
 */
export async function restoreBackup({ bucket, prefix, db }) {
  const v = await verifyBackup(bucket, prefix);
  if (!v.ok) throw new Error(`backup ${prefix} failed verification: ${v.errors.join('; ')}`);
  const existing = await readSchema(db);
  if (existing.some((s) => s.type === 'table')) throw new Error('restore target is not empty; refusing to overwrite');

  const schema = JSON.parse(dec.decode(await getBytes(bucket, v.manifest.schema.key)));
  const ddl = (type) => schema.filter((s) => s.type === type).map((s) => db.prepare(s.sql));
  await db.batch(ddl('table'));

  for (const t of v.manifest.tables) {
    for (const p of t.parts) {
      const rows = (await gunzip(await getBytes(bucket, p.key))).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if (rows.length !== p.rows) throw new Error(`${p.key}: ${rows.length} rows, manifest says ${p.rows}`);
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const stmts = [db.prepare('PRAGMA defer_foreign_keys = ON')];
        for (const row of rows.slice(i, i + INSERT_BATCH)) {
          const cols = Object.keys(row);
          stmts.push(db.prepare(`INSERT INTO ${q(t.name)} (${cols.map(q).join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
            .bind(...cols.map((c) => decodeValue(row[c]))));
        }
        await db.batch(stmts);
      }
    }
  }
  // Indexes, views and triggers go last so triggers cannot fire during the bulk load.
  for (const type of ['view', 'index', 'trigger']) {
    const stmts = ddl(type);
    if (stmts.length) await db.batch(stmts); // D1 rejects an empty batch
  }

  const report = [];
  for (const t of v.manifest.tables) {
    const { n } = await db.prepare(`SELECT COUNT(*) AS n FROM ${q(t.name)}`).first();
    report.push({ table: t.name, expected: t.rows, restored: n });
  }
  return { ok: report.every((r) => r.expected === r.restored), tables: report, manifest: v.manifest };
}

const dayMs = 86400000;
const weekKey = (d) => {
  const t = new Date(`${d}T00:00:00Z`);
  const monday = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * dayMs);
  return monday.toISOString().slice(0, 10);
};

/**
 * Pure retention policy over complete-backup dates (YYYY-MM-DD). Keeps:
 *  - every backup from the last `dailyDays` days,
 *  - the earliest backup of each ISO week for `weeklyDays`,
 *  - the earliest backup of each month for `monthlyDays`,
 *  - always the newest backup, whatever its age.
 */
export function selectRetained(dates, today, policy = RETENTION) {
  const sorted = [...new Set(dates)].sort();
  const age = (d) => Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / dayMs);
  const keep = new Set();
  if (sorted.length) keep.add(sorted[sorted.length - 1]);
  for (const d of sorted) if (age(d) <= policy.dailyDays) keep.add(d);
  const firstOf = (keyFn, maxAge) => {
    const seen = new Set();
    for (const d of sorted) {
      if (age(d) > maxAge) continue;
      const k = keyFn(d);
      if (!seen.has(k)) { seen.add(k); keep.add(d); }
    }
  };
  firstOf(weekKey, policy.weeklyDays);
  firstOf((d) => d.slice(0, 7), policy.monthlyDays);
  return keep;
}

/** Delete complete backups outside the retention policy. Incomplete prefixes older than a day are removed too. */
export async function applyRetention(bucket, { now = new Date(), policy = RETENTION } = {}) {
  const listing = await bucket.list({ prefix: `${BACKUP_ROOT}/`, delimiter: '/' });
  const dirs = (listing.delimitedPrefixes || []).filter((p) => /^backups\/\d{4}-\d{2}-\d{2}\/$/.test(p));
  const complete = [];
  const incomplete = [];
  for (const p of dirs) ((await bucket.head(`${p}manifest.json`)) ? complete : incomplete).push(p);
  const today = dateKey(now);
  const keep = selectRetained(complete.map((p) => p.split('/')[1]), today, policy);
  const doomed = complete.filter((p) => !keep.has(p.split('/')[1]));
  doomed.push(...incomplete.filter((p) => p.split('/')[1] < today));
  for (const p of doomed) {
    let cursor;
    do {
      const page = await bucket.list({ prefix: p, cursor });
      if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return { kept: [...keep].sort(), deleted: doomed.sort() };
}
