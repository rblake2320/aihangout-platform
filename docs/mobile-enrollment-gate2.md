# Mobile enrollment — unreleased Gate 2 candidate

This backend proves possession of a P-256 private key under an authenticated owner
session. It does not prove Android hardware, application integrity or human presence.
Client certificate/package claims are bound in the signature and checked against
deployment configuration; that is not a verified attestation chain. Hardware security
level is always recorded as unknown. Subsequent actions still use the owner's JWT,
not signed device requests. Do not describe this as complete device authentication.

Configure MOBILE_APP_ID and MOBILE_APP_CERT_SHA256 for the reviewed APK before use.
Missing or malformed policy denies enrollment. No production pins are supplied here.

Challenge JSON: agentName, publicKeySpki (padded base64 DER), packageName,
signingCertSha256 (lowercase hex). The response returns signingPayload: exact UTF-8
JSON bytes with a versioned domain, owner, challenge ID, nonce, expiry and all claims.
After locally validating these fields, sign exactly these bytes with ECDSA P-256
SHA-256. Send a padded base64 64-byte P1363 signature in the enrollment request,
alongside the same claims and challengeId. Android's DER signature must be strictly
decoded and converted to unsigned fixed-size r||s before sending.

Challenges expire after five minutes. D1 transactionally enrolls and consumes a
challenge; concurrent or repeated attempts admit at most one device record. Invalid
signature attempts do not consume the legitimate challenge. Keep unknown responses
unknown; this version does not add a new enrollment reconciliation API.

Revocation changes the device and pending/approved intents in one transaction.
Database triggers reject later intent/approval/result inserts even if an earlier
handler read saw active state. Historical records are preserved. Legacy placeholder
enrollments cannot create new intents because no verified SPKI is recorded.

## Local evidence

`test/mobile-enrollment-proof.test.js`: seven real workerd/D1/WebCrypto cases,
including wrong signer, changed transcript, expired/reused nonce, wrong owner,
mutated package/certificate/name, malformed signatures, concurrent enrollment,
and revocation with zero result-row mutation. No mocked cryptography or database.
Existing mobile authority tests now enroll through the real signature flow.

Full suite: 111 passed, one fixture failed for missing JSON Content-Type on revoke.
After correcting that fixture, focused suite 7/7 passed. Original failed receipt
retained; no claim that the earlier full run was green. Worker build and legacy
Crucible checks passed. Phone Keystore, Android DER conversion, deployed Worker,
restart and real-device integration remain separate acceptance gates.

References: [Cloudflare KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
and [WebCrypto ECDSA encoding](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/sign).
