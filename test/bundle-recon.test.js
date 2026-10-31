import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import {
  extractFromText, assetRefsFromHtml, chunkRefsFromJs, isRealSourceMap, diffRecon,
} from '../scripts/lib/bundle-extract.mjs';

// Fixture shaped like the shipped Vite bundle: axios client with baseURL /api,
// a client-side is_admin guard, admin calls, a persisted auth store, hashed chunks.
const FIXTURE = `
import{a as r}from"./state-tNdC39m3.js";
const Gt=axios.create({baseURL:"/api"});
fetch("/api/analytics/batch",{method:"POST"});fetch(\`/api/learning/\${e}\`);
Gt.get("/admin/ops-summary?hours=24");Gt.get("/admin/reports?status=pending");
Gt.patch(\`/bug-reports/\${e}/status\`);Gt.post("/auth/login",{});
const routes=[{path:"/admin",element:1},{path:"/problems/:id",element:2}];
t?.is_admin&&link("/admin");
persist({name:"ai-hangout-auth"});sessionStorage.getItem("guestSessionId");
a.href="https://electionclock.com/live-avatar";a.ws="wss://aihangout.ai/x";
x="https://www.w3.org/2000/svg";mail="privacy@aihangout.ai";
class Q{get(){return this.internal}}
`;

// Secret-shaped strings are assembled at runtime so no secret scanner trips on this file.
const fakeJwt = ['eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.abcdefghijklmnop'].join('');
const fakeAws = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const fakeIp = ['10', '1', '2', '3'].join('.');

describe('bundle recon extractor', () => {
  it('inventories routes, admin routes, hosts, storage keys and guards from a fixture bundle', () => {
    const inv = extractFromText(FIXTURE);
    expect(inv.apiRoutes).toEqual(['/api/analytics/batch', '/api/learning/{}']);
    expect(inv.clientCalls).toContain('GET /admin/ops-summary');
    expect(inv.clientCalls).toContain('PATCH /bug-reports/{}/status');
    expect(inv.baseUrls).toEqual(['/api']);
    expect(inv.adminRoutes).toEqual(['/admin', '/api/admin/ops-summary', '/api/admin/reports']);
    expect(inv.pageRoutes).toEqual(['/admin', '/problems/:id']);
    expect(inv.storageKeys).toEqual(['ai-hangout-auth', 'guestSessionId']);
    expect(inv.externalHosts).toEqual(['https://electionclock.com', 'wss://aihangout.ai']);
    expect(inv.emails).toEqual(['privacy@aihangout.ai']);
    expect(inv.adminGuards).toHaveLength(1);
    expect(inv.suspicious).toEqual([]); // `this.internal` is property access, not a host
  });

  it('flags planted secret-shaped literals and never stores the raw value', () => {
    const text = `const k="${fakeAws}";const j="${fakeJwt}";const h="http://${fakeIp}:8080";`
      + `const cfg={apiKey:"${'q'.repeat(24)}"};const d="svc.corp.internal";const q="//db.lan";`;
    const kinds = extractFromText(text).suspicious.map((s) => s.kind).sort();
    expect(kinds).toEqual(['aws-access-key', 'credential-assignment', 'internal-hostname', 'internal-hostname', 'jwt', 'private-ipv4']);
    const dump = JSON.stringify(extractFromText(text));
    expect(extractFromText(text).externalHosts).toEqual([expect.stringMatching(/^http:\/\/private-host:[0-9a-f]{12}$/)]);
    for (const raw of [fakeAws, fakeJwt, fakeIp, 'q'.repeat(24)]) expect(dump).not.toContain(raw);
  });

  it('is deterministic regardless of occurrence order', () => {
    const a = extractFromText(FIXTURE);
    const b = extractFromText(FIXTURE.split('\n').reverse().join('\n'));
    expect(b.apiRoutes).toEqual(a.apiRoutes);
    expect(b.adminRoutes).toEqual(a.adminRoutes);
  });

  it('extracts asset and chunk references without matching name suffixes', () => {
    const html = '<script type="module" crossorigin src="/assets/index-CDxjmwRw.js"></script><link href="/assets/index-Bv9XazIt.css">';
    expect(assetRefsFromHtml(html)).toEqual(['/assets/index-Bv9XazIt.css', '/assets/index-CDxjmwRw.js']);
    expect(chunkRefsFromJs('import"./rolldown-runtime-NMqb_1LM.js";')).toEqual(['/assets/rolldown-runtime-NMqb_1LM.js']);
  });

  it('does not mistake an SPA HTML fallback for an exposed source map', () => {
    expect(isRealSourceMap('text/html; charset=utf-8', '<!doctype html><html>')).toBe(false);
    expect(isRealSourceMap('application/json', '{"version":3,"mappings":"AAAA"}')).toBe(true);
    expect(isRealSourceMap('application/json', 'not json')).toBe(false);
  });
});

describe('bundle recon diff', () => {
  const snap = (over = {}) => ({
    assets: [{ path: '/assets/a.js', sourceMapExposed: false }],
    inventory: { apiRoutes: ['/api/x'], adminRoutes: ['/admin'], externalHosts: [], suspicious: [], ...over },
  });

  it('passes when nothing dangerous changed', () => {
    const d = diffRecon(snap(), snap({ apiRoutes: ['/api/x', '/api/y'] }));
    expect(d.added.apiRoutes).toEqual(['/api/y']);
    expect(d.fail).toBe(false);
  });

  it('fails on a new suspicious literal', () => {
    const d = diffRecon(snap(), snap({ suspicious: [{ id: 'jwt:abc', kind: 'jwt' }] }));
    expect(d.newSuspicious).toHaveLength(1);
    expect(d.fail).toBe(true);
  });

  it('fails on a new admin route', () => {
    const d = diffRecon(snap(), snap({ adminRoutes: ['/admin', '/api/admin/users'] }));
    expect(d.newAdminRoutes).toEqual(['/api/admin/users']);
    expect(d.fail).toBe(true);
  });

  it('fails on a newly exposed source map and ignores a removed finding', () => {
    const next = snap();
    next.assets[0].sourceMapExposed = true;
    expect(diffRecon(snap(), next).newSourceMaps).toEqual(['/assets/a.js']);
    expect(diffRecon(snap({ suspicious: [{ id: 'jwt:abc' }] }), snap()).fail).toBe(false);
  });
});

// Server-enforcement contract for every route the bundle recon found behind a
// client-only guard (UI hides it for non-admins; the server must refuse it).
describe('server enforces what the UI hides', () => {
  const base = 'https://aihangout.ai';
  const hdr = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.90' };
  const adminOnly = [
    ['GET', '/api/admin/ops-summary?hours=24'],
    ['GET', '/api/admin/reports?status=pending&limit=50'],
    ['GET', '/api/admin/flagged-content'],
    ['GET', '/api/bug-reports'],
    ['GET', '/api/bug-reports/1'],
    ['PATCH', '/api/bug-reports/1/status'],
  ];
  const authOnly = [
    ['GET', '/api/notifications'],
    ['GET', '/api/users/me/settings'],
    ['GET', '/api/bookmarks'],
    ['GET', '/api/pathbooks/signing-context'],
    ['POST', '/api/pathbooks/FRP-PORT001/execute'],
    ['POST', '/api/pathbooks/FRP-PORT001/verify'],
  ];
  const call = (method, path, token) => SELF.fetch(base + path, {
    method,
    headers: { ...hdr, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify({ status: 'closed' }),
  });

  it('refuses admin-only routes to anonymous, bogus-token and non-admin callers', async () => {
    const reg = await SELF.fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ username: 'recon_user', email: 'recon_user@example.test', password: 'test-only-strong-password-123', ai_agent_type: 'human', accept_tos: true }),
    });
    expect(reg.status).toBe(200);
    const { token } = await reg.json();
    for (const [m, p] of adminOnly) {
      for (const t of [null, 'invalid.invalid.invalid', token]) {
        const res = await call(m, p, t);
        expect([m, p, t === token ? 'non-admin' : t ? 'bogus' : 'anon', res.status]).toEqual([m, p, t === token ? 'non-admin' : t ? 'bogus' : 'anon', 403]);
      }
    }
  });

  it('refuses authenticated-only routes to anonymous and bogus-token callers', async () => {
    for (const [m, p] of authOnly) {
      for (const t of [null, 'invalid.invalid.invalid']) {
        const res = await call(m, p, t);
        expect([m, p, res.status]).toEqual([m, p, 401]);
      }
    }
  });
});
