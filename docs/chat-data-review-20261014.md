# Chat and activity-data review — 2026-10-14

## Current live behavior

Worked: signed in as the existing synthetic human `live_countdown_test`, opened
Live Chat from the profile and saw saved room messages and an enabled composer.
A read-only production D1 query counted 13 messages from 8 distinct participants.
No messages were sent during this review.

Worked: the actual browser interaction reached production `analytics_events`:
`chat_open` for test user 309 at `2026-10-14T18:59:34.483Z`. The same account had
22 page views, 10 clicks, 8 login records, 5 heartbeats, 4 time-on-page events,
and registration/problem/solution records at the time of the query. These are
test-account observations, not measures of customer adoption.

The shipped chat component uses shared channel 1. Source/route/schema inspection
found no private inbox or direct-message recipient flow. Production contains
`chat_channels`, `chat_messages`, and `chat_channel_members`; a membership table
alone does not supply private-message behavior. Followers are separate from DMs.

## Reproduced defects and local repairs

The source-loaded JS harness stubs browser hooks, clock, and transport boundaries;
it does not contact production or substitute for two-browser message delivery.

| Scenario | Baseline 7cd65fe | Repaired source |
| --- | --- | --- |
| Five failed analytics sends, then network recovery and a new event | Failed: no sixth attempt, queued events discarded | Worked: queued and new events delivered |
| 80-event burst | Worked | Worked: 80 distinct events, API-sized batches |
| Unload with 71 queued events | Failed: one batch exceeds the API's 50-event cap | Worked: split into batches of at most 25 |
| Healthy SSE connection, later message available in history | Failed: no history refresh | Worked: five-second reconciliation retrieves the message; cleanup stops timers |
| Read an old message containing `not solved`, then close chat without sending | Failed: reported `problem_solved` | Worked: zero session sends, one visible message, no inferred success |

The Worker currently emits connection events and keepalives; its broadcast helper
only writes a latest-event KV key. The client repair keeps reading durable history
while SSE is connected. This is polling-based delivery, not a new push service.

Analytics retries now use capped backoff and one request at a time. Memory remains
bounded to the existing 100-event cap. Unload beacons are queued delivery attempts,
not server acknowledgements. The application is not an exactly-once event ledger.

Chat telemetry now separates session sends from visible history, includes channel
and message IDs, message length and send duration, and records failure categories.
It does not add message text to these events. `chat_close` no longer guesses a
successful outcome from words in historic messages.

## Useful data still requiring design work

- Add explicit countdown opt-in/link/unlink and fallback/recovery events; generic
  clicks do not reliably describe that feature's adoption or health.
- Measure authenticated send acceptance, receiver delivery/read acknowledgement,
  first response time, repeat participation and user-confirmed helpfulness.
  The current client send-duration metric is not receiver delivery latency.
- Give events stable IDs and server-side validation/attribution before treating
  them as authoritative business measurements. The current batch endpoint accepts
  client-supplied user identity on anonymous requests, including unload beacons.
- Review existing raw IP, user-agent, clicked-text and full-link collection against
  actual product questions. More collected text is not automatically more useful.
- If private messaging is added, define participant-only access, block/report,
  unread/read state and retention with its metrics. Do not reuse public-room access
  rules or automatically ingest private message bodies into analytics/training.

These items were identified by inspection, not implemented by this repair.

## Validation and release state

- `node scripts/test-chat-analytics.mjs --baseline=7cd65fe`: 4 failed, 1 passed.
- `node scripts/test-chat-analytics.mjs`: 5 passed.
- `npm test`: all 57 Worker/D1 tests passed.
- `node crucible_tests.js`: all passed.
- `npm run build:frontend`: passed.
- `wrangler deploy --env production --dry-run`: passed.

Logs: `.local/chat-data-audit/` retains baseline, repaired, Worker, Crucible, build,
dry-run and the initial outage reproduction. The small client changes and built
frontend are prepared locally. No chat/data repair has been deployed by this review.
Production approval for this separate repair release remains required under
`AGENTS.md` ("Deploying to production"). Public browser verification follows that
release. The prior countdown release and its test accounts remain intact.
