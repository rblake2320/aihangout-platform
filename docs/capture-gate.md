# Capture gate

A deploy gate built on REA's real-browser scenario capture. It records the critical user
flows as declared scenarios, replays them in Chromium against an origin, and fails when a
step's HTTP status, JSON response shape, key DOM selectors, storage keys or page errors
differ from a baseline. Every deploy can then ship with a before/after receipt.

Why it exists: unit tests run in workerd and never execute the shipped frontend bundle
against the shipped Worker. A real browser run found a defect they could not. This gate keeps
that class of check permanent.

## Layout

| Path | Purpose |
|---|---|
| `gate/scenarios/*.json` | REA `capture_browser_scenario` inputs. `__ORIGIN__` is replaced at run time; the browser executable is injected from `GATE_CHROME`. Credentials are REA *secrets* (env-sourced, redacted in Evidence). |
| `gate/rules.json` | Declared ignore rules: URL normalisation (asset hashes, ids, timestamps), polling endpoints, volatile storage keys, key DOM selectors, forbidden (production) hosts. |
| `gate/expectations.json` | Absolute per-step expectations (e.g. invalid register is `400`, bad login `401`, non-admin admin check `403`). Independent of any baseline. Any `5xx` response also fails. |
| `gate/lib.mjs` | Pure comparator (no fs). Unit-tested under `npm test`. |
| `scripts/capture-gate.mjs` | Runner: capture via the REA CLI, store canonical Evidence, compare to a baseline. |
| `scripts/capture-gate-local.mjs` | One command: fresh local D1 + KV, real migrations, `wrangler dev`, run the gate, tear down. |
| `gate/captures/local/` | Committed local baseline (canonical Evidence JSON, one file per scenario, plus `report.json`). |
| `.github/workflows/capture-gate.yml` | CI job. Uploads captures as an artifact. |

## Scenarios

| Scenario | Flow | Asserts |
|---|---|---|
| `01-home-load` | Load `/` | Page renders; no 5xx |
| `02-register-invalid` | Register with a common password | `POST /api/auth/register` → 400 |
| `03-register-valid` | Register with TOS accepted | → 200 (local/staging only) |
| `04-login-bad-password` | Sign in with a wrong password | `POST /api/auth/login` → 401 |
| `05-post-problem` | Register, post a problem | `POST /api/problems` → 200 |
| `06-view-problem` | Register, post, land on the problem | `GET /api/problems/:id` → 200 |
| `07-admin-ops-non-admin` | Register, open `/admin` | `GET /api/bug-reports?limit=50` → 403 (the admin access check the Ops tab sits behind) |

Each mutating scenario registers its own throwaway user (`gate…@example.test`), so the gate
never depends on, or touches, existing accounts. **Production is refused**: any `aihangout.ai`
host aborts the run before a browser starts (`forbidden_hosts`, unit-tested).

Notes on how the scenarios are shaped, from running them:
- The register form blocks passwords under 12 characters client-side, so a short password
  sends no request. `02` uses a 12-character common password to reach the server's 400.
- A user's first post is `pending_review` and is not in the feed, so `06` reaches the problem
  through the post redirect rather than by clicking it in the feed. `05` and `06` overlap by
  design.
- `/admin` for a non-admin renders "Admin access unavailable" after the 403; the Ops summary
  endpoint itself is never reached, so the 403 asserted is the admin check.

## Run it

Prerequisites: Node 22, `npm ci`, a Chromium/Chrome binary, and the REA CLI (`rea-agents`
6.7.0; this gate does not install or upgrade REA).

```bash
export GATE_CHROME=/path/to/chrome            # absolute path
export REA_BIN="rea"                          # or "npx -y rea-agents@6.7.0"

# Local, fresh DB, compare to the committed baseline (this is what CI runs)
node scripts/capture-gate-local.mjs --out gate-run --baseline gate/captures/local

# Refresh the baseline (deliberate, reviewed in the PR diff)
node scripts/capture-gate-local.mjs --out gate/captures

# Any origin that is not production, e.g. staging
node scripts/capture-gate.mjs --origin https://<staging-host> --baseline gate/captures/local --pause-ms 15000
```

Exit codes: `0` all scenarios match; `1` a scenario differs (readable diff on stderr);
`2` the gate itself could not run (bad args, REA error, malformed capture).

Diff output looks like:

```
FAIL 04-login-bad-password (ev_…)
  [04-login-bad-password] step=submit expectation: server error response: POST <ORIGIN>/api/auth/login 500
  [04-login-bad-password] step=form-ready dom-selector: #password: baseline=present current=absent
  [04-login-bad-password] step=submit response-status: only in baseline: POST <ORIGIN>/api/auth/login 401
```

### Run it from an agent (MCP)

An agent can capture a scenario with the `mcp__rea__capture_browser_scenario` tool (same
schema as the files in `gate/scenarios`), save the returned Evidence as
`<dir>/<scenario>.evidence.json`, and run the comparison with
`node scripts/capture-gate.mjs --origin <url> --from-evidence <dir> --baseline <baseline>`.

### Signup rate limit

Registration is limited to 5 per minute and 20 per hour per IP, and each scenario that
registers spends one. A full run uses 5. `capture-gate-local.mjs` starts from an empty KV so
it never trips this; against a long-lived origin keep `--pause-ms 15000` and avoid more than
three full runs an hour. A `429` shows up as a failed expectation, not a silent pass.

## What it catches

- A status code changing (`401`→`500`, `200`→`403`) on any API call a flow makes.
- A JSON response gaining or losing a field, or changing a field's type (values are ignored).
- A key element disappearing from a rendered page (`#email`, `form`, `[role=alert]`, …).
- A new or removed local/session/cookie storage key.
- A new uncaught page error.
- A flow that stops reaching its next step (REA step alignment fails, or the step fails).

## What it does not catch

- Visual regressions: screenshots are not requested, so layout and styling are not compared.
- Values: only response structure is compared, so a wrong-but-well-formed value passes.
- Anything the declared steps do not exercise (admin-only success paths, payments, SSE chat).
- Behaviour behind real email delivery.
- Differences hidden by `ignore_requests` / `ignore_storage_keys` (reviewed in the PR diff).

## REA tools: what worked, what did not

See the table in the owner report; short form:

- `capture_browser_scenario` (CLI and MCP): worked for every flow. Real Chromium, redacted
  secrets, per-step DOM/URL/storage and network events with response bodies.
- `compare_web_captures` (CLI): worked, with limits below. Its own `overall_status` is not
  usable as a gate on its own, so the wrapper uses it for step alignment only.
- `compare_web_captures` validates artifact integrity: a hand-edited capture whose DOM
  digest no longer matches is rejected rather than compared. Mutating test captures needs the
  digest recomputed.

### Limits found

1. **Identical reruns compare as `changed`.** Per-session ids hashed into storage, and
   in-flight polling requests that "had not completed when capture ended", make REA's
   artifact-level status noisy. Captures are marked `equality_eligible: false` for the same
   reason. The wrapper therefore decides pass/fail from its own reduction of the Evidence and
   treats REA's result as an alignment check.
2. **Origin or browser-build mismatch → `capture_context_mismatch`** (alignment `partial`).
   Comparing local to staging, or a CI Chrome to the recorded one, always triggers it. The
   wrapper tolerates only that code, and only when the origin or browser version really
   differs; missing or extra steps still fail.
3. **Response attribution is a timing race.** A response (or a request fired by an effect
   after `domcontentloaded`) is recorded on whichever step is running when it arrives, often
   the *next* wait step. The wrapper attributes traffic to the last non-wait action instead.
4. **Normalisation is exact-literal only** (no regex), so asset hashes, ids and timestamps
   are handled by the wrapper's own `gate/rules.json`, not by REA's `--normalization-json`.
5. **MCP compare needs both full results inline**, which for DOM-bearing captures is hundreds
   of KB per call. The committed gate uses the CLI for comparison; MCP is practical for
   capture and for small captures.
6. **Capture size**: ~200–470 KB per scenario with DOM at every step (≈2.3 MB for the set).
7. **Fixed CI environment**: the baseline was recorded with Chromium 156 on Windows; CI runs
   Chrome on Linux. Structure matches; a DOM/status difference caused by the platform itself
   would show as a diff and need a re-baseline from CI.

## Re-baselining

Only when a diff is an intended change. Run the refresh command above, review the diff of
`gate/captures/local/*.evidence.json` and `report.json` in the PR, and say in the PR
description which flow changed and why. Do not refresh to make the job pass.
