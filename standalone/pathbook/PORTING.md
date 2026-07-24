# Porting Pathbook to Cloudflare Workers + D1

This package is the standalone service and executable protocol reference. AI
Hangout production runs a Worker against D1. The protocol, trust rules, safety
model, fingerprints, evidence schema, and signing semantics port; SQLite's
transaction and sidecar mechanics do not.

## Portable invariants

- Normalize before hashing; compute both primary and context fingerprints.
- Verify canonical Ed25519 signatures on standalone writes.
- Never accept an outcome without a persisted, unexpired, single-use
  application tied to the same Pathbook version and executor.
- Recompute trust telemetry from the append-only evidence history. Exclude
  author self-reports and cap counted reports per identity.
- Refuse deprecated, dangerous, and inactive records. Draft execution requires
  explicit privileged review mode; high-risk remediation requires confirmation.
- Couple every security-relevant mutation to a sealed audit event and verify
  materialized state independently.

## D1 implementation used by AI Hangout

AI Hangout uses the D1-only optimistic-concurrency shape:

1. A one-row audit head stores the expected sequence and hash.
2. A `BEFORE INSERT` trigger rejects an event whose `prev_hash` is stale.
3. A D1 `batch()` atomically writes the application/evidence/state mutation
   and audit event.
4. The Worker retries a rejected stale-head batch after rereading the head and
   recomputing telemetry.
5. Event and materialized-state seals use an HMAC key derived from a Worker
   secret, never a D1 row.
6. `/api/health/pathbooks` walks the chain, verifies the head and HMAC seals,
   and validates every sealed materialized Pathbook state.

This is deliberately not a translation of `BEGIN IMMEDIATE`. If deployment
requirements later demand a single-writer coordinator, a Durable Object can
replace the optimistic head without changing the protocol.

## Acceptance bar

- Standalone: the full adversarial suite, including a Windows `spawn`
  multi-process writer test, must pass.
- Worker/D1: migration on staging, parallel issue/report/replay probes,
  audit/state health, MCP contract checks, and the mandatory deployment gate
  must pass before production.
- The database and its external secret/checkpoint (standalone), or D1 and
  Worker secret (hosted), are one operational backup unit.

