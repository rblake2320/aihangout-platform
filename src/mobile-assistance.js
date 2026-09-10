// Mobile companion "Ask AI for help" -- backend lane of the frontier phone
// wiring contract (Team/tasks/A1-frontier-phone-wiring-contract-20260910.md).
//
// POST /api/mobile/assistance: the OWNER (human JWT) submits a narrow, named
// diagnostic snapshot from an enrolled active device; the server asks the
// OpenAI Responses API for a diagnosis and a decision constrained to exactly
// two values (enable_companion_diagnostics | no_action) and compiles the ONLY
// allowed proposal literally on the server. The model never supplies a
// device, command, url, capability or target text. Assistance only proposes;
// execution still goes through /api/mobile/actions/intent and the existing
// digest-bound web approval.
//
// Setup refusals (status disabled / not_configured) and provider failure /
// unknown / unusable answers all use 424 (Failed Dependency), never
// 5xx: the Worker's outer handler rewrites any /api/* 5xx into a generic 503 with
// Retry-After, which would both hide requestId/status and invite the blind retry
// the contract forbids.
//
// Hard gates (all server side): MOBILE_ASSISTANCE_ENABLED === '1' (explicit
// deployment enable), OPENAI_API_KEY + OPENAI_MODEL present (no fake answers
// when credentials are absent), a finite per-deployment call cap, request
// identity persisted BEFORE the provider call, duplicate requestId returns the
// stored outcome, unknown provider outcomes are recorded and never retried
// automatically.

const OPERATION = 'enable_companion_diagnostics';
const PROPOSAL = Object.freeze({
  operation: OPERATION,
  capability: 'ui_click',
  targetDescription: 'Enable AIHangout companion diagnostics',
});
const MAX_BODY_BYTES = 2048;
const DEFAULT_CALL_CAP = 5;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// Atomic call-slot reservation (binds: owner_user_id, request_id, cap). The
// count and the write happen inside ONE statement, so concurrent requests
// cannot all observe "below cap" and then all reserve (A1 review of b22e906).
// Exported so the regression test exercises the exact statement the route runs.
export const RESERVE_CALL_SLOT_SQL = `UPDATE mobile_assistance_requests SET provider_called_at = CURRENT_TIMESTAMP
  WHERE owner_user_id = ? AND request_id = ? AND provider_called_at IS NULL
    AND (SELECT COUNT(*) FROM mobile_assistance_requests WHERE provider_called_at IS NOT NULL) < ?`;
const APP_VERSION_RE = /^[A-Za-z0-9._+-]{1,40}$/;

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: [OPERATION, 'no_action'] },
    diagnosis: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['decision', 'diagnosis', 'reason'],
};

function validateDiagnostics(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'diagnostics must be an object';
  const keys = Object.keys(d).sort();
  if (keys.join(',') !== 'appVersion,diagnosticsEnabled,schemaVersion') return 'diagnostics must contain exactly schemaVersion, diagnosticsEnabled, appVersion';
  if (d.schemaVersion !== 1) return 'diagnostics.schemaVersion must be 1';
  if (d.diagnosticsEnabled !== false) return 'diagnostics.diagnosticsEnabled must be the boolean false for this workflow';
  if (typeof d.appVersion !== 'string' || !APP_VERSION_RE.test(d.appVersion)) return 'diagnostics.appVersion invalid';
  return null;
}

function providerConfig(env) {
  return {
    enabled: env.MOBILE_ASSISTANCE_ENABLED === '1',
    apiKey: typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.length >= 20 ? env.OPENAI_API_KEY : null,
    model: typeof env.OPENAI_MODEL === 'string' && /^[A-Za-z0-9._-]{3,64}$/.test(env.OPENAI_MODEL) ? env.OPENAI_MODEL : null,
    baseUrl: typeof env.OPENAI_BASE_URL === 'string' && env.OPENAI_BASE_URL ? env.OPENAI_BASE_URL.replace(/\/$/, '') : 'https://api.openai.com',
    cap: Number.isInteger(Number(env.MOBILE_ASSISTANCE_MAX_CALLS)) && Number(env.MOBILE_ASSISTANCE_MAX_CALLS) > 0 ? Number(env.MOBILE_ASSISTANCE_MAX_CALLS) : DEFAULT_CALL_CAP,
    // Test-only in-process stub. Never set in any wrangler.toml environment; it is
    // only honoured when the test fault-injection flag is also on.
    stub: env.MOBILE_FAULT_INJECT_ENABLED === '1' && typeof env.OPENAI_BASE_URL === 'string' && env.OPENAI_BASE_URL.startsWith('stub://'),
  };
}

// Deterministic stand-in for the Responses API, selected by requestId prefix so
// tests can drive every outcome without the network or a key.
function stubProvider(requestId) {
  if (requestId.startsWith('stub-noaction')) return { ok: true, status: 200, json: { id: 'resp_stub', model: 'stub-model', output_text: JSON.stringify({ decision: 'no_action', diagnosis: 'Diagnostics already look fine.', reason: 'nothing to change' }), usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } };
  if (requestId.startsWith('stub-badjson')) return { ok: true, status: 200, json: { id: 'resp_stub', model: 'stub-model', output_text: '{"decision":"reboot_device","diagnosis":"x","reason":"y"}', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
  if (requestId.startsWith('stub-http500')) return { ok: false, status: 500, json: { error: { message: 'stub upstream failure' } } };
  // Hostile provider shapes (A1 review of b22e906): must classify, never throw.
  if (requestId.startsWith('stub-hostile-output')) return { ok: true, status: 200, json: { model: 'stub-model', output: 'not-an-array', usage: null } };
  if (requestId.startsWith('stub-hostile-content')) return { ok: true, status: 200, json: { model: 'stub-model', output: [null, 7, 'str', { content: 'str' }, { content: 5 }, { content: [null, 3, { type: 'output_text', text: 42 }, { get type() { throw new Error('hostile getter'); } }] }] } };
  if (requestId.startsWith('stub-hostile-root')) return { ok: true, status: 200, json: ['not', 'an', 'object'] };
  if (requestId.startsWith('stub-hostile-huge')) return { ok: true, status: 200, json: { model: 'stub-model', output_text: '{"decision":"no_action","diagnosis":"' + 'x'.repeat(5000) + '","reason":""}' } };
  if (requestId.startsWith('stub-hostile-array')) return { ok: true, status: 200, json: { model: 'stub-model', output_text: '["enable_companion_diagnostics"]' } };
  if (requestId.startsWith('stub-timeout')) return { ok: false, status: 0, json: null, transport: 'timeout' };
  return { ok: true, status: 200, json: { id: 'resp_stub', model: 'stub-model', output_text: JSON.stringify({ decision: OPERATION, diagnosis: 'Companion diagnostics are disabled, which blocks the battery check.', reason: 'preference off' }), usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } } };
}

async function callProvider(cfg, requestId, diagnostics) {
  if (cfg.stub) return stubProvider(requestId);
  const body = {
    model: cfg.model,
    input: [
      { role: 'system', content: 'You diagnose one narrow condition for the AIHangout mobile companion app. The only permitted repair is enabling the companion app\'s own diagnostics preference. You must not propose touching system settings, other apps, coordinates, or anything else. Output JSON only.' },
      { role: 'user', content: `Diagnostics snapshot: ${JSON.stringify(diagnostics)}. If diagnosticsEnabled is false, decide whether enabling companion diagnostics is the right repair.` },
    ],
    text: { format: { type: 'json_schema', name: 'companion_assistance', strict: true, schema: RESPONSE_SCHEMA } },
    max_output_tokens: 300,
    // This bounded preference diagnosis needs no hidden reasoning budget.
    ...(cfg.model === 'gpt-5.6-sol' ? { reasoning: { effort: 'none' } } : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let json = null; try { json = await res.json(); } catch { json = null; }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: null, transport: err?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// Extract the structured text from a Responses API payload without trusting
// anything beyond the two allowed decisions.
// Containment: a hostile or malformed provider object must classify as a
// retained 'failed' outcome (null here) -- never throw into the generic 500,
// which the outer /api handler would rewrite to a 503 without requestId/status.
function parseDecision(json) {
  try {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
    let text = typeof json.output_text === 'string' ? json.output_text : null;
    if (text === null && Array.isArray(json.output)) {
      outer: for (const item of json.output) {
        if (!item || typeof item !== 'object' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (part && typeof part === 'object' && part.type === 'output_text' && typeof part.text === 'string') { text = part.text; break outer; }
        }
      }
    }
    if (typeof text !== 'string' || text.length > 4000) return null;
    let parsed; try { parsed = JSON.parse(text); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.decision !== OPERATION && parsed.decision !== 'no_action') return null;
    if (typeof parsed.diagnosis !== 'string' || !parsed.diagnosis.trim()) return null;
    return { decision: parsed.decision, diagnosis: parsed.diagnosis.slice(0, 1000), reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 500) : '' };
  } catch {
    return null; // e.g. a throwing getter on a hostile object
  }
}

function storedResponse(row) {
  const proposal = row.proposal_json ? JSON.parse(row.proposal_json) : null;
  return { success: true, requestId: row.request_id, status: row.status, diagnosis: row.diagnosis, provider: row.provider, model: row.model, proposal, usage: row.usage_json ? JSON.parse(row.usage_json) : null, deduplicated: true };
}

export function installMobileAssistance(router, { authenticate, safeJsonParse, sanitizeContent, jsonResponse, checkRateLimit, rateLimitResponse }) {
  const failure = (error, status = 400, extra = {}) => jsonResponse({ success: false, error, ...extra }, { status });

  router.post('/api/mobile/assistance', async (request, env) => {
    try {
      const user = await authenticate(request, env);
      if (!user) return failure('Authentication required', 401);
      const rl = await checkRateLimit(env.AIHANGOUT_KV, request.headers.get('CF-Connecting-IP') || 'unknown', user.id, 'mobile_assistance');
      if (rl.limited) return rateLimitResponse(rl);

      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return failure('Request body too large', 413);
      const body = safeJsonParse(raw);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return failure('JSON object body required');
      const keys = Object.keys(body).sort();
      if (keys.join(',') !== 'deviceId,diagnostics,requestId') return failure('Body must contain exactly deviceId, requestId, diagnostics');
      const deviceId = String(body.deviceId || '');
      const requestId = String(body.requestId || '');
      if (!/^[0-9a-f-]{36}$/.test(deviceId)) return failure('deviceId invalid');
      if (!REQUEST_ID_RE.test(requestId)) return failure('requestId must be 8-64 chars of A-Z a-z 0-9 _ -');
      const diagError = validateDiagnostics(body.diagnostics);
      if (diagError) return failure(diagError);
      const diagnostics = { schemaVersion: 1, diagnosticsEnabled: false, appVersion: sanitizeContent(body.diagnostics.appVersion) };

      // Ownership is in the SQL, not a JS comparison afterwards.
      const device = await env.AIHANGOUT_DB.prepare(
        "SELECT device_id FROM mobile_devices WHERE device_id = ? AND owner_user_id = ? AND status = 'active'"
      ).bind(deviceId, user.id).first();
      if (!device) return failure('No active device found under your account with that id', 404);

      // Dedup / no blind retry: the stored outcome wins.
      const existing = await env.AIHANGOUT_DB.prepare(
        'SELECT * FROM mobile_assistance_requests WHERE owner_user_id = ? AND request_id = ?'
      ).bind(user.id, requestId).first();
      if (existing) {
        if (existing.device_id !== deviceId) return failure('requestId already used for a different device', 409);
        if (existing.status === 'completed') return jsonResponse(storedResponse(existing));
        // 'failed' is definitive, so a NEW requestId may ask again. 'pending' and
        // 'unknown' are not known to be absent -- no replay guidance for them.
        const guidance = existing.status === 'failed' ? '; a new requestId may be used to ask again' : '; outcome retained, do not replay';
        return failure(`Assistance request is '${existing.status}'${guidance}`, 409, { requestId, status: existing.status, error_detail: existing.error || null });
      }

      const cfg = providerConfig(env);
      // Setup gates are explicit non-5xx refusals: the outer /api handler rewrites
      // any 5xx into a generic "temporarily unavailable" 503, which an installed
      // phone would show as a backend outage instead of "setup required".
      // Nothing is persisted and no provider is called for either refusal.
      if (!cfg.enabled) return failure('Mobile assistance is disabled on this deployment', 424, { requestId, status: 'disabled' });
      if (!cfg.stub && (!cfg.apiKey || !cfg.model)) return failure('Assistance provider is not configured on this deployment', 424, { requestId, status: 'not_configured' });

      // Persist identity BEFORE the provider call. PRIMARY KEY makes a concurrent
      // duplicate lose here instead of double-calling the provider.
      try {
        await env.AIHANGOUT_DB.prepare(
          "INSERT INTO mobile_assistance_requests (request_id, owner_user_id, device_id, status, diagnostics_json, provider, model) VALUES (?, ?, ?, 'pending', ?, 'openai', ?)"
        ).bind(requestId, user.id, deviceId, JSON.stringify(diagnostics), cfg.stub ? 'stub-model' : cfg.model).run();
      } catch (dbErr) {
        if (String(dbErr.message || '').includes('UNIQUE constraint failed')) return failure('Assistance request already in progress', 409, { requestId, status: 'pending' });
        throw dbErr;
      }

      // Finite per-deployment cap: ONE conditional UPDATE reserves the call slot.
      // SQLite executes the statement atomically (count and write in the same
      // step), so N distinct requests racing at the boundary cannot all read
      // "below cap" and then all reserve. meta.changes === 0 => cap held, no call.
      const reserved = await env.AIHANGOUT_DB.prepare(RESERVE_CALL_SLOT_SQL).bind(user.id, requestId, cfg.cap).run();
      if (!reserved?.meta || reserved.meta.changes !== 1) {
        await env.AIHANGOUT_DB.prepare("UPDATE mobile_assistance_requests SET status = 'failed', error = 'call cap reached', completed_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND request_id = ? AND provider_called_at IS NULL").bind(user.id, requestId).run();
        return failure(`Assistance call cap reached (${cfg.cap}); no provider call made`, 429, { requestId, status: 'failed' });
      }

      const result = await callProvider(cfg, requestId, diagnostics);
      const usageJson = result.json?.usage ? JSON.stringify(result.json.usage) : null; // null = unknown, never 0

      if (!result.ok) {
        // Transport ambiguity (timeout/network) = UNKNOWN outcome: recorded, never retried here.
        const status = result.transport ? 'unknown' : 'failed';
        const code = result.json?.error?.code;
        const safeCode = typeof code === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(code) ? ` (${code})` : '';
        const error = result.transport ? `provider ${result.transport}` : `provider HTTP ${result.status}${safeCode}`;
        await env.AIHANGOUT_DB.prepare('UPDATE mobile_assistance_requests SET status = ?, error = ?, usage_json = ?, completed_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND request_id = ?').bind(status, error, usageJson, user.id, requestId).run();
        return failure(status === 'unknown' ? 'Assistance outcome unknown; not retried automatically' : 'Assistance provider failed', 424, { requestId, status });
      }

      const decision = parseDecision(result.json);
      if (!decision) {
        await env.AIHANGOUT_DB.prepare("UPDATE mobile_assistance_requests SET status = 'failed', error = 'provider output rejected by schema', usage_json = ?, completed_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND request_id = ?").bind(usageJson, user.id, requestId).run();
        return failure('Assistance provider returned an unusable answer', 424, { requestId, status: 'failed' });
      }

      const model = typeof result.json?.model === 'string' ? result.json.model.slice(0, 64) : (cfg.stub ? 'stub-model' : cfg.model);
      const diagnosis = sanitizeContent(decision.diagnosis);
      const proposal = decision.decision === OPERATION ? { ...PROPOSAL } : null; // compiled literally, never from the model
      await env.AIHANGOUT_DB.prepare("UPDATE mobile_assistance_requests SET status = 'completed', model = ?, diagnosis = ?, proposal_json = ?, usage_json = ?, completed_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND request_id = ?")
        .bind(model, diagnosis, proposal ? JSON.stringify(proposal) : null, usageJson, user.id, requestId).run();

      return jsonResponse({ success: true, requestId, diagnosis, provider: 'openai', model, proposal, usage: usageJson ? JSON.parse(usageJson) : null, ...(proposal ? {} : { noAction: true, reason: sanitizeContent(decision.reason) }) });
    } catch (error) {
      console.error('[MobileAssistance]', error?.message || error);
      return jsonResponse({ success: false, error: 'Assistance request failed' }, { status: 500 });
    }
  });

  router.get('/api/mobile/assistance/:requestId', async (request, env) => {
    try {
      const user = await authenticate(request, env);
      if (!user) return failure('Authentication required', 401);
      const { requestId } = request.params;
      if (!REQUEST_ID_RE.test(requestId)) return failure('requestId invalid');
      const row = await env.AIHANGOUT_DB.prepare('SELECT * FROM mobile_assistance_requests WHERE owner_user_id = ? AND request_id = ?').bind(user.id, requestId).first();
      if (!row) return failure('No assistance request found under your account with that id', 404);
      return jsonResponse({ ...storedResponse(row), deduplicated: undefined, error: row.error || null });
    } catch (error) {
      console.error('[MobileAssistance] readback', error?.message || error);
      return jsonResponse({ success: false, error: 'Assistance readback failed' }, { status: 500 });
    }
  });
}
