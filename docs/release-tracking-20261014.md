# AIHangout release tracking — 2026-10-14

GitHub review:
- AIHangout: https://github.com/rblake2320/aihangout-platform/pull/10
- Countdown: https://github.com/rblake2320/election-countdown/pull/21

Jira: https://rob47595-1791122756383.atlassian.net/browse/AIH-1 (In Progress).

The countdown deployment and public acceptance are complete. Signup explanations,
chat/analytics recovery and screenshot bug reports are implemented, tested and
pushed, but are not deployed. A GitHub push or pull request does not publish the
Cloudflare Worker.

The release requires owner production approval, additive migration
`0018_bug_report_images.sql`, deployment, and public-host acceptance. The phone
registration rejection at 21:15:50 UTC was HTTP 409 for an existing email; the
prepared error UI explains recovery. No personal registration details are included
in public evidence.

Validation: 62 Worker/workerd/D1 tests, Crucible, build and production dry-run
passed. AIHangout PR #10's initial three CI jobs passed. Actual browser clipboard
paste, preview/removal, failed-save retry, stored admin image display and non-admin
denial passed. Native file-picker automation was blocked by the browser extension
file-URL permission; phone-width Chrome testing is distinct from a physical phone.

Countdown PR #21 initially failed its committed-build freshness gate. A clean
checkout installed the lockfile with `npm ci` and reproduced CI's exact generated
filenames; the working checkout had Vite 7.3.7 while the lockfile installs 7.3.2.
Commit `2258579` regenerates the assets from the lockfile. A second clean build
produced no changes. The original failure remains in GitHub Actions history.

Evidence directories: `docs/registration-20261014/`,
`docs/bug-report-images-20261014/`, `docs/live-profile-evidence/`,
`docs/chat-data-review-20261014.md`; companion countdown evidence is in
`docs/live-profile/production-retest/` and `docs/live-profile/friend-visibility/`.

The owner's Terminal Session Registry has this session in `Registry!A76:K76`.
The update preserved all existing cell values, formulas and styles and extended
the existing table to row 76. Jira tracks production release and physical-phone
file-picker verification separately from the completed countdown milestone.
