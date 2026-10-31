# Backups and data export (AIH-R3)

Nightly export of every D1 table to R2, with a manifest of SHA-256 hashes, a restore path
that refuses unverified data, and a drill that runs in CI.

## What runs

- Cron `30 3 * * *` (03:30 UTC) calls `runNightlyBackup` in `src/worker.js`, which runs
  `runBackup` then `applyRetention` from `src/backup.js`. The existing `0 6 * * *` harvest cron
  is unchanged (the handler branches on `event.cron`).
- Bucket binding `BACKUP_BUCKET`: `aihangout-backups` (production), `aihangout-backups-staging`.
  **Create the buckets before the first deploy** (`wrangler r2 bucket create <name>`); a missing
  bucket makes the backup fail loudly into the ops ledger, not silently.
- A failure (any thrown error) is written as an `ops_failure` row with `kind: "backup"`, so it
  appears on the admin Ops tab and in the daily digest.

## Bucket layout

```
backups/<YYYY-MM-DD>/schema.json                   tables, indexes, views, triggers (sqlite_master SQL, as JSON)
backups/<YYYY-MM-DD>/<table>/part-00001.jsonl.gz   one JSON object per row, gzip; up to 2000 rows / 8 MB per part
backups/<YYYY-MM-DD>/manifest.json                 written last: per-table row counts, per-part key/bytes/sha256, schema sha256
backups/latest.json                                {prefix, created_at, manifest_sha256}
```

Values are JSON; BLOBs are `{"$b64": "..."}`. A prefix **without** `manifest.json` is an
interrupted run: it is never restored, and is deleted by retention once it is older than a day.
Re-running on the same day removes that day's manifest first, so a half-finished re-run cannot
look complete. All tables except `sqlite_*` and `_cf_*` are exported, including `d1_migrations`.

## Verify and restore

`verifyBackup(bucket, prefix)` re-reads every object and checks size and SHA-256 against the
manifest. `restoreBackup({bucket, prefix, db})` verifies first (throws on any mismatch), refuses
a target that already has tables, creates tables, bulk-loads rows with deferred foreign keys,
then creates views, indexes and triggers last (so triggers cannot fire during load), and finally
compares the restored row count of every table with the manifest.

The restore drill is `test/backup-restore.test.js` and runs in `npm test` and CI: it seeds the
real-migration local D1 (quotes, newlines, emoji, BLOBs, NULLs, 4,500 extra rows to force parts),
runs the scheduled handler path, restores into a second empty D1, and asserts identical
per-table counts, identical values on sampled rows, and identical schema objects. Adversarial
cases: a flipped byte, a truncated object, a missing manifest, a non-empty target, and a missing
bucket binding all fail loudly.

### Manual drill against production data (owner, own shell)

1. Download a backup prefix from R2 (`wrangler r2 object get aihangout-backups/backups/<date>/manifest.json --remote`, and each part it lists).
2. Check each file's SHA-256 against the manifest.
3. Load into a scratch D1 with a throwaway Worker that calls `restoreBackup`, or write the rows with `wrangler d1 execute --file`.
   Note: apply any trigger SQL by `d1 execute --file`, not `d1 migrations apply` (see CLAUDE.md "Known Gotchas").

This step has **not** been run against production data by the author; only the workerd drill
above has been executed.

## Retention (`selectRetained`, `RETENTION` in `src/backup.js`)

| Tier | Window | Kept |
|---|---|---|
| Daily | 14 days | every complete backup |
| Weekly | 56 days | earliest complete backup of each ISO week |
| Monthly | 366 days | earliest complete backup of each month |
| Newest | always | the newest complete backup is never deleted, however old |

Deletion happens after a successful backup, in the same run. If the export fails, retention
does not run, so a failing pipeline never shrinks the archive.

## Security and limits

- Backups contain everything in D1, including password hashes, e-mail addresses, IP addresses
  and private content. The bucket must stay private (no public access, no custom domain). R2 is
  encrypted at rest; there is no extra application-level encryption yet.
- R2 delete protection is not enabled by this change; an attacker with Worker or account
  credentials could delete backups. Cross-account or object-lock copies are a follow-up.
- Tables are exported sequentially with `rowid` keyset paging. A `WITHOUT ROWID` table would make
  the backup fail (loudly); none exist today. The export is not a single snapshot: rows written
  during the run may appear in some tables and not others.
- Not measured: wall-clock and CPU time of a full production export. Row counts there are
  larger than in the drill; watch the first run in `wrangler tail` / the Ops tab.
