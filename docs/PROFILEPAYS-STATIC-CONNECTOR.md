# ProfilePays static test connector

Feature gate: `PROFILEPAYS_TEST_ENABLED=true`. It is absent from production configuration;
this implementation was exercised only in an isolated local workerd/D1 runtime.
Apply `migrations/0018_profilepays_static.sql` only to the selected target database.

The connector preserves the normal initials/live-profile setting and applies a temporary
static overlay centrally through `LiveProfileAvatar`, including preexisting post/response avatars.
Two bundled test PNGs are approved. Each visible placement carries an `Ad · test` label.
No arbitrary asset URL, HTML, payment or cash-value operation is supported.

| Route | Authority | Effect |
|---|---|---|
| POST/DELETE `/api/profilepays/grant` | Existing user JWT | Create/revoke a private static-placement capability. Reissue stops old assignments. |
| GET `/api/profilepays/connection` | `X-ProfilePays-Grant` | Read scoped subject and normal profile. |
| PUT `/api/profilepays/assignments/:id` | Same scoped grant | Idempotent provisional assignment; requires matching normal profile and available surface. |
| POST `/api/profilepays/assignments/:id/renew` | Same scoped grant | Confirm immutable start/end once, then renew a lease up to 120 seconds, capped at contract end. |
| GET/DELETE `/api/profilepays/assignments/:id` | Same scoped grant | Read expiry receipt or remove assignment. |
| GET `/api/users/by-username/:username/placement` | Public | Current safe display state; no grant secret; no-store. |

The grant is random, expires after 31 days and is stored only as a SHA-256 hash here.
The AIHangout destination enforces expiry/revocation independently of the ProfilePays worker.
Changed normal profile state makes the overlay ineligible immediately. Restoration removes the
overlay; it does not write an old value over the owner's current setting.

Read `../profilepays/docs/STATIC-PILOT.md` for the paired implementation and local runner.
Real D1 connector coverage is in `test/profilepays.test.js`; paired API, browser and outage tests
are in the sibling ProfilePays `tests/static-*.mjs`. The local acceptance includes old posts,
WebKit phone emulation, time-zone/clock changes, lease expiry, grant revocation, concurrent claims,
and preserved owner edits. No physical-phone or production-deployment claim is made.
