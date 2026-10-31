# Email notifications (AIH-R5)

In-app notifications are unchanged. Email is added on top, through a queue.

## What is emailed

| Category | Trigger | Default |
|---|---|---|
| `solutions` | Someone answers my question (`new_solution`); my answer is verified (`solution_verified`) | on |
| `mentions` | Someone writes `@myusername` in an answer (`mention`); `comment` is wired for the comments feature | on |
| `digest` | Monday 14:00 UTC summary: new answers to my questions and unread notifications from the last 7 days. Skipped when there is nothing to report. | on |

Votes, follows and pathbook events stay in-app only. Only addresses with a verified email are
mailed. The legacy `user_settings.email_notifications` flag is no longer read.

## How it works

1. `createNotification()` writes the in-app row as before, then calls
   `enqueueNotificationEmail()` (`src/email-outbox.js`). That inserts one `email_outbox` row.
   `dedupe_key` is `UNIQUE`, so one event can only ever produce one row. Nothing is sent inside
   the request.
2. The cron (`*/10 * * * *`) calls `flushOutbox()`: up to 50 rows per run. Each row is *claimed*
   (`pending → sending`, conditional update) before the provider call, so overlapping runs cannot
   double-send. The provider call carries `Idempotency-Key = dedupe_key`.
3. Eligibility (verified address, category on, not unsubscribed) is checked again at send time,
   so unsubscribing after something was queued still stops it (`suppressed`).
4. A provider error is retried on the next run, up to 5 attempts, then `failed` with the error.
   With no `RESEND_API_KEY` configured nothing is consumed: rows stay `pending`.
5. `0 14 * * 1` additionally queues the weekly digests. Each user is decided once per week
   (`digest:<user>:<monday>`); users with nothing to report get a `suppressed` row, so reruns and
   paging never duplicate or starve anyone.

## Unsubscribe

Every email has a signed link (HMAC-SHA256 over the server secret, per user and category, no
table) in the footer and in `List-Unsubscribe` / `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.

- `GET /api/email/unsubscribe?t=…` shows a confirmation page and changes nothing (link scanners
  prefetch; they must not unsubscribe anyone).
- `POST /api/email/unsubscribe?t=…` performs it (this is what RFC 8058 mail clients send, as a
  form body). Scope is one category or `all`; queued mail of that scope is suppressed.
- `GET|PUT /api/users/me/email-preferences` (auth) reads and sets `solutions`, `mentions`,
  `digest`, `unsubscribed_all`. The Settings page uses it.

## Operating notes

- Apply migration `0020_email_outbox.sql` before deploying (no triggers in it).
- Secrets: `RESEND_API_KEY` (existing) and `JWT_SECRET` (signs unsubscribe tokens). Optional
  `PUBLIC_BASE_URL` for links (defaults to `https://aihangout.ai`).
- Cron triggers are declared once, in the top-level `[triggers]`; confirm they are active for the
  environment you deploy to.
- Inspect the queue: `SELECT status, COUNT(*) FROM email_outbox GROUP BY status;` and
  `SELECT last_error, COUNT(*) FROM email_outbox WHERE status IN ('failed','suppressed') GROUP BY 1;`

## Limits

- `@mention` is parsed in answers only; problem bodies and comments are not (comments do not
  exist yet; use `createNotification` with `type: 'mention'` or `'comment'` when R7 adds them).
- No per-recipient send-rate cap beyond the batch size; digest volume is bounded by the Monday
  run's 500-user page per cron invocation (rerun the cron or raise `limit` for larger tables).
- Account deletion (AIH-R4) should delete or anonymise `email_outbox` rows for the user.
- Bounces and complaints from the provider are not ingested yet.
