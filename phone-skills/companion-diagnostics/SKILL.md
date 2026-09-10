---
name: companion-diagnostics
description: Explain and request the approved operation that enables AIHangout Companion diagnostics on a bound Android device.
operation_reference: enable_companion_diagnostics
approval_tier_reference: device_ui_action
last_verified_app_version: "0.1.0"
last_verified_apk_sha256: d41db6f6fec1b0e98f3712ec49338f664a65d7d90632706be0cb0d4bbc6a76d6
last_verified_date: "2026-09-10"
provenance: self-authored from committed implementation and two-device supervised evidence
---

# Enable companion diagnostics

## Status and authority
This is procedure content, not an installed executor, permission grant, or runtime-enforced policy. The existing operation was tested before this skill was written; loading or applying this file has not been tested. No companion skill loader or automatic version gate is claimed.

Resolve `enable_companion_diagnostics` through the existing backend compiler in `src/mobile-assistance.js`. It maps to capability `ui_click` and the exact target `Enable AIHangout companion diagnostics`. The operation is fixed; this is not arbitrary screen clicking. The backend approval policy and phone validation decide whether execution is permitted. Missing operation or permission means report unavailable; do not substitute another action.

## Preconditions
- Identify the intended device and authenticated owner/backend binding.
- Observe this companion's diagnostics preference as disabled. If already enabled, report that fact; do not toggle it off to manufacture a repair.
- Check installed app version AND artifact identity against the verification metadata. Version 0.1.0 alone is insufficient because multiple builds share it. A mismatch requires revalidation before using this procedure; the file itself does not enforce this check.
- Use the existing companion assistance workflow. A model may propose only the supported operation or no action.

## Procedure
1. Collect only the existing structured diagnostics request fields. Preserve its logical request identity across uncertain responses; reconcile through the existing read path rather than replaying a model request.
2. Obtain the fixed proposal and corresponding device-bound intent.
3. Present the actual operation and target for web approval. This file cannot approve the action.
4. Let the companion validate the approved binding and execute its existing operation. Denial, mismatch, expiry or unknown outcome is not success; do not improvise a bypass.
5. Observe diagnostics enabled and the fresh battery percentage/charging result. Keep the result separate from effect verification.

## Verification
The retained test used real OpenAI proposals, owner-authorized A1 web approvals, UIA before/after observation, app process stop/reopen, and Android system battery readback. Backend records then received supervised observer verification. A saved `unconfirmed` line can predate that verification; never upgrade it based on inference. Restart proof covers persistence after completed execution, not a crash during execution.

Evidence: `docs/evidence/frontier-repair-20260910/README.md`, captured device text, final server readbacks, and SHA256SUMS. Code: `src/mobile-assistance.js`; Android `android-companion/app/src/main/java/com/aihangout/companion/ui/MainActivity.kt`. Tested runtime source: `de298aa`; installed APK source: `c83085a`.

Report resolved only for the observed diagnostics preference. Otherwise report unresolved or unknown with the retained record. This does not diagnose malware, repair other apps, or grant phone-wide authority.
