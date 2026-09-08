# Changelog

## Unreleased — mobile enrollment, 2026-09-08

- Replace placeholder device-key registration with real P-256 challenge signatures.
- Atomically consume enrollment challenges, refusing concurrent reuse.
- Bind signatures to the owner, key, application claims, nonce and expiry.
- Cancel outstanding intents when a device is revoked and enforce revocation at database writes.
- Preserve existing records; label hardware assurance unknown until attestation is verified.

Local real-crypto/workerd/D1 evidence and remaining Android/deployment gates:
[Gate 2 evidence](docs/mobile-enrollment-gate2.md). This change is not deployed.
