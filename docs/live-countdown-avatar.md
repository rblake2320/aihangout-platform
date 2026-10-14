# Live countdown avatar integration

This change links a public electionclock.com countdown to the authenticated AIHangout account. Settings accepts the countdown's public avatar URL. A new `live_profile_links` table keeps the current reference separate from old posts, so the profile, feed cards and previously created answers resolve the current setting.

`PUT /api/users/me/live-profile` accepts only `{profileId: <UUID>}` or `{profileId: null}` and uses the existing authenticated user. `GET /api/users/by-username/:username/live-profile` returns only that public reference with `no-store`. It never fetches a caller-supplied URL. The component uses the fixed electionclock.com provider; an explicitly supplied loopback build override exists for local integration tests.

The avatar uses a multipart PNG image stream. Its image reconnects every 30 seconds and on network/visibility return. Image errors show the user's initial. There is no frame-policy, CORS, auth, JWT, or rate-threshold change.

## Validation

- Real Worker/D1 suite: 57 tests passed, including authenticated ownership, malformed data, durable readback, cross-account isolation and removal.
- `node crucible_tests.js`: all four groups passed.
- Both the Worker and frontend build were executed.
- Production `wrangler deploy --env production --dry-run` passed without deploying.
- The sibling election-countdown repository's `node tests/run-aihangout-live-profile.mjs` starts both built applications with fresh local state and performs the actual sign-in/settings/profile/prior-answer flow. Its machine-readable report and screenshots live in `election-countdown/docs/live-profile/`.
- Whole-tree TypeScript checking hits pre-existing JSX in `frontend/src/utils/featureFlags.ts`; no full-tree typecheck pass is claimed.

The owner explicitly approved deployment, and both additive migrations and applications were deployed on 2026-10-14. The latest AIHangout Worker version is `45eaae7b-fd76-4462-a912-9d684c9d4911`. The production deployment verifier passed 15/15 checks, including the deployed JavaScript matching the local build; its output is in `docs/live-profile-evidence/production-verification-20261014.txt`. Public browser receipts for the existing test profile and earlier thread are in the sibling countdown repository's `docs/live-profile/production-retest/`. The physical phone/travel check remains separate.
