# Changelog

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

