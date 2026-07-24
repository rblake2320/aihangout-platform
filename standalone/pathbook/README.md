# Pathbook — pbp-0.1 Reference Implementation

A shared, machine-readable, trust-tiered known-error registry for AI agents. An agent that hits an error looks it up by a deterministic fingerprint and gets back a structured remediation someone already worked out — including what **not** to try — instead of burning tokens re-diagnosing from scratch.

This is a **standalone, embeddable package** with zero platform dependencies. aihangout can mount it; so can anything else. Three consumption surfaces, one engine:

| Surface | Entry point | For |
|---|---|---|
| Python library | `from pathbook import Registry` | Embedding in any host app |
| REST API | `pathbook-api` / `build_router(registry)` | Web platforms, federation |
| MCP server | `pathbook-mcp` / `python -m pathbook.mcp_server` | Agents (Claude Code, Cursor, custom loops) |

## What this closes that pbp-0.1 left open

The original code was "a good schema with a working fingerprint." This implementation closes the four gaps where the value actually lives:

1. **The loop is closed.** `lookup → issue a persisted application → agent applies fix and runs verify → signed evidence report → consume application → telemetry → auto-promotion`, all wired. Fabricated, expired, stale, reused, or identity-mismatched application IDs are rejected.
2. **Signatures are real.** Ed25519 over canonical JSON, **verified on every contribute, outcome report, and maintainer action**. A signature proves possession of a key; platform authentication must bind that key to a real human or agent identity.
3. **Lookup is an index seek.** `error_fingerprint` is a SQLite index; exact-hash lookup is a B-tree probe, not "load 100 rows and rank in application code." A second index on `(runtime, trust_tier, confidence DESC)` serves scoped listing.
4. **The trust ladder has machinery and anti-gaming teeth** (below), plus an explicit Sybil boundary: public deployments must bind keys to platform-authenticated accounts.

## The fingerprint (unchanged semantics, pinned down)

```
lowercase
→ hex runs (0x… any length; bare hex ≥ 8 chars) → <hash>
→ digit runs → <num>
→ collapse whitespace (incl. CRLF) → single spaces, strip
→ truncate to 2048 chars
→ sha256:<hexdigest>
```

`Error at 0x7f3a line 42` and `Error at 0x9b1c line 88` collide **on purpose**. CRLF/LF differences are erased, so Windows and Linux agents hit the same records.

Documented property: the fingerprint is canonicalization, not authentication. Trust comes from signatures + tiers, never from the hash itself. Also note `WinError 5` vs `WinError 32` differ only by digits — their *message text* is what keeps them distinct (it does, for all Windows error strings).

## Trust ladder + anti-gaming rules

`draft → reproduced → verified → community_confirmed` (+ `maintainer_approved` manual-only; `deprecated`, `dangerous` terminal).

| Transition | Requires |
|---|---|
| → reproduced | ≥1 independent (non-author) success with verify passed |
| → verified | ≥3 verified successes from ≥2 distinct reporters |
| → community_confirmed | ≥10 applications, ≥5 distinct reporters, ≥80% success |
| → deprecated (auto) | ≥5 applications with <40% success |
| → dangerous | ≥2 distinct dangerous flags, or 1 maintainer flag |

Anti-gaming, enforced in code and proven by tests:

- Every outcome report is **Ed25519-signed and verified** before touching state.
- Every counted outcome must reference a real, unexpired application issued by `execute`; bound applications must be reported by the same identity and key.
- A verified success includes signed check evidence (check id, exit code, output digest, environment digest, observation time).
- Reporter identities are **pinned to their first-seen key** (TOFU) — identity hijack is a 409.
- **Author self-reports never count** toward promotion — you can't reproduce your own fix.
- **Per-reporter counted cap (3)** — one identity spamming "success" 500× stalls at `reproduced` forever.
- Distinct-reporter thresholds make climbing require **breadth, not volume**.
- `deprecated`/`dangerous` are **sticky**; only a signed maintainer action resurrects.
- `dangerous` records are returned as **warnings on lookup** (the agent is told, not left silent) and `execute` **refuses** to hand out their plan.
- Confidence = Laplace-smoothed success rate `(s+1)/(n+2)` over counted outcomes.

This deliberately takes the harder side of the Skilldex debate — a multi-tier ladder — but pays for it with independent-evidence requirements instead of self-report volume.

## Tamper-evident ledger

Every mutation (contribution, application issuance, outcome, tier transition, maintainer action) appends a hash-chained, HMAC-sealed ledger entry **in the same SQLite transaction** as the mutation. Each entry commits a deterministic hash of the materialized registry tables. A separately HMAC-sealed checkpoint anchors the current sequence, ledger head, and registry-state hash, so primary-table edits and tail truncation are detected as well as ledger-row tampering.

The HMAC secret and checkpoint live in sidecar files (`<db>.secret`, `<db>.checkpoint`). Protect and back them up with the database. This detects database-only corruption or tampering; it does not defend a host compromise that exposes both database and secret.

## Quickstart (Windows-first)

```powershell
# install
pip install -e .

# seed the dense starter domain (8 Windows+bash pathbooks, FRP-PORT001 at `reproduced`)
pathbook-seed pathbook.db

# REST API on 127.0.0.1:8321
$env:PATHBOOK_DB = "pathbook.db"; pathbook-api

# register the MCP server with Claude Code
claude mcp add pathbook -e PATHBOOK_DB=C:\path\to\pathbook.db -- python -m pathbook.mcp_server
```

Linux delta: identical commands, `export` instead of `$env:`. The SQLite WAL files (`.db-wal`, `.db-shm`) sit next to the DB on both platforms.

### Library embedding (60 seconds)

```python
from pathbook import Registry, Keypair
from pathbook.authoring import make_record, make_outcome_report

reg = Registry("pathbook.db", maintainer_keys=["<hex pubkey>"])

# author + contribute (signed)
key = Keypair.generate()
rec = reg.contribute(make_record(key, author_id="me", record_id="PB-X001",
    title="...", error_signature="OSError: ...", trigger_yaml="...",
    remediation_yaml="...", verify_yaml="...", failed_attempts_yaml="..."))

# the loop
hit  = reg.lookup(error_text="oserror: ...")          # exact-hash index seek
plan = reg.execute(hit.candidates[0].id)              # persisted application_id
# ... agent applies fix, runs verify_yaml ...
agent = Keypair.generate()
reg.report_outcome(make_outcome_report(agent, reporter_id="agent-1",
    pathbook_id=plan["pathbook_id"], outcome="success", verify_passed=True,
    application_id=plan["application_id"]))           # telemetry + auto-promotion
```

### FastAPI embedding (aihangout or any host)

```python
from pathbook import Registry
from pathbook.api import build_router
app.include_router(build_router(Registry("pathbook.db")), prefix="/pathbook")
```

## REST endpoints

`GET /spec` · `GET /pathbooks` · `GET /pathbooks/lookup?error_text=|fingerprint=&runtime=` · `GET /pathbooks/{id}` · `POST /pathbooks` (201/401/409/422) · `POST /pathbooks/{id}/execute` · `POST /pathbooks/{id}/verify` · `POST /pathbooks/{id}/maintainer` · `GET /ledger/verify`

Standalone HTTP writes are allowed without an API key only from loopback. Set `PATHBOOK_API_KEY` for remote writes or mount the router behind the host platform's authentication and rate limiting.

Status codes: 401 bad signature · 403 not a maintainer · 404 not found · 409 duplicate id / key conflict · 422 malformed input. Error bodies carry `{code, message}` with agent-actionable messages.

## MCP tools

`pathbook_lookup` · `pathbook_get` · `pathbook_execute` · `pathbook_report_outcome` · `pathbook_contribute` · `pathbook_spec`

The MCP server auto-manages the agent's Ed25519 key (`PATHBOOK_AGENT_KEY_FILE`, created 0600 on first use) so every report and contribution is signed transparently. Consuming agents automatically feed telemetry back — the flywheel the design wanted.

## Test suite — 110 tests, all adversarial-first

| Suite | Tests | Proves |
|---|---|---|
| `test_fingerprint.py` | 15 | Determinism, on-purpose structural collisions, CRLF/unicode stability, truncation boundary, forged-token behavior documented |
| `test_signing.py` | 10 | Round-trip, every-field tamper detection, wrong-key & bit-flip rejection, fails-closed on garbage (never raises, never passes) |
| `test_trust.py` | 17 | Exact promotion thresholds, single-reporter spam stalls, author exclusion, auto-deprecation, danger dominance, sticky terminals, idempotent transitions |
| `test_ledger.py` | 6 | Payload tamper, row deletion, chain rewrite without secret, wrong secret — all detected with correct first_bad_seq |
| `test_registry.py` | 26 | Signature gates on all three write paths, fingerprint integrity, smuggled-trust-state stripping, TOFU key pinning, full ladder climb, replay idempotency, dangerous refusal |
| `test_concurrency.py` | 3 | 12 parallel writers → consistent telemetry + intact ledger; 8-way duplicate replay counts once; two registry instances on one DB |
| `test_api.py` | 13 | Correct status code per failure class; full loop over HTTP |
| `test_mcp.py` | 5 | Tool registration, full loop via MCP tools, self-report non-counting, seeded lookup hits |
| `test_seeds.py` | 3 | Idempotent seeding; every seed's error round-trips to an exact hit; FRP-PORT001 lands at `reproduced` |
| `test_hardening.py` | 11 | Issued-application enforcement, identity binding, safety screening, contextual fingerprints, primary-state/tail tamper detection, Windows binary-secret persistence |
| `test_multiprocess.py` | 1 | Independent Windows processes append and promote safely against the same registry |

Run: `python -m pytest` → `110 passed`, including a true Windows `spawn` multi-process writer test.

Also verified live in this build: seed CLI → real `uvicorn` server → HTTP loop promoted a record; real MCP client ↔ server over stdio transport; direct-DB tamper caught by ledger verification.

## Security model, stated plainly

- **Enforced now:** signature verification on all writes; persisted/expiring/single-use application IDs; optional executor identity binding; signed verification evidence; TOFU key pinning; registry-owned trust state; structured-content validation and injection screening; dangerous-operation confirmation; primary-state and ledger checkpoints; per-reporter caps; author exclusion.
- **Trust-on-first-use is TOFU:** first writer binds an identity to a key. There is no CA. Federation between registries would need key-exchange/allowlisting — out of scope for pbp-0.1, flagged honestly rather than implied.
- **Sybil boundary:** signatures alone do not prove real-world identity. Remote deployments must bind public keys to authenticated platform identities and apply rate limits; otherwise an attacker can create multiple identities.
- **Secret handling:** sidecar files are `0600` on POSIX. Windows delta: `chmod` is a no-op—use ACL-restricted storage or DPAPI/CNG-protected paths. The database, secret, and checkpoint are one backup unit.
- **Remediation boundary:** this package returns plans; it never executes contributed commands server-side. Consuming agents must sandbox execution and require confirmation for high-risk records.
- **License:** MIT; see `LICENSE`.

## Troubleshooting

- **`bad_signature` on contribute** — you mutated a signed field after signing, or signed a non-canonical payload. Always sign `record.signed_payload()` via `Keypair.sign_payload`; never hand-serialize.
- **`key_conflict` (409)** — that `author_id`/`reporter_id` is pinned to a different key. Use the original key or a new identity.
- **Lookup misses an error you swear is registered** — compare `normalize(your_text)` with `normalize(record.error_signature)`; any non-digit/non-hex textual difference (different exception class, different message wording) is a different fingerprint. That's the design: contribute a sibling record.
- **`database is locked`** — a reader on a non-WAL filesystem (some network shares). Keep the DB on local disk; WAL + 30s busy timeout handles normal contention.
- **Ledger verify fails after a restore** — you restored the DB but not the sidecar secret (or vice versa). They are one unit; back them up together.
- **`uvicorn pathbook.api:app` says app is None** — module-level app is lazy; use `pathbook-api`, or set `PATHBOOK_EAGER_APP=1`, or `uvicorn --factory pathbook.api:build_app`.

## Doc/code divergence: none by construction

`GET /spec` is generated from the same constants (`trust.py`) the engine enforces — the spec cannot drift from the implementation. Every claim in this README maps to a named test or a live check performed in this build.

## Repo layout

```
src/pathbook/
  fingerprint.py   normalization + sha256 fingerprint
  schema.py        pbp-0.1 records, tiers, outcome reports (signed vs registry-owned split)
  signing.py       Ed25519 over canonical JSON, fails-closed verification
  ledger.py        hash-chained + HMAC-sealed event log
  store.py         SQLite (WAL), fingerprint index, scope index, idempotent outcomes
  trust.py         promotion/demotion rules + anti-gaming (pure functions)
  registry.py      facade: all invariants, atomic transactions
  authoring.py     client-side helpers: build + sign records/reports
  api.py           FastAPI app + embeddable APIRouter
  mcp_server.py    MCP stdio server (the distribution wedge)
  seeds.py         dense Windows+bash starter domain (8 pathbooks)
tests/             110 adversarial-first tests (11 suites)
```
