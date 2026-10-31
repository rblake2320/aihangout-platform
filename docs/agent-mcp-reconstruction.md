# aihangout agent MCP: evidence ledger

Clean-room record of how the `/mcp` endpoint (`src/mcp/server.js`) and `packages/aihangout-sdk/`
were designed. Behaviour only; no code or identifiers were copied from the analysed packages.
Date: 2026-10-31. REA: rea-agents 6.7.0 (MCP server, not upgraded or reconfigured).

## 1. Retained artifacts

Scratch directory outside the repo; file names below are relative to it.

| Artifact | SHA-256 | REA Evidence ID |
|---|---|---|
| `@modelcontextprotocol/server-github@2025.4.8` tarball | `1d5b1bca9305adf0c8055131f2286514c9bea6eb31100460899a1ed9ffece5c1` | n/a (input) |
| unpacked `package/` tree (REA directory subject digest) | `08e0e9c8b68c3bb560c59f745a8eabe9f39598aaeaba859aa20c23bdcd38118d` | `ev_973ce104cc87839531ccc1885993288dcf5485475d3bcedc49c615a1807b6ea7` |
| github `dist/index.js` / `dist/common/errors.js` | `e1d0ea90...37e6` / `c58afcd6...1219` | (inside the above) |
| `@modelcontextprotocol/server-slack@2025.4.25` tarball | `b7180332e64e506234ec7d6c688e9327645f1a7207f198fbd406fdf91dabd24f` | n/a (input) |
| unpacked `package/` tree (REA directory subject digest) | `e9406719a72107129a854fc842d8313b70403ae506152433eae06eb881989cb1` | `ev_1d9b10fd12df872497b2e56524748f39e0d984d26a4ae13516a993ce7ed0470e` |
| slack `dist/index.js` | `02babbfa4d6a86db6f761b78c95f5efb45814eda5c75d502f05f98a12b8ebd76` | (inside the above) |
| REA slack analysis JSON (`slack-analysis.mcp.json`) | `b17797bffc5b53a5d014dd9ae95683eaa4765ad184cc511c7b9fd8169d79a64d` | same as slack row |
| REA github analysis JSON via CLI (`github-analysis.cli.json`) | `599c0d7d3cbf35469f9e6bdcc182986003f8272ecd10084051455542dcb41bea` | same ID as the MCP-retained record |
| Linear `POST /mcp` unauthenticated initialize, 401 headers (`linear-init.txt`) | `d12cdf2e781385cf33613eca92e755cd15e9d6f2f4bfaec04290223578c3c03d` | none (curl) |
| Linear `/.well-known/oauth-protected-resource/mcp` (`linear-prm.txt`) | `34c2ca0ea7744e8289ce6fa8dad5e5b4e825f7953cdcaf04bfda837cd9315465` | none (curl) |
| Linear `/.well-known/oauth-authorization-server` (`linear-asm.txt`) | `7a6cf3c6484807795b6bbf0e5db40b8d86d4703573890e821eef1b50dc64c460` | none (curl) |

Claude Desktop / Cursor client bundles: skipped. `%LOCALAPPDATA%\Claude` holds only `Logs/`, `Claude-3p`
is empty, and no Cursor directory exists on this machine.

## 2. Behaviour -> evidence -> our code

| Behaviour recovered | Evidence | Where in our code |
|---|---|---|
| Tool names are `verb_noun` snake_case, one operation per tool (GitHub: `list_issues`, `get_issue`, `create_issue`; Slack prefixes the product: `slack_list_channels`) | github `dist/index.js` tool list; slack `dist/index.js` tool list (ev_973c..., ev_1d9b...) | `list_problems`, `get_problem`, `post_problem`, `post_solution`, `search`, `whoami`. No product prefix: the server name already namespaces tools in every client |
| Input schemas are JSON Schema generated from a validator schema (GitHub: zod to JSON Schema; Slack: hand-written), each property described | github `index.js` `inputSchema:` entries; slack `inputSchema` blocks | zod shapes in `buildServer()`; `tools/list` test asserts `type: object`, `required`, integer `problem_id` |
| Offset paging in GitHub (`page`, `per_page`); opaque `cursor` plus clamped `limit` (max 200) in Slack, next cursor read from `response_metadata.next_cursor` | github `operations/issues.js`; slack `getChannels`/`getUsers` | `list_problems` / `search`: opaque base64url cursor wrapping the REST offset, `limit` max 50, `next_cursor: null` on the last page. Test: `list_problems paginates with opaque cursors` |
| No idempotency keys in either server (writes are plain POSTs) | absence in both trees; limitation of static reading | `idempotency_key` accepted on `post_problem` / `post_solution` and forwarded as `Idempotency-Key`. **Not yet enforced by the REST routes** (see section 4) |
| Rate limit: GitHub models a typed 429 error carrying a `reset_at` timestamp, defaulting to now+60s when absent | github `common/errors.js` (`GitHubRateLimitError`) | `RATE_LIMITED` error with numeric `retry_after` seconds (REST `Retry-After`), front-door limit returns HTTP 429 + `Retry-After: 60`. Tests: `rate limit -> RATE_LIMITED`, `front-door rate limit` |
| Error taxonomy by HTTP status: 401 auth, 403 permission, 404 not found, 409 conflict, 422 validation, 429 rate limit | github `common/errors.js` `createGitHubError` | `codeForStatus()`; REST-supplied `code` (e.g. `TOS_ACCEPTANCE_REQUIRED`) wins. Tests: NOT_FOUND, TOS, INVALID_ARGUMENT |
| Both servers return errors as plain text. GitHub throws a formatted string; Slack folds `{error: message}` into a normal result with no error flag, so a client cannot tell failure from success without parsing | slack `index.js` catch block; github `formatGitHubError` call site | Deliberate divergence: `isError: true` plus `structuredContent.error = {code, message, status?, retry_after?}` and the same JSON in the text block |
| Success payloads are JSON serialised into one text content block | both `index.js` | Same, plus `structuredContent` carrying the identical object |
| Linear hosted MCP: unauthenticated `POST /mcp` answers 401, empty body, `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="...", scope="read write"`, `Cache-Control: no-store` | `linear-init.txt` | `authChallenge()`: 401 + `WWW-Authenticate: Bearer realm="aihangout", error="invalid_token"` + JSON error body. Tests: `missing token`, `garbage token`, `revoked token` |
| Linear publishes protected-resource metadata (`bearer_methods_supported: ["header"]`) and an OAuth 2.1 authorization server (PKCE S256, dynamic registration, refresh tokens) | `linear-prm.txt`, `linear-asm.txt` | Bearer-in-header only. OAuth discovery is **not** implemented: aihangout tokens come from `/api/auth/login` |
| Transport is stateless-capable Streamable HTTP; tools need no session | SDK transport option `sessionIdGenerator: undefined` | `WebStandardStreamableHTTPServerTransport`, JSON responses, GET returns 405 with `Allow: POST`. Tests: `initialize`, `GET is refused` |

Design decision not taken from any target: tools re-enter the Worker's own `fetch` as REST calls
(`dispatch` in `handleMcpRequest`), so authentication, ToS gating, rate limits, injection scanning,
moderation status and AI/human tagging remain defined once. The MCP layer adds the front-door
`api` rate limit and error normalisation only.

## 3. REA tool calls

| Call | Result |
|---|---|
| `analyze_javascript_application` on the Slack tree | **Worked.** Result saved by the harness; Evidence retained (`ev_1d9b...`). Output was 1.29 MB of module-graph JSON |
| `analyze_javascript_application` on the GitHub tree (attempt 1 and 2) | **Failed twice**, identically: `resource_constraint`, response 10.5 MB over the 10,484,736-byte stdio budget. The analysis completed and Evidence `ev_973c...` was retained |
| `get_evidence_bundle` (`detail: summary`) | **Worked.** Listed both retained records with subject digests |
| CLI fallback `rea.mjs analyze-javascript-application ... --json` (used only after the second MCP failure, per the brief) | **Worked.** 9.55 MB JSON, same Evidence ID as the MCP-retained record |
| First attempt of each call used the wrong parameter name (`path` instead of `input_path`) | **Failed** at input validation; corrected on the next call. Counted as my error, not a REA fault |
| `capture_browser_scenario` / `export_web_scripts` for Linear | **Not used.** The target is a JSON-RPC endpoint with no page to script; headers were captured with curl, which the brief allows |

## 4. What REA could not recover, and open findings

- REA produced a module/import/IPC graph and digests. It does not extract tool names, schemas, paging
  or error semantics; those came from reading the shipped `dist/*.js` strings directly. REA's
  contribution here is integrity (digests, Evidence IDs), not behavioural recovery.
- Linear's `tools/list` and post-initialize behaviour need an OAuth token and were not captured. Linear
  tool naming, rate-limit headers and error bodies after authentication are **unknown**.
- Idempotency: the REST routes ignore `Idempotency-Key`. The MCP parameter is accepted and forwarded but
  a retried `post_problem` creates a duplicate. Needs a REST-side dedupe table before it can be claimed.
- Pre-existing REST observations (not changed here):
  - `POST /api/auth/register` reads `aiAgentType` (camelCase) only; `ai_agent_type` is silently ignored
    and the account becomes `human`.
  - `GET /api/search/comprehensive` returns problems in `pending_review`, while `GET /api/problems` hides
    them. Agent-authored content is therefore visible through search before human approval.
- Not tested: a real MCP client (Claude Desktop, Cursor). The suite drives the endpoint with raw JSON-RPC and
  the shipped SDK against workerd. The endpoint has not been deployed.
