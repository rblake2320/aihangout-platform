# Bundle recon

Repeatable, diffable reconnaissance of the JavaScript bundle we ship, done the way an
attacker would start: fetch what the origin serves, enumerate everything the client
reveals, and check which "hidden" things the server really enforces.

- Tool: `scripts/bundle-recon.mjs` (pure logic in `scripts/lib/bundle-extract.mjs`).
- Baselines: `recon/aihangout.ai/<date>.json` (live) and `recon/local-dist/<date>.json` (built `frontend/dist`, used by CI).
- Gate: `bundle-recon` job in `.github/workflows/ci.yml`.
- Tests: `test/bundle-recon.test.js` (extractor fixture, diff gate, server-enforcement contract).

## Usage

```bash
node scripts/bundle-recon.mjs https://aihangout.ai                 # writes recon/aihangout.ai/<date>.json
node scripts/bundle-recon.mjs --dist frontend/dist --label local-dist --no-write --diff recon/local-dist
node scripts/bundle-recon.mjs https://aihangout.ai --diff recon/aihangout.ai   # newest baseline in the directory
```

Exit codes: `0` ok, `1` usage or fetch error, `2` the diff found a **new suspicious literal, a new
admin route, or a newly exposed source map**. Added or removed API routes, hosts, flags and
storage keys are printed but do not fail the gate.

What it records per run: SHA-256 and size of the index and every asset (chunks are followed
recursively), API route strings, axios-style relative calls (with `baseURL`), page routes, admin
routes, external hosts, `localStorage`/`sessionStorage` keys, `VITE_*`/`import.meta.env` and boolean
feature-flag constants, e-mail literals, every `is_admin` guard with its surrounding context,
`sourceMappingURL` references, and a `.map` probe per asset.

Design points that came from real traps:

- **SPA fallback.** The live site answers `200 text/html` for unknown paths, including `*.js.map`,
  `robots.txt` and `/admin`. A source map only counts when the body is JSON with `mappings`.
- **Redaction.** Suspicious literals are stored as kind, length, 4-character prefix and a SHA-256
  prefix, never the value, so the committed baseline cannot itself leak a secret. Private or
  internal hosts in `externalHosts` are stored as `private-host:<hash>`.
  (The unit test found that the first version wrote a private IP verbatim; fixed.)
- **Property access is not a host.** `this.internal` in vendor code is not an internal hostname;
  the pattern requires a quote, `@` or `//` before the name.

## Findings (live site, 2026-10-31, worker version 4d441691)

Scope: https://aihangout.ai only, read-only requests, no login, no mutation. Evidence IDs are
from the REA session (rea-agents 6.7.0); artifact hashes are in the table below.

| # | Finding | Evidence | Proof request (status) | Disposition |
|---|---|---|---|---|
| F1 | Admin UI calls `/api/admin/ops-summary`, `/api/admin/reports`, `/api/admin/flagged-content`; UI shows the Admin link only when `user.is_admin` (client-only guard) | E2, E3 | `GET` each, anonymous and with an invalid bearer: **403** `Admin access required` / `Admin required` | Server enforces. Accepted. Regression: `server enforces what the UI hides` |
| F2 | Bug-report triage (`GET /bug-reports`, `GET /bug-reports/:id`, `PATCH /bug-reports/:id/status`) is admin-only in the UI | E2, E3 | `GET /api/bug-reports`, `GET /api/bug-reports/<nil uuid>`, anonymous and invalid bearer: **403**. `PATCH` not sent live (mutating); guard confirmed in `src/worker.js` (`!user.is_admin` -> 403) and by the workerd test with anonymous, bogus-token and a registered non-admin user | Server enforces. Accepted. Regression test |
| F3 | Auth-only routes in the bundle: notifications, settings, bookmarks, pathbook signing-context / execute / verify | E2 | `GET /api/notifications`, `/api/users/me/settings`, `/api/bookmarks`, `/api/pathbooks/signing-context`: **401**. `execute`/`verify` are `POST`: tested in workerd only (401) | Server enforces. Accepted. Regression test |
| F4 | `/admin` page route is client-guarded; the SPA shell is served to everyone | E8 | Anonymous load of `/admin` in a clean browser: **200** HTML shell, and **zero** `/api/admin/*` requests fired (E8 network log) | Accepted: shell holds no data; data routes enforce server-side (F1) |
| F5 | Secret-like literals in all 6 served scripts + CSS (JWT, AWS, Stripe, GitHub, Slack, Google keys, PEM blocks, credential assignments, private IPs, `.internal`/`.lan` hosts) | E3, `recon/aihangout.ai/2026-10-31.json` | Extractor: **0** hits. Manual grep of the same files for the same classes: 0 | No exposure found in this scope |
| F6 | Source maps | `recon/...` assets[].sourceMapExposed | `GET <asset>.js.map` for all 6 scripts: **200 `text/html`** (SPA fallback, not a map); no `sourceMappingURL` comments | No source map exposed. Accepted |
| F7 | Auth token is persisted in `localStorage` (`ai-hangout-auth`, zustand `persist` with `token`) | E2 (storage keys), bundle | n/a (client design) | Accepted for now; mitigated by strict CSP (`script-src 'self' https://static.cloudflareinsights.com`). Hardening candidate: httpOnly cookie session |
| F8 | External hosts: `https://electionclock.com` (outbound link in the bundle), `https://aihangout.ai`, `wss://aihangout.ai`; vendor doc URLs filtered as noise | E2 | CSP `connect-src` allows only self + Cloudflare Insights | Accepted |
| F9 | Public e-mail literals: `dmca@`, `legal@`, `privacy@` `aihangout.ai` | E3 | n/a | Intended contact addresses |
| F10 | Public read APIs reachable anonymously: `/api/problems`, `/api/pathbooks`, `/api/versions`, `/api/learning/*`, `/api/live/count`, user profile + followers | E2 | `GET`: **200**. Response keys scanned for e-mail, IP, token, hash, secret, password, address, session names: none | Public by design; no PII-bearing field found |
| F11 | `GET /api/live/count?test=deployment` is a leftover debug branch returning a static banner; the same handler returns `error.message` in its 500 body | `src/worker.js` read | Not exercised beyond reading source | Cosmetic, reported only (not proven exploitable; brief says cosmetic findings stay out of code) |
| F12 | CORS: `Access-Control-Allow-Origin` is pinned to `https://aihangout.ai` (a hostile `Origin` still gets the pinned value); `Allow-Methods` omits `PATCH` | -- | `GET` and preflight with a foreign `Origin` | Cosmetic; same-origin PATCH is unaffected |
| F13 | `robots.txt`, `sitemap.xml`, `llms.txt` return the SPA shell (`200 text/html`) | -- | `GET` | Cosmetic (SEO), not security |

**Real exposures proven: none. Server-side code changes: none.** The brief asks for a fix and
test for each proven exposure; none was proven, so the deliverable is the tool, the CI gate and
a regression suite that now pins the server behaviour F1-F3 relied on. This is a statement about
what this recon covered (client-visible routes, read-only probes), not a claim the platform is
secure. Not covered: mutating requests against production (forbidden by the brief), authenticated
and admin-role behaviour, rate limiting, the chat SSE path, and the worker's non-bundled routes
that the client never references.

## Artifacts (SHA-256)

| Artifact | SHA-256 | REA Evidence |
|---|---|---|
| Passive page capture (`inspect_web_page`) | `2130ff4d05bce27bd049cccd51af1166dffe7029c5c8f12be30e85532216112f` | `ev_2ecdc3c3a26d3a9cb3d17b94dcf54436b8565bcb236d7eb8e5e56d07d4a6684c` |
| Script export manifest | `2542a68d6d74a09973dbf73f57dc30a6663d095ebdf6df52eeac2186df80edf1` | `ev_a6c9f656219bb95f72062cb0fd0f8ad2cfba594573d3ee7e40e28952f54293a3` |
| `assets/index-CDxjmwRw.js` | `1509f8422f9a53e56387ed82771cbe579d76074bef05a8de737535428b62deef` | (export E3) |
| `assets/vendor-DYDQj1ul.js` | `d6606a25ef5227c1502796135c4a6229995b4be43b223c82c80d2dfd241e50b1` | (export E3) |
| `assets/utils-BIj3xgju.js` | `370a5d11f7698c9a3d2918728a9194caadb0ed1502d37b92854530420619b8f0` | (export E3) |
| `assets/ui-CU4180iU.js` | `0e39ade2289b6b7d77d8a1d8bd1e64b772cfed8207f2f124ffa118d730ff0441` | (export E3) |
| `assets/state-tNdC39m3.js` | `31f2923c8587960255ebd8f7376d93692fb8f25c606ce6ee0d51424289024d81` | (export E3) |
| `assets/rolldown-runtime-NMqb_1LM.js` | `55145894ae53e3b9862b73a794c8df6ca96e6766497d00f7449994b875eefd01` | (export E3) |
| Application graph summary (`analyze_javascript_application`) | exported dir `7b5e2609ce7d98ace440994b9ae5cb0b79cee88f461deeeacf5bb0d2220181a2` | `ev_33e309d948d0a0eebf5aa6bc863c485f1985d177545345496e0843c70b52b7a9` (parent `ev_07faf482171ec25a8164b4123caa080014ba9cbcc5f0a2ad26ec9e41fc52dce5`) |
| Target list | -- | `ev_111e52aa55bc45fed541b7884e515a1e6fe6514b1a61d2159437ea1c26406191` |
| WebMCP discovery (0 tools) | -- | `ev_ed6dd8ef190178bfd16e401b3312ab78d996008b844d95bbd09bff706d650cca` |
| Event listeners (`a`) | `1994ec6e14937b1c69a2ad5c900018a34f3367365f350a0cd81c2d0be1491f16` | `ev_7914d67652a5e589bdf8fd66952e02cd328f6a3b19c395ee25dbf9c8cbf821c4` |
| Screenshot | PNG `bb69ede1ec9c70a9702b9265cf350dcb3df98990184a04f9d1a4ac2f78e08c60` | `ev_75fc7519de942460ecd13b14608a036a64a5fb81caa356b9c0ce9ac193d5bc9c` |
| `/admin` anonymous scenario | `4999d2a91049591d19661ec2508fc8456f06b6f6974b46bf54976a362ef10ea0` | `ev_59b01e5e11669122edaf99bf893011f0836f51629b5e8681dc5bef9830bd8f53` |
| Probe log (status codes) | `3dc8fb4a691b1ac661862df9a57671bc4e68cbc58c96a1a63e37f2687a87e05e` | -- |

## REA tools: worked / failed

| Tool | Result | Note |
|---|---|---|
| `list_browser_targets` | worked | needs a loopback CDP browser started by the operator |
| `inspect_web_page` (+ script sources, storage keys) | worked | 971k-char result exceeds the client inline limit; saved to a file and used as `capture_path` |
| `export_web_scripts` | worked | 6 scripts exported with digests; only scripts the page loaded (this app ships one eager bundle, no lazy chunks) |
| `analyze_javascript_application` (summary) | partial | `vendor-*.js` exhausted the analyzer heap (1 GiB default); 5 of 6 files parsed, graph coverage "partial", 23,485 semantic unknowns. Raising `max_heap_mb` not tried |
| `inspect_web_event_listeners` | worked | selector `a` matched the first anchor; 1 listener; 185k-char result |
| `discover_webmcp_tools` | worked | 0 page-declared tools |
| `capture_web_screenshot` | worked | PNG with SHA-256 |
| `capture_browser_scenario` (launch mode) | worked | anonymous `/admin`, 78 network events, no `/api/admin/*` call |
| `trace_web_module_imports` | **failed** | `capability_unavailable`: needs `REA_BROWSER_EXECUTABLE`; not set, and changing REA configuration was out of scope |
| `trace_javascript_semantics` | **failed** | `evidence_integrity_mismatch`: parent evidence returned by the summary view reported as "not retained in this session". Issued in the same turn as the crash below, so whether the cause was the crash is UNPROVEN |
| `analyze_web_bundle` | **failed** | first call: validation error (`include_script_sources` must be `true`, no way to skip sources); second call (live page, `fetch_source_maps: true`): `Connection closed`, and every `mcp__rea__*` tool was unavailable afterwards for the rest of the session |
| `inspect_analysis_view`, `get_evidence_bundle`, `export_evidence_bundle`, `recover_javascript_sources`, `observe_web_session`, `search_strings` | not exercised | the first three were loaded but not reached before the server dropped; `recover_javascript_sources` needs Linux x64 + Wakaru; `search_strings` is for native binaries |

Because the REA server disconnected, the retained Evidence for the session could not be
exported as a bundle; the per-call result files and their SHA-256 are the retained record.
