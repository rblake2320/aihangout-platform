# Consent, export and deletion (AIH-R4)

## Behaviour

| Piece | Where | What it does |
|---|---|---|
| Privacy policy | `frontend/src/pages/PrivacyPage.tsx` (`/privacy`) | Covers collected data, always-on security logs, opt-in analytics, AI datasets and licensing of aggregated data, storage, backups, rights. Versioned by `POLICY_VERSION` (`2026-10-31`). **Legal review needed before it is relied on.** |
| Consent store | `frontend/src/consent/consent.ts` | Decision kept in `localStorage` (`aih_consent`) with the policy version. A new version asks again. Do Not Track / Global Privacy Control override a stored "yes" and suppress the banner. |
| Banner | `components/ConsentBanner.tsx` | Decline and Allow have equal weight; nothing is collected before a choice. |
| Settings | `components/PrivacyControls.tsx` | Analytics toggle, "Download JSON", "Delete account" (password + typing `DELETE`). |
| Client gating | `main.tsx`, `services/analytics.ts`, `telemetry/transport.ts` | Session telemetry starts only with consent and stops (and clears its session id) on revoke. The universal tracker drops events without consent. Both add `?consent=analytics` to the request so `sendBeacon` carries it. |
| Server gating | `analyticsConsentGiven()` in `src/worker.js` | `POST /api/analytics/batch` and `/api/events/batch` return 204 and store nothing unless `?consent=analytics` is present and neither `Sec-GPC: 1` nor `DNT: 1` is sent. |
| Consent log | `POST /api/consent`, table `consent_log` (migration 0019) | One row per decision: choice, policy version, source, whether a privacy signal was present, user id if signed in. No IP or user agent. |
| Export | `GET /api/me/export` | JSON of profile and 16 sections (problems, solutions, votes, bookmarks, follows, notifications, chat, bug and content reports, settings, analytics events, search events, consent decisions). No credentials. 10,000 rows per section, truncation listed in `truncated_sections`. |
| Deletion | `DELETE /api/me` `{password, confirm: "DELETE"}` | One D1 batch: deletes sessions, votes, bookmarks, follows, notifications, chat messages, analytics and ownership events, agent request log; nulls the user on search events; replaces username, email and password hash on the `users` row and sets `deleted_at`. `authenticate()` rejects any user with `deleted_at`, so unexpired tokens stop working. Admins are refused. |

## Tests

`test/consent-privacy.test.js` (12 tests, real D1 and routes in workerd): batches without consent, with `Sec-GPC`, with `DNT`, or with a wrong value store nothing, while a consented batch is stored, on both ingest endpoints; consent log rows and validation; export requires auth, returns only the caller's data and never `password_hash`; deletion needs auth, password and confirmation, refuses admins, anonymises the row, removes personal rows, keeps content and other users' rows, makes the old token and old credentials fail, and frees the username; the consent store (default off, GPC/DNT override, corrupt/old-version decisions, blocked storage).

## Known limits (stated plainly)

- **Not verified in a browser.** The banner, settings controls and client gating compile and the pure logic is tested, but no one has clicked through them in a real browser against a deployed build.
- **REA step not done.** The charter asks for REA on a shipped consent-manager script. The REA MCP server was disconnected in this session, so no consent-manager behaviour was recovered with it; the banner behaviour follows the common pattern (equal-weight choices, no collection before consent, revocable, GPC honoured) from general knowledge, not from captured Evidence.
- **Retained after deletion:** the append-only `activity_log` (user id, username at the time, hashed IP), pathbook audit and verification records, `request_log` (IP, user agent), `revoked_tokens`, `consent_log` rows (now linked to the anonymised user), and the user's problems, solutions and reports. Chat messages are deleted. Backups (R3) keep deleted data until they age out (up to 12 months for monthly copies).
- Server-side gating trusts the client's `consent` parameter; it blocks honest clients and privacy signals, it cannot prove a human clicked a button.
- Security and ops logging (login events, ops failures, request log) is not gated by analytics consent; the policy says so.
- Migration 0019 must be applied before the code is deployed (`authenticate()` selects `deleted_at`).
