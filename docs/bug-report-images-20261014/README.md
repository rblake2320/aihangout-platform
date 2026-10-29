# Bug report screenshots — local acceptance, 2026-10-14

Users can paste images while focused anywhere in the report form, preview or remove them, and attach up to three screenshots. A file picker is also present. Supported inputs are PNG/JPEG/WebP up to 10 MB; the browser decodes and resizes them to JPEG, at most 512 KiB each, stripping original metadata. Text paste keeps its normal behavior. Anonymous reporting remains available for signup problems.

Screenshots are stored with the report in one D1 transaction. Existing admin-only list/detail endpoints deliver counts and images to the new Moderation Dashboard → Bug Reports tab. Image bytes are redacted from activity-log payloads. Existing server authentication, role checks, CORS, CSP, rate limits and bindings are unchanged.

## Worked

- Real Chrome clipboard PNG paste: preview decoded at 375 pixels wide; normal text paste retained.
- Three attachments accepted; fourth paste produced a persistent limit explanation. Removal reduced count to two.
- A real local D1 trigger forced an image insert failure: UI retained text and both images with a retry explanation. After removing the trigger, retry created exactly one report with two images.
- Admin signed in through the built UI and opened the stored report: both image elements decoded and displayed at their original prepared width. See admin-review.png.
- Browser test exposed a pre-existing missing `is_admin` field in the login DTO that made the admin page redirect even for administrators. The UI now consults the existing admin-protected report endpoint; no auth route or JWT changes. Demoting the disposable local reviewer and reloading denied access.
- Narrow Chrome layout: requested viewport 390×844, effective CSS viewport 312 pixels under browser zoom; page width 300, no horizontal overflow. Clipboard preview and removal control visible; see mobile-paste.png. This was desktop Chrome at phone width.
- Worker/workerd/D1: 62 tests passed, including five new screenshot tests for persistence, anonymous/non-admin denial, text-only reports, malformed/unsupported/oversized images, whole-body cap and transactional rollback.
- Crucible: all tests passed. Built frontend/Worker and production dry-run passed.

## Blocked

Native file-picker upload automation: Chrome extension refused `setFiles` because “Allow access to file URLs” is disabled. The picker opened, but automated file selection could not proceed. Clipboard paste used the actual browser clipboard and was fully exercised.

## Retained failures

The first targeted test run had two incorrect expectations: activity logging does not set target_id for bug reports, and the global response wrapper normalizes server errors to 503. Corrected tests correlate payload title and expect 503; all five then passed. Private raw logs remain in `.local/bug-images/worker-targeted-initial.txt`.

One full-page screenshot capture timed out; ordinary viewport captures succeeded. The failed capture was not treated as a failed report submission.

## Release

Not deployed. Apply migrations/0018_bug_report_images.sql before deploying this Worker, using the existing production database binding. The migration adds one nullable report column and a new image table/indexes; no data deletion. Code rollback may leave those additive structures intact. Current release also contains previously queued chat/analytics and actionable signup-error changes.

Production deployment needs the owner's explicit approval under AGENTS.md. Required tests and dry-run completed. After deployment, submit a synthetic screenshot report and verify its admin readback on the public host.

Local raw receipts and disposable database remain under `.local/bug-images/`. The owned Wrangler/workerd server processes were stopped using fresh PID/birth/executable checks; browser viewport and clipboard were cleared/restored.
