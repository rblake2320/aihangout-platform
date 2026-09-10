# Two-phone supervised OpenAI repair — 2026-09-10

Executed against the deployed staging worker and installed Android APK. Both devices changed the companion diagnostics preference from disabled to enabled after a real model proposal and web approval. Process stop/reopen retained the preference and repair proof; Android system battery readback matched the app result.

Approval and subsequent effect verification were performed by owner-authorized A1. This is a supervised test, not autonomous verification or general phone repair. Two successful calls used 298 input and 105 output tokens, estimated $0.003292; rejected requests returned no usage. The phone's saved `unconfirmed` text precedes the later observer verification in the server readbacks.

## Records

- `*-sol-after.txt`: captured device UI text, including failures and successful execution.
- `*-sol-restarted.txt`: captured UI after process restart.
- `*-system-battery.txt`: Android system observations.
- `verified-*.json`: final server result and observer verification.
- `real-model-repair-receipt.json`: call accounting and bounded assertions.
- `completion-receipt.json`: deployed artifact hashes and original private-source hashes.
- `SHA256SUMS`: hashes of the published, sanitized files.

Device/account identifiers were removed from published readbacks and device logs. Original source hashes in the completion receipt refer to the private originals, not sanitized copies. Credentials, session state, database backups, device serials and APK binaries are not included. Hashes establish file integrity, not independent proof of narrative claims.

Source implementation is tracked in this branch; latest runtime change is de298aa. APK source is c83085a. Tests were run before this documentation export (174 worker baseline, 124 Android, 13 final provider-focused tests); this export does not claim another run. No paid requests or device actions were repeated for publication.

This establishes the companion diagnostics repair only. It does not establish arbitrary repair, crash-window exactly-once execution, fresh installation, or production capacity.
