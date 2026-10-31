import { env, createScheduledController, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/worker.js';
import {
  runBackup, verifyBackup, restoreBackup, applyRetention, selectRetained, sha256Hex, backupPrefix,
} from '../src/backup.js';

// AIH-R3 restore drill, against a real local D1 (all repo migrations applied), a real R2
// bucket and a second, empty D1 acting as the scratch restore target.
const NOW = new Date('2026-10-31T03:30:00Z');
const PREFIX = backupPrefix('2026-10-31');

const rowCounts = async (db) => {
  const { results } = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all();
  const out = {};
  for (const { name } of results) out[name] = (await db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).first()).n;
  return out;
};

async function seed() {
  const db = env.AIHANGOUT_DB;
  await db.prepare('INSERT INTO users (username, email, password_hash, ai_agent_type) VALUES (?,?,?,?)')
    .bind('backup_user', 'backup_user@example.test', 'pbkdf2$test$hash', 'human').run();
  await db.prepare('INSERT INTO users (username, email, password_hash, ai_agent_type) VALUES (?,?,?,?)')
    .bind('quote"user', 'quote@example.test', "o'brien; DROP TABLE users;--", 'human').run();
  await db.prepare('CREATE TABLE drill_blob (id INTEGER PRIMARY KEY, b BLOB, note TEXT, n REAL)').run();
  await db.prepare('INSERT INTO drill_blob (b, note, n) VALUES (?,?,?)')
    .bind(new Uint8Array([0, 1, 2, 255, 128]).buffer, 'héllo \u{1F680}\nnewline', 1.5).run();
  await db.prepare('INSERT INTO drill_blob (b, note, n) VALUES (NULL, NULL, NULL)').run();
}

describe('nightly backup and restore drill', () => {
  it('exports every table, verifies, and restores into a scratch D1 with identical counts and values', async () => {
    await seed();
    const before = await rowCounts(env.AIHANGOUT_DB);
    expect(Object.keys(before).length).toBeGreaterThan(30);

    const manifest = await runBackup(env, { now: NOW });
    expect(manifest.totals.tables).toBe(Object.keys(before).length);
    expect(manifest.totals.rows).toBe(Object.values(before).reduce((a, b) => a + b, 0));
    const latest = await (await env.BACKUP_BUCKET.get('backups/latest.json')).json();
    expect(latest.prefix).toBe(PREFIX);

    const v = await verifyBackup(env.BACKUP_BUCKET, PREFIX);
    expect(v.errors).toEqual([]);

    const result = await restoreBackup({ bucket: env.BACKUP_BUCKET, prefix: PREFIX, db: env.SCRATCH_DB });
    expect(result.ok).toBe(true);
    expect(await rowCounts(env.SCRATCH_DB)).toEqual(before);

    const u = await env.SCRATCH_DB.prepare('SELECT username, password_hash FROM users WHERE email = ?').bind('quote@example.test').first();
    expect(u).toEqual({ username: 'quote"user', password_hash: "o'brien; DROP TABLE users;--" });
    const b = await env.SCRATCH_DB.prepare('SELECT b, note, n FROM drill_blob ORDER BY id').all();
    expect(b.results[0].b).toEqual([0, 1, 2, 255, 128]);
    expect(b.results[0].note).toBe('héllo \u{1F680}\nnewline');
    expect(b.results[1]).toEqual({ b: null, note: null, n: null });

    // schema parity including indexes and triggers
    const objs = async (db) => (await db.prepare(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name").all()).results;
    expect(await objs(env.SCRATCH_DB)).toEqual(await objs(env.AIHANGOUT_DB));
  });

  it('refuses to restore into a database that already has tables', async () => {
    await expect(restoreBackup({ bucket: env.BACKUP_BUCKET, prefix: PREFIX, db: env.AIHANGOUT_DB })).rejects.toThrow(/not empty/);
  });

  it('detects a tampered part and refuses to restore it', async () => {
    const m = (await verifyBackup(env.BACKUP_BUCKET, PREFIX)).manifest;
    const part = m.tables.find((t) => t.name === 'users').parts[0];
    const original = new Uint8Array(await (await env.BACKUP_BUCKET.get(part.key)).arrayBuffer());
    const bad = original.slice();
    bad[bad.length - 9] ^= 0xff;
    await env.BACKUP_BUCKET.put(part.key, bad);
    const v = await verifyBackup(env.BACKUP_BUCKET, PREFIX);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain('sha256 mismatch');
    await expect(restoreBackup({ bucket: env.BACKUP_BUCKET, prefix: PREFIX, db: env.SCRATCH_DB })).rejects.toThrow(/failed verification/);
    await env.BACKUP_BUCKET.put(part.key, original);
    expect((await verifyBackup(env.BACKUP_BUCKET, PREFIX)).ok).toBe(true);
  });

  it('treats a prefix without a manifest (interrupted run) as invalid, and a truncated object as a size mismatch', async () => {
    expect((await verifyBackup(env.BACKUP_BUCKET, backupPrefix('2026-01-01'))).ok).toBe(false);
    const m = (await verifyBackup(env.BACKUP_BUCKET, PREFIX)).manifest;
    const part = m.tables.find((t) => t.name === 'users').parts[0];
    const original = new Uint8Array(await (await env.BACKUP_BUCKET.get(part.key)).arrayBuffer());
    await env.BACKUP_BUCKET.put(part.key, original.slice(0, 10));
    expect((await verifyBackup(env.BACKUP_BUCKET, PREFIX)).errors.join()).toContain('size');
    await env.BACKUP_BUCKET.put(part.key, original);
  });

  it('splits large tables into parts and the manifest hashes match the stored bytes', async () => {
    const stmts = [];
    for (let i = 0; i < 4500; i++) stmts.push(env.AIHANGOUT_DB.prepare('INSERT INTO drill_blob (note) VALUES (?)').bind(`row ${i}`));
    for (let i = 0; i < stmts.length; i += 100) await env.AIHANGOUT_DB.batch(stmts.slice(i, i + 100));
    const m = await runBackup(env, { now: new Date('2026-11-01T03:30:00Z') });
    const t = m.tables.find((x) => x.name === 'drill_blob');
    expect(t.rows).toBe(4502);
    expect(t.parts.map((p) => p.rows)).toEqual([2000, 2000, 502]);
    const obj = new Uint8Array(await (await env.BACKUP_BUCKET.get(t.parts[2].key)).arrayBuffer());
    expect(await sha256Hex(obj)).toBe(t.parts[2].sha256);
  });
});

describe('scheduled handler and failure reporting', () => {
  it('the backup cron runs a backup', async () => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '30 3 * * *', scheduledTime: Date.parse('2026-11-02T03:30:00Z') }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect((await verifyBackup(env.BACKUP_BUCKET, backupPrefix('2026-11-02'))).ok).toBe(true);
  });

  it('a failed backup is recorded in the ops ledger instead of vanishing', async () => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '30 3 * * *', scheduledTime: Date.parse('2026-11-03T03:30:00Z') }),
      { ...env, BACKUP_BUCKET: undefined }, ctx);
    await waitOnExecutionContext(ctx);
    const row = await env.AIHANGOUT_DB.prepare(
      "SELECT event_data FROM analytics_events WHERE event_type='ops_failure' AND json_extract(event_data,'$.kind')='backup'").first();
    expect(JSON.parse(row.event_data).reason).toContain('BACKUP_BUCKET');
  });
});

describe('retention policy', () => {
  const today = '2026-10-31';
  const days = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

  it('keeps 14 daily, one per week for 8 weeks, one per month for a year, and always the newest', () => {
    const dates = Array.from({ length: 400 }, (_, i) => days(i));
    const keep = selectRetained(dates, today);
    for (let i = 0; i <= 14; i++) expect(keep.has(days(i))).toBe(true);
    expect(keep.size).toBeLessThan(15 + 8 + 13 + 1);
    expect(keep.has(days(399))).toBe(false);
    expect(selectRetained(['2020-01-01'], today).has('2020-01-01')).toBe(true); // newest is never deleted
  });

  it('applyRetention deletes expired complete backups, spares the newest, and cleans stale incomplete runs', async () => {
    const b = env.BACKUP_BUCKET;
    const put = async (date, complete) => {
      await b.put(`${backupPrefix(date)}schema.json`, '[]');
      await b.put(`${backupPrefix(date)}t/part-00001.jsonl.gz`, 'x');
      if (complete) await b.put(`${backupPrefix(date)}manifest.json`, '{}');
    };
    await put('2024-03-05', true);
    await put('2024-03-01', true);
    await put('2026-10-30', true);
    await put('2026-10-20', false);
    const r = await applyRetention(b, { now: new Date('2026-10-31T03:30:00Z') });
    expect(r.deleted).toEqual(expect.arrayContaining([backupPrefix('2024-03-05'), backupPrefix('2024-03-01'), backupPrefix('2026-10-20')]));
    expect(await b.head(`${backupPrefix('2026-10-30')}manifest.json`)).not.toBeNull();
    expect((await b.list({ prefix: backupPrefix('2024-03-05') })).objects).toHaveLength(0);
    expect(await b.head(`${PREFIX}manifest.json`)).not.toBeNull();
  });
});
