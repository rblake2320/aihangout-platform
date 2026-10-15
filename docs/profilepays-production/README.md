# ProfilePays production connector — 2026-10-15

Explicit owner authorization covered deployment and live tests on `live_countdown_test`.

Released Worker: `4b4539bf-85bf-48dd-a80c-5a4f36a80097`, frontend `index-BpOmZaTN.js`.
Previous Worker: `45eaae7b-fd76-4462-a912-9d684c9d4911`.

This branch isolates ProfilePays changes on production baseline `7cd65fe`. It excludes the unpublished signup/chat/bug-image work in the other workspace branch. The production flag `PROFILEPAYS_TEST_ENABLED=true` enables the opt-in, test-credit connector. Existing authentication, secrets, database/KV bindings and CORS were not changed.

Only `0018_profilepays_static.sql` and `0019_profilepays_creatives.sql` were applied and recorded in production `d1_migrations`. Existing live-profile links were retained. Prior undeployed unrelated migrations were not applied.

Checks executed in this release checkout: build, 58/58 Worker/D1 tests across five suites, all crucible checks, production dry-run, deployment and 15/15 post-deployment verification. See `preflight.txt`, `deployment.txt`, `verification.txt` and `schema.json`.

Actual live pilot, public profile plus existing question/answer:

- Completed 45-second custom-image placement: 45,000 ms verified, 100 test credits, original countdown restored without reload.
- Participant early stop: 5,531 ms verified of 120 seconds; zero credits; restoration in 3,858 ms.
- Direct removal through AIHangout settings: restored in 2,614 ms; settlement held, independent operator resolved to zero; duplicate review 409 and participant self-review 403.
- WebKit iPhone emulation rendered the placements; desktop Tokyo time-zone override and +24-hour clock shift preserved server expiry.
- Original countdown continued visibly moving after restoration. Final cleanup revoked the test grant and paused all campaigns.

Machine results: `acceptance.json`, `revocation.json`. Full ledger receipts and screenshots are in the ProfilePays repository `docs/production-evidence/`. ProfilePays coordination/ledger remain local on ports 8940/8933 in an isolated test database; only the AIHangout destination connector is deployed publicly. No real money and no physical-phone claim.

Live profile: https://aihangout.ai/profile/live_countdown_test

Existing post: https://aihangout.ai/problem/290

Jira: https://rob47595-1791122756383.atlassian.net/browse/PP-6
