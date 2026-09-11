---
name: camera-notes
description: Capture a photo of printed text with the system camera, recognise it on-device, edit, and save it explicitly as a private note inside the AIHangout Companion.
operation_reference: capture_camera_note
approval_tier_reference: local_only
last_verified_app_version: "0.1.0"
last_verified_signer_sha256: b709192f6a09f7c1a93addb13d766f4ad5f134747862d4b7f4814357d9fc0b4e
last_verified_date: "2026-09-10"
provenance: self-authored from committed implementation e1bebdc, fbc88d0, 97f94ac (A1 integrated as d0d4787) and A1's real Moto1 acceptance receipt docs/evidence/camera-notes-20260910/receipt.json (PASS_CAPTURE_OCR_SAVE_RESTART_READBACK on APK e279a2994672898d39cae39a81b9f3ae747cbfcc16e88c5dccf2418162e96dcf); this file pins signer + version only, so a match means COMPATIBLE, not that the installed build is that exact APK
schema_version: 1
---

# Camera notes (on-device OCR, private)

## Status and authority
This is procedure content, not a permission grant. The screen it describes exists in the app (`ui.CameraNotesActivity`). Loading this file changes nothing about what the app may do; the loader can only open that screen, and only when the signer/version metadata above matches the installed build.

## Preconditions
- The installed build is signed by the identity above and reports version 0.1.0. A mismatch requires revalidation; the loader enforces this and disables the action.
- A system camera app exists. No CAMERA permission is declared by this app; the camera app owns the shutter.
- Nothing here needs a network, an account, a token or a model. Airplane mode is fine.

## Procedure
1. Open camera notes (the only action this skill offers).
2. Tap "Take photo of text (system camera)" and press the shutter in the camera app. Pressing back instead produces no note.
3. Wait for "Text extracted (N chars)". If "No text recognised", either type the note by hand or Discard.
4. Edit the text; the saved note is the edited text, never the raw recognition unless left unchanged.
5. Tap "Save note (explicit)". Only this tap writes; the photo is deleted after recognition and never uploaded.
6. The note appears in "Saved notes"; tapping it re-reads it from disk. A note that cannot be read back is reported as such, never shown from memory.

## Verification
Real-device proof (A1, 2026-09-10, Moto1, APK `e279a299…e96dcf`): printed-page capture → on-device OCR → explicit save of 958 characters → force-stop → reopen → viewer shows the exact saved text and the note file bytes are unchanged (note sha256 `f060f36e…2a493`). Receipt: `docs/evidence/camera-notes-20260910/receipt.json` (status `PASS_CAPTURE_OCR_SAVE_RESTART_READBACK`, with its recorded limits). Code-level evidence: `Team/tasks/A5-camera-notes-20260910.md` (unit tests, negative controls, APK permission dump).

Outcome verification the human performs each time, because signer + version do not identify an exact build: cancel produces no note; the saved note is listed and re-opens with the edited text after force-stop; `run-as com.aihangout.companion ls files/camera-notes` lists exactly the saved `<uuid>.json` files and `cache/camera-notes-capture` is empty afterwards; the package declares no CAMERA permission. A different recognition quality on another device or page is not covered by the receipt above.

This does not upload photos, identify faces, read other apps, or grant any phone-wide authority.
