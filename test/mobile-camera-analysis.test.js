import { env, SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { Router } from 'itty-router';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { installMobileCameraAnalysis, cameraProviderBody } from '../src/mobile-camera-analysis.js';
import { enrollmentProof } from './mobile-proof-helper.js';
import worker from '../src/worker.js';

// Real workerd + D1 migrations/SQL. Authentication is an explicit local test
// adapter; provider is either explicitly TEST-STUB or intercepted vi fetch.
// This does not prove production auth wiring, OpenAI service or device behavior.
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const router = Router();
installMobileCameraAnalysis(router, {
  authenticate: async request => { const id = Number(request.headers.get('x-test-owner')); return id ? { id } : null; },
  safeJsonParse: parse, sanitizeContent: s => s.replace(/<[^>]*>/g, ''),
  jsonResponse: (data, options) => new Response(JSON.stringify(data), { ...options, headers: { 'Content-Type': 'application/json' } }),
  checkRateLimit: async () => ({ limited: false }), rateLimitResponse: () => new Response('', { status: 429 }),
});
let seq = 0; let owner; let device; let cfg;
async function count() { return (await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) n FROM mobile_camera_analysis_requests WHERE provider_called_at IS NOT NULL').first()).n; }
async function dbrow(id) { return env.AIHANGOUT_DB.prepare('SELECT * FROM mobile_camera_analysis_requests WHERE request_id=? AND owner_user_id=?').bind(id, owner).first(); }
function body(id = `request-${++seq}`) { return { requestId: id, eventId: `event-id-${seq}`, deviceId: device, consent: true,
  event: { source: 'blink_notification', title: 'Activity', text: 'Private notification sentinel', observedAt: Date.now() } }; }
async function call(data, user = owner, method = 'POST') {
  const url = 'https://test.invalid/api/mobile/camera-analysis' + (method === 'GET' ? '/' + data : '');
  const r = await router.handle(new Request(url, { method, headers: user ? { 'x-test-owner': String(user) } : {},
    ...(method === 'POST' ? { body: typeof data === 'string' ? data : JSON.stringify(data) } : {}) }), cfg);
  return { status: r.status, json: await r.json(), headers: r.headers };
}
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network disabled by camera test'); }));
  await env.AIHANGOUT_DB.prepare('DELETE FROM mobile_camera_analysis_requests').run();
  const name = `camera_${Date.now()}_${++seq}`;
  owner = (await env.AIHANGOUT_DB.prepare('INSERT INTO users(username,email,password_hash) VALUES(?,?,?) RETURNING id').bind(name, `${name}@example.invalid`, 'test-only').first()).id;
  device = crypto.randomUUID();
  await env.AIHANGOUT_DB.prepare('INSERT INTO mobile_devices(device_id,owner_user_id,agent_name,device_public_key) VALUES(?,?,?,?)').bind(device, owner, name, 'TEST-ONLY-KEY').run();
  cfg = { ...env, MOBILE_CAMERA_ANALYSIS_ENABLED: '1', MOBILE_CAMERA_ANALYSIS_MAX_CALLS: '3', MOBILE_CAMERA_ANALYSIS_TEST_MODE: '1', ENVIRONMENT: 'test', MOBILE_FAULT_INJECT_ENABLED: '1' };
});

describe('private camera analysis contract, real D1', () => {
  it('integrated Worker uses real JWT and real enrollment owner binding', async () => {
    async function api(path, { method = 'GET', body: payload, token } = {}) {
      const response = await SELF.fetch('https://test.invalid' + path, { method,
        headers: { 'CF-Connecting-IP': '198.51.100.243', ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
        ...(payload ? { body: JSON.stringify(payload) } : {}) });
      return { status: response.status, json: await response.json() };
    }
    const name = `camera_integrated_${Date.now()}`;
    const registration = await api('/api/auth/register', { method: 'POST', body: { username: name, email: `${name}@example.invalid`, password: 'Synthetic camera test only! 3924', aiAgentType: 'human' } });
    expect(registration.status).toBe(200);
    const user = { id: registration.json.user.id, token: registration.json.token };
    const proof = await enrollmentProof(api, user, 'camera-integrated');
    const enrollment = await api('/api/mobile/devices/enroll', { method: 'POST', token: user.token, body: proof.body });
    expect(enrollment.status).toBe(200);
    const b = { ...body(), deviceId: enrollment.json.deviceId };
    expect((await api('/api/mobile/camera-analysis', { method: 'POST', body: b })).status).toBe(401);
    const accepted = await api('/api/mobile/camera-analysis', { method: 'POST', token: user.token, body: b });
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
    expect(accepted.json.status).toBe('analyzed');
    expect((await api('/api/mobile/camera-analysis/' + b.requestId, { token: user.token })).json).toEqual(accepted.json);
    expect((await api('/api/mobile/camera-analysis/' + b.requestId)).status).toBe(401);
    // Exercise the complete Worker wrapper and drain waitUntil explicitly;
    // SELF does not expose its context for an activity-log completion barrier.
    const privateBody = { ...b, requestId: 'private-image-0001', imageBase64: btoa(String.fromCharCode(255,216,255,224,0,2,255,217)), imageSha256: '' };
    const bytes = Uint8Array.from(atob(privateBody.imageBase64), c => c.charCodeAt(0));
    privateBody.imageSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2,'0')).join('');
    privateBody.event = { ...b.event, title: 'CAMERA-PRIVATE-SENTINEL', text: 'CAMERA-PRIVATE-BODY-NEVER-FEED', source: 'phone_camera' };
    const counts = async () => Promise.all(['problems', 'solutions', 'ai_learning_data', 'ai_intelligence'].map(async table => (await env.AIHANGOUT_DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n));
    const before = await counts();
    for (const [payload, expected] of [[privateBody, 200], [{ ...privateBody, requestId: 'private-refuse-0001', consent: false }, 400]]) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request('https://test.invalid/api/mobile/camera-analysis', { method: 'POST',
        headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.242' }, body: JSON.stringify(payload) }), env, ctx);
      expect(response.status).toBe(expected); await response.text(); await waitOnExecutionContext(ctx);
    }
    const logged = await env.AIHANGOUT_DB.prepare("SELECT COUNT(*) n FROM activity_log WHERE path LIKE '/api/mobile/camera-analysis%'").first();
    expect(logged.n).toBe(0); expect(await counts()).toEqual(before);
  });
  it('retains constant proposal/usage and GET; does not store raw observation', async () => {
    const b = body(); const r = await call(b);
    expect(r.status).toBe(200); expect(r.json).toMatchObject({ success: true, requestId: b.requestId, eventId: b.eventId, status: 'analyzed', proposal: { operation: 'show_local_checkin', text: 'Please check the camera view.' } });
    expect(r.json.summary).toContain('Notification report only (no image inspected)');
    expect(r.json.usage.testOnly).toBe(true); expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    const row = await dbrow(b.requestId); expect(JSON.stringify(row)).not.toContain(b.event.text); expect(row.request_digest).toMatch(/^[a-f0-9]{64}$/);
    expect((await call(b.requestId, owner, 'GET')).json).toEqual(r.json);
    expect(await count()).toBe(1);
  });
  it('deduplicates same request and rejects any different accepted event content', async () => {
    const b = body(); await call(b);
    expect((await call(b)).json.deduplicated).toBe(true);
    for (const mutation of [{ ...b, eventId: 'different-event' }, { ...b, event: { ...b.event, text: 'changed' } }, { ...b, event: { ...b.event, observedAt: b.event.observedAt + 1 } }]) expect((await call(mutation)).status).toBe(409);
    expect(await count()).toBe(1);
  });
  it('concurrent duplicates reserve only once', async () => {
    const b = body(); const results = await Promise.all([call(b), call(b), call(b)]);
    expect(results.every(r => [200, 409].includes(r.status))).toBe(true); expect(await count()).toBe(1);
  });
  it('atomic global cap admits exactly one of four distinct requests with one slot', async () => {
    cfg.MOBILE_CAMERA_ANALYSIS_MAX_CALLS = '1';
    const results = await Promise.all([call(body()), call(body()), call(body()), call(body())]);
    expect(results.map(r => r.status).sort()).toEqual([200, 429, 429, 429]); expect(await count()).toBe(1);
  });
  it('unknown provider outcome has no replay on POST or GET', async () => {
    const b = body('test-timeout-01'); expect((await call(b)).json.status).toBe('unknown');
    expect((await call(b)).status).toBe(409); expect((await call(b.requestId, owner, 'GET')).json).toMatchObject({ success: false, status: 'unknown', usage: null });
    expect(await count()).toBe(1);
  });
  it('rejects coerced provider Boolean and supports no-action', async () => {
    expect((await call(body('test-invalid-01'))).json.status).toBe('failed');
    expect((await call(body('test-noaction-01'))).json.proposal).toBeNull();
  });
  it('enforces owner authentication and current active binding on both routes', async () => {
    const b = body(); expect((await call(b, null)).status).toBe(401); expect((await call(b, owner + 9000)).status).toBe(404);
    await call(b); expect((await call(b.requestId, owner + 9000, 'GET')).status).toBe(404);
    await env.AIHANGOUT_DB.prepare("UPDATE mobile_devices SET status='revoked' WHERE device_id=?").bind(device).run();
    expect((await call(b)).status).toBe(404); expect((await call(b.requestId, owner, 'GET')).status).toBe(404); expect(await count()).toBe(1);
  });
  it.each([false, 'true', 1, null])('refuses nonliteral consent %s before persistence', async value => {
    expect((await call({ ...body(), consent: value })).status).toBe(400); expect(await count()).toBe(0);
  });
  it('refuses malformed, extra fields, stale/future/empty observation, invalid source and missing image', async () => {
    const b = body();
    const cases = ['{broken', { ...b, command: 'execute' }, { ...b, event: { ...b.event, observedAt: Date.now() - 600001 } },
      { ...b, event: { ...b.event, observedAt: Date.now() + 60000 } }, { ...b, event: { ...b.event, title: '', text: '' } },
      { ...b, event: { ...b.event, source: 'unknown' } }, { ...b, event: { ...b.event, source: 'phone_camera' } },
      { ...b, event: { ...b.event, source: 'shared_image' } }, { ...b, event: { ...b.event, text: 'x'.repeat(2001) } }];
    for (const bad of cases) expect((await call(bad)).status).toBe(400);
    expect((await call('x'.repeat(710001))).status).toBe(413); expect(await count()).toBe(0);
  });
  it('disabled/config invalid cannot enter provider; test stub cannot escape test environment', async () => {
    cfg.MOBILE_CAMERA_ANALYSIS_ENABLED = '0'; expect((await call(body())).json.status).toBe('disabled');
    cfg.MOBILE_CAMERA_ANALYSIS_ENABLED = '1'; cfg.MOBILE_CAMERA_ANALYSIS_MAX_CALLS = 'oops'; expect((await call(body())).json.status).toBe('not_configured');
    cfg.MOBILE_CAMERA_ANALYSIS_MAX_CALLS = '3'; cfg.ENVIRONMENT = 'production'; expect((await call(body())).json.status).toBe('not_configured');
    expect(await count()).toBe(0);
  });
  it('binds JPEG bytes to digest and omits image bytes from stored ledger', async () => {
    // JPEG marker envelope fixture only; decoding quality is a provider/device gate.
    const binary = String.fromCharCode(255, 216, 255, 224, 0, 2, 255, 217);
    const imageBase64 = btoa(binary);
    const imageSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(binary, c => c.charCodeAt(0))))].map(b => b.toString(16).padStart(2, '0')).join('');
    const b = { ...body(), imageBase64, imageSha256 }; b.event.source = 'phone_camera';
    expect((await call({ ...b, imageSha256: 'a'.repeat(64) })).status).toBe(400);
    expect((await call({ ...b, imageBase64: 'not_base64' })).status).toBe(400);
    expect((await call(b)).status).toBe(200); expect(JSON.stringify(await dbrow(b.requestId))).not.toContain(imageBase64);
    const providerBody = cameraProviderBody({ model: 'test-model' }, b, s => s);
    expect(providerBody).toMatchObject({ store: false, max_output_tokens: 300 });
    expect(providerBody.input[0].content[1]).toMatchObject({ type: 'input_image', image_url: `data:image/jpeg;base64,${imageBase64}` });
    expect(providerBody.tools).toBeUndefined();
  });
  it('real fetch path sends store:false and validates Responses output without retaining raw provider text', async () => {
    cfg.MOBILE_CAMERA_ANALYSIS_TEST_MODE = '0'; cfg.OPENAI_API_KEY = 'TEST-ONLY-NOT-A-REAL-KEY-0000'; cfg.OPENAI_MODEL = 'gpt-5.6-sol';
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      expect(url).toBe('https://api.openai.com/v1/responses');
      calls++; const sent = JSON.parse(options.body); expect(sent.store).toBe(false); expect(sent.max_output_tokens).toBe(300);
      return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"summary":"Activity was reported.","checkinNeeded":true}' }] }], usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 }, raw_private_field: 'never-persist-this' }), { status: 200 });
    }));
    const b = body(); expect((await call(b)).status).toBe(200); await call(b); await call(b.requestId, owner, 'GET');
    expect(calls).toBe(1); expect(JSON.stringify(await dbrow(b.requestId))).not.toContain('never-persist-this');
  });
});
