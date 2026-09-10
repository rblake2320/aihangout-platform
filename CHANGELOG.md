# Changelog

## Unreleased — frontier assistance integration, 2026-09-10

- Integrate the bounded OpenAI assistance endpoint and durable request records. Provider calls remain disabled pending live-test credentials and budget authorization.
- Remove bearer-token and account-response output from the web approval acceptance driver.
- Prepare the hosted staging database for mobile enrollment and actions, preserving a pre-migration backup and verifying the seven applied migration records and active-device triggers.
- Android assistance integration and the real model-to-approved-device-action acceptance remain in progress; no end-to-end frontier repair claim is made by this checkpoint.

## Unreleased — composed mobile client and approval UI, 2026-09-10

- Integrate Android client from 090aa95: owner-bound signing, digest verification, durable action state, and explicit API failure handling.
- Integrate human approval page from 2e2a119 with exact action details, confirmation phrase, and fresh status readback.
- Local composition checks: Worker/D1 120 passed, zero skipped; approval render tests 9 passed; Crucible checks and Worker/frontend builds passed.
- Android independent retest, physical enrollment/action/recovery, and production deployment remain pending. No connected Android device was detected at this checkpoint.


## Unreleased — mobile enrollment, 2026-09-08

- Replace placeholder device-key registration with real P-256 challenge signatures.
- Atomically consume enrollment challenges, refusing concurrent reuse.
- Bind signatures to the owner, key, application claims, nonce and expiry.
- Cancel outstanding intents when a device is revoked and enforce revocation at database writes.
- Preserve existing records; label hardware assurance unknown until attestation is verified.

Local real-crypto/workerd/D1 evidence and remaining Android/deployment gates:
[Gate 2 evidence](docs/mobile-enrollment-gate2.md). This change is not deployed.


## Unreleased — participation fixes (A5-C0910), 2026-09-10

These changes are on the `a5/closure-c0910-20260910` branch, not yet integrated or deployed.
Existing knowledge and training records are retained.

- Follow and unfollow no longer fail with HTTP 415: the Worker's JSON Content-Type guard now
  allows the body-less follow toggle, and the web client sends an explicit JSON body anyway.
- A vote no longer appears to revert after the feed refetches or the page reloads: problem
  reads now return the signed-in reader's own vote for the problem and each solution (never
  for anonymous, cacheable reads), and the vote controls re-hydrate from it. The per-solution
  lookup is bound to the problem id (constant parameter count) so long threads cannot exceed
  D1's bound-parameter limit.
- Problem Bank filters are enforced: the impact-level filter now applies when the bank is
  sourced from community problems, an unknown impact value is rejected, and approved problems
  are included alongside legacy open ones.

Candidate validation on Windows (changed suites only, workerd + real D1): follow 5/5, bank 8/8,
vote 8/8 (incl. a 120-solution thread), VoteButtons render 3/3; frontend build passed. Each fix
carries a negative control (reverting the specific change fails its own test) and an independent
adversarial review; one review finding (bound-parameter limit) was fixed before integration.
No production, staging, or load evidence; not a released version.

## Unreleased — launch candidate, 2026-09-08

These changes are in the integration branch, not yet deployed to production.
Existing knowledge and training records are retained.

- Restore authors' access to their pending questions and display persistent review status.
- Include existing parent problem categories in newly collected solution learning records.
- Add an authenticated self-export endpoint for a contributor's own records.
- Stop deployment scripts immediately when a build, dry-run, or deployment command fails.

Candidate validation on Windows: 65/65 Worker tests passed against local workerd/D1;
frontend and Worker builds passed; the legacy Crucible checks passed (they duplicate
logic and are not an independent deployed-handler proof). Eight native PowerShell
sequencing cases passed with fixture npm/npx processes. The original deployment
scripts failed all six injected-failure cases, continuing and printing completion.

These are local candidate results, not production or capacity evidence.
Security review, combined UI/backend verification, restore testing, and measured capacity
remain required before launch. Public version history will be updated with the actual
release after deployment and readback; an unreleased candidate is not a released version.

## Integration checkpoint 2026-09-10
Participation repairs, pending-content UX, password reset revocation, Pathbook candidate, mobile deny route and Deny UI composed into the mobile integration branch. Android and Pathbook independent HOLD findings remain open; no deployment claimed. Completed action results are retained when a device is revoked. Combined Worker test receipt: merged-participation-20260910.json; frontend 19/19 and build passed.


### Phone recovery candidate — 2026-09-10
Preserve ambiguous POST outcomes and conflicting result evidence; stop terminal-action output resubmission. Integrate synchronous phase journal, checked enrollment identity persistence, and retained verified result display. Local device acceptance remains pending; no production deployment.

