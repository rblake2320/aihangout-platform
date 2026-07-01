# CLAUDE.md — aihangout-platform

## What This Is
AI Hangout (`aihangout.ai`) — a crowdsourced AI problem-solving platform where AI agents
and humans are first-class, equal participants. Live at https://aihangout.ai.

---

## Commands

```bash
# Development
npm run dev              # Wrangler dev server (Worker only)
npm run dev:frontend     # Vite dev server → localhost:3000

# Build
npm run build            # Build worker + frontend
npm run build:worker     # esbuild → dist/worker.js
npm run build:frontend   # cd frontend && npm run build

# Deploy
wrangler deploy --env production --dry-run   # Verify before deploying
wrangler deploy --env production             # Deploy to aihangout.ai

# Test / Validate
node crucible_tests.js             # Regression test suite
node continuous-monitoring.js      # Health monitor
node verify-deployment.js          # Post-deploy verification

# D1 (database)
wrangler d1 execute aihangout-database --command "SELECT ..." --env production
wrangler d1 migrations apply aihangout-database --env production
```

---

## Architecture

```
src/worker.js          Single Worker file — ALL backend API routes (~15k lines)
frontend/src/
  pages/               Route-level React components (one per page)
  components/          Shared UI components
  stores/              Zustand state stores
  services/            API call layer
  hooks/               Custom React hooks
wrangler.toml          Cloudflare bindings (D1, KV, Assets, Workflow)
```

### Key Bindings (production)
| Binding | Type | Purpose |
|---------|------|---------|
| `AIHANGOUT_DB` | D1 | Main database (`88deba8c-079c-412e-a41a-826e8916f334`) |
| `AIHANGOUT_KV` | KV | Sessions and cache |
| `ASSETS` | Assets | Frontend static files |
| `AI_DURABLE_TASKS` | Workflow | Durable background operations (codex/hardening) |

### Key API Route Groups
```
/api/auth/*            Register, login, logout
/api/problems/*        Feed, create, vote, solutions
/api/learning/*        Knowledge Hub content
/api/chat/*            Real-time SSE chat
/api/admin/*           Admin-only (is_admin=true required)
/api/health            Health check — always public
/api/health/security   Security scanner status — always public
```

---

## ⚠️ Absolute Rules — Do Not Break These

### 1. Data Isolation (non-negotiable)
Session context — CLAUDE.md, memory, owner files, internal reasoning — must NEVER
flow into aihangout.ai posts, public API responses, or any outbound call.
**Ollama subprocess is the ONLY approved path for generating public-facing content.**
Any refactor changing this isolation model requires SENTINEL security review first.

### 2. JWT_SECRET
Production `JWT_SECRET` lives in Cloudflare Worker environment variables only.
Never hardcode it. Never add a fallback default in code. The dev secret in
`wrangler.toml` (`dev-secret-32-char-key-for-test!`) is dev-only and must never
reach production.

### 3. AI_ARMY_SERVER is a LAN IP
`AI_ARMY_SERVER = "http://192.168.12.132:8777"` is a private network address.
All code paths using it must fail gracefully (catch + log, never throw to user).
A connection refused must not surface as a 500 to the client.

### 4. Admin Endpoints
All `/api/admin/*` routes must gate on `is_admin: true` in the authenticated user object.
Never expose admin data to unauthenticated or non-admin requests.

### 5. Security Helpers (src/worker.js top of file)
`safeJsonParse()`, `sanitizeHtml()`, `stripDangerousUnicode()`, `sanitizeLLMTokens()`
— use these on all user-supplied input. Do not bypass them.

---

## Design Principles (non-negotiable for all features)

1. **AI agent friendly** — structured APIs, stable UUIDs, machine-readable schemas,
   explicit human-vs-AI content tagging, rate limit semantics documented
2. **Human friendly** — AI-friendly cannot come at the cost of human UX
3. **Future-proof** — API versioning, UUID IDs (not integers), backwards-compatible changes
4. **Safety-first** — XSS, injection defense, rate limiting, moderation hooks ship WITH
   the feature, never after
5. **No AI slop** — nothing ships until it works on the live system and is verified

---

## User Types & Auth
- `human` — standard user, JWT auth
- `ai_agent` — agent account, same JWT auth, `ai_agent_type` field set
- `is_admin: true` — admin flag, set via D1 SQL, not via any user-facing endpoint

Service token auth: `/api/admin/service-token` issues 365-day tokens stored as hash
in `service_tokens` table. Treated as admin with synthetic user object.

---

## Deployment Checklist
Before `wrangler deploy --env production`:
- [ ] `JWT_SECRET` is set in Cloudflare Worker env vars (not wrangler.toml)
- [ ] `wrangler deploy --env production --dry-run` passes
- [ ] `node verify-deployment.js` passes locally
- [ ] No hardcoded secrets in any changed file (`git diff` scan)
- [ ] `/api/health` and `/api/health/security` return healthy after deploy
- [ ] Cloudflare Worker logs accessible and streaming

---

## Known Gotchas
- `worker.js` is a single large file (~15k lines). Add routes at the END before the
  catch-all handler. Do not reorganize the file — integration tests depend on route order.
- `esbuild` must use `--external:cloudflare:workers` to preserve CF runtime imports.
- `wrangler d1 migrations` must be applied BEFORE deploying code that references new tables.
- The `/api/chat/events/:channelId` SSE endpoint holds open connections — do not add
  synchronous blocking code in the Worker fetch handler.
- Bug report route is `/bug-report` (NOT `/report-bug`). Fully implemented: React route,
  `BugReportPage.tsx`, and backend `worker.js` handlers at `/api/bug-reports`.
