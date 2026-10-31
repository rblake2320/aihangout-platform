# Session telemetry: REA reconstruction ledger

Owner requirement: "all info should be tracked on all levels: who is logging in, how long they
stay, what they are doing." Login and failure tracking already existed (`analytics_events`,
`enhanced_sessions`, the ops failure ledger). This feature adds client-side session capture,
rebuilt clean-room after reverse-engineering how shipped products behave.

Clean-room rule followed: only **behaviour** (event kinds, thresholds, masking rules, delivery
strategy) was taken from the retained scripts. No code or identifiers were copied. Where a value
could not be recovered it is listed under "Not recovered" and is our own design choice.

## Retained targets

| Target | URL | Bytes | SHA-256 |
|---|---|---|---|
| FullStory client (primary) | `https://edge.fullstory.com/s/fs.js` | 314,776 | `e737af798b7020e83db31478d1f344877ab6d69a8dd2b7acdf44671cd98c220b` |
| LogRocket loader (cross-check) | `https://cdn.lr-ingest.com/LogRocket.min.js` | 51,479 | `2b88558e296bfaddfec1ca9244aedd65f9195553587f2391bdf97a08f250bc78` |
| LogRocket logger (lazy chunk) | `https://cdn.lr-ingest.com/logger-1.min.js` | 765,816 | `b98baac89351e07924efab83bbbbd1712cb9ba94670f725c3178a1ceb9e41314` |
| Runtime blob script (LogRocket) | `blob:` (worker/inline) | 406,784 | `de0e38561d1fdfd7a9b331f28d236cbdf5c4ff16ec80521811329d89d0151113` |

Bytes are Playwright `Response.body()` results as retained by REA (not guaranteed identical to wire
bytes). Only the first three were read for behaviour. REA's complete Evidence bundle for the
session (9 records) was exported to the task results directory (SHA-256
`330d67b4ff755429b9f4148f5df92631336e738930923c521d8ac8926f34ede3`, 188,759,945 bytes); it is not committed.

## REA tool calls (rea-agents 6.7.0, MCP)

| # | Tool | Outcome | Evidence ID |
|---|---|---|---|
| 1 | `capture_browser_scenario` (navigate straight to `fs.js`, response bodies on) | OK, but the script was recorded as a `document`, not a script | `ev_a7a7c5e4306a3339eb15071af72d31e84a420af0c5d502529c7625bc7b5fe5e9` |
| 2 | `export_web_scripts` on call 1 | **FAILED** (twice-checked): "No script bytes were exportable" | `ev_a63cd6581ab56e3c276330df903b19cd5eddbfec10ea82628957764650784eb4` |
| 3 | `capture_browser_scenario` (loopback fixture page loading both vendors via `<script>`) | OK | `ev_761a42bfee81fd6f0e4104eeefee59782459fd085efe594ee58421d58ada0334` |
| 4 | `export_web_scripts` on call 3 | OK, 4 scripts exported, digests verified | `ev_c78b7ace9d2a07de4509fe95c12284d506c23a0f732419c3b86dacb5e5b4f647` |
| 5 | `analyze_javascript_application` (detail=summary) | OK: 4 files, 351 modules, 0 parse failures; coverage **partial**, 63,433 semantic unknowns (dynamic calls and properties) | view `ev_dc5497f43d3750c0cce53fb64dc0c754a92bac8c4f54e25174e46c1abcdb9586`, parent `ev_da8cf31f7d2b711af910bf7e8674fa00300ce6a8d60a030e838ed6859ed05a6b` |
| 6 | `trace_javascript_semantics` (literal `visibilitychange`, forward) | **FAILED**: `resource_constraint`, response over the 10 MiB MCP budget (analysis itself completed and is retained) | `ev_bef6177dbec1d2ad80e7d509d60941aa2bd4ea2f9765060f897d55f082e70fa4` |
| 7 | `capture_browser_scenario` on **our** built client (real Chromium 156), request bodies on | OK; found a duplicate-`page_leave` bug and a scroll-depth gap (fixed) | `ev_7efeda9ae34912c61c601201c7f57f575e6b011561d56b712b7fcb4a770fc3fb` |
| 8 | Same scenario after the fix | OK; one `page_leave`, scroll 23% | `ev_113ed38b7ede8aaa58930be3c56e5750a93b7bb7629c29580326230a4c690abb` |
| 9 | `export_evidence_bundle` | OK | n/a |

Not run: `recover_javascript_sources` (documented prerequisite: caller-supplied Wakaru on Linux x64,
not available on this Windows host), `build_reconstruction_obligation_ledger` and
`evaluate_reconstruction_coverage` (see "What REA could not do"). The CLI fallback was not needed:
no MCP tool that mattered failed twice with the same input (call 2 was an input problem, fixed by
call 3; call 6 was a transport size limit).

How the behaviour was read: REA retained and hashed the script bytes (calls 3-5). The thresholds and
event lists below were then read from those exact retained files with targeted text searches, so
each row is **derived from shipped-artifact bytes** and is static evidence only; none of it was
observed executing in the vendors' own pages. REA's JavaScript graph (call 5) corroborates the
module inventory but its trace call (6) was too large to read through MCP.

## Ledger: behaviour -> evidence -> our code

Source key: **FS** = `fs.js`, **LR** = `logger-1.min.js`. All cite parent `ev_da8cf31f...` /
export `ev_c78b7ace...` for the retained bytes.

| Behaviour | Value recovered | Source | Where it lives in our code |
|---|---|---|---|
| Rage click window | 2000 ms | FS | `types.ts` `DEFAULT_CONFIG.rage.windowMs`; `rage.ts` |
| Rage click threshold | 5 clicks | FS | `DEFAULT_CONFIG.rage.count` |
| Higher threshold when the page changes during the burst | 8 clicks | FS | `DEFAULT_CONFIG.rage.countIfNavigated`; `rage.ts` (`navigated`) |
| Quiet period before a rage detector re-arms | 2000 ms | FS | `rage.ts` (fires once per burst, re-arms after a quiet window) |
| Clicks carry a rage flag; dead clicks are a distinct event | event kinds | LR | `rage_click`, `dead_click` event types |
| Dead click = mousedown then click with no reaction; new-tab touches excluded | structure | LR | `dead.ts` `DeadClickDetector`, `isDeadClickCandidate` |
| Scroll sampled at a fixed interval | 50 ms | FS | `DEFAULT_CONFIG.scrollSampleMs` |
| Listeners: click, dblclick, popstate, visibilitychange, pagehide, blur, scroll, resize | list | FS | `index.ts` (click, popstate, visibilitychange, pagehide, scroll) |
| History API patched for SPA navigation | pushState/replaceState | FS | `index.ts` route-change hook |
| Console/page errors and unhandled promise rejections captured, capped per page | cap 1024 console entries | FS | `index.ts` `reportError`; our cap `maxErrorsPerPage = 50` (own choice) |
| XHR watched for failures | XHR hook | FS | `index.ts` XHR + fetch wrappers -> `net_fail` |
| Free-text payload caps | 8192 chars (custom event), 1024 (event type), 16384 (ajax payload) | FS | worker `TELEMETRY_SPECS` caps (message 300, stack 1000; own choices, stricter) |
| Default privacy exclusions: password, hidden, credit-card autocomplete | selectors | FS | `mask.ts` `isExcluded` |
| Class-driven exclude / mask / unmask controls | `.fs-exclude`, `.fs-mask`, `.fs-unmask` | FS | `mask.ts` `EXCLUDE_CLASS = 'tel-exclude'` (we only need exclude) |
| URL privacy: strip hash and query values | rule | FS | `mask.ts` `sanitizeRoute`; worker strips `?`/`#` again |
| Redaction placeholder instead of the value | `__fs__redacted` | FS | we never read values at all; free text becomes `<email>`/`<token>` (`mask.ts`, worker `scrubTelemetryString`) |
| Text/textarea/password values are redacted, with an audit trail of redactions | rule | LR | not needed: values are never read (`index.ts`, test `never lets a raw input value reach D1`) |
| Delivery uses `sendBeacon`, and falls back when it is missing, throws, or returns false | strategy | FS | `transport.ts` `sendBatch` |
| Exponential backoff with a ceiling | 300000 ms | FS | `DEFAULT_CONFIG.backoff.maxMs`; `queue.ts` |
| Server can override upload and heartbeat intervals | settings keys | FS | not built; our interval is a client constant |
| Heartbeat interval | 256200 ms | FS | existing `enhanced_sessions` heartbeat is unchanged |
| Page inactivity timeout (session expiry) | 1,800,000 ms | FS | `index.ts` `SESSION_EXPIRY_MS` (30 min) |
| Web-vitals style metrics flushed when the page becomes hidden | CLS/FID/LCP | LR | not built (out of the brief's event list) |
| Sampling by a rate compared to a threshold, per recording | rule | LR | `types.ts` `sampleRate`; decided once per session in `index.ts` |

## Not recovered (our values are design choices, not reconstructed)

- Dead-click wait: `deadClickMs = 1000`. LogRocket's dead-click monitor exists, but its timing
  constant was not located in the minified code in the time available.
- Idle threshold for active-vs-idle time: `idleMs = 30000`. FS only exposes a 30-minute *session*
  inactivity value, not a per-page idle cut-off.
- Batch size and flush interval (`maxEvents 20`, `maxBytes 48000`, `flushIntervalMs 10000`): the
  reference products take these from server-pushed settings, so no static constant exists.
- LogRocket rage-click thresholds: the `isRageClick` flag is set elsewhere (not in the files read).
- Form-abandonment: no explicit equivalent event was found in either script; ours is a design.

## What REA could not do (assessment inputs)

- `export_web_scripts` only exports scripts that the browser loaded as `script` resources; directing
  the browser at the `.js` URL does not work. A fixture page with a `<script>` tag is required.
- `trace_javascript_semantics` on a large minified bundle exceeded the MCP response budget even for a
  single literal seed; results exist only as retained Evidence. Reading them needs the CLI or
  `inspect_analysis_view` with a known node id.
- Static graph coverage on these bundles is partial (63k unknowns, mostly dynamic dispatch), so the
  graph cannot by itself answer "what threshold gates this call".
- `recover_javascript_sources` needs Wakaru on Linux x64; not available here.
- The formal ledger tools (`build_reconstruction_obligation_ledger`,
  `evaluate_reconstruction_coverage`) require the full evidence bundle inline plus reviewed
  obligations and verifier contracts. The bundle for this session is 188 MB, so this ledger is
  maintained by hand in this file instead. It has **not** been machine-verified by REA.

## Verification of our implementation

- `npm test`: 9 files, 91 tests, exit 0 (includes `test/session-telemetry.test.js` against real D1
  and real migrations, and `test/session-telemetry-client.test.js` for the pure client logic).
- A mutation check (worker passing raw `data` through) is caught by 2 of the new tests.
- Real-browser run of the bundled client (Chromium 156, REA evidence 7 and 8): rage (count 5), dead,
  form-abandon (typed email and password never present in any captured request), single page-leave
  via `sendBeacon`, page-view on route change.
- **Not covered by automated tests:** the DOM wiring in `frontend/src/telemetry/index.ts` (listeners,
  history/XHR/fetch patching). It was exercised once by the real-browser run above, not by a
  repeatable test. The server-side kill switch (`TELEMETRY_DISABLED`) is implemented but has no test,
  because the Worker test bindings are fixed in `vitest.config.mjs`.
- Not verified: behaviour against production, real traffic volume, or D1 write cost at scale. Each
  batch performs up to 50 single-row inserts; at the per-IP limit of 30 requests/minute that is a
  ceiling of 1,500 rows/minute per IP, which has not been load tested.
