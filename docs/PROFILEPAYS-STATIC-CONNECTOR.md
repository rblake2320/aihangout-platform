# ProfilePays static test connector

Feature gate: `PROFILEPAYS_TEST_ENABLED=true`, enabled on production with the owner's
approval on 2026-10-15. The production D1 received only `0018_profilepays_static.sql`
and `0019_profilepays_creatives.sql`; both are recorded in `d1_migrations`.
See [production release evidence](profilepays-production/README.md).

The connector preserves the normal initials/live-profile setting and applies a temporary
static overlay centrally through `LiveProfileAvatar`, including preexisting post/response avatars.
Two bundled test PNGs and normalized, SHA-256-bound custom PNGs are supported.
Each visible placement carries an `Ad · test` label.
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
and preserved owner edits. Production acceptance exercised the designated test profile,
its existing question/answer, automatic expiry, early stop and restoration. Phone checks
use WebKit emulation; no physical iPhone was controlled.
