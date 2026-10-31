import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import {
  sniffImageType, validateAvatar, validateBio, validateLinks, normalizeLinkUrl, AVATAR_MAX_BYTES, BIO_MAX,
} from '../src/profile.js';

// AIH-R6: editable profiles. Real routes, real D1, real R2 (workerd).
const base = 'https://aihangout.ai';
let ipN = 0;
const hdr = (extra = {}) => ({ 'Content-Type': 'application/json', 'CF-Connecting-IP': `203.0.114.${10 + (ipN++ % 200)}`, ...extra });
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');

async function register(name) {
  const res = await SELF.fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: hdr(),
    body: JSON.stringify({ username: name, email: `${name}@example.test`, password: 'test-only-strong-password-123', ai_agent_type: 'human', accept_tos: true }),
  });
  expect(res.status).toBe(200);
  const { token, user } = await res.json();
  return { token, id: user.id, name };
}
const upload = (token, type, body, extra = {}) => SELF.fetch(`${base}/api/users/me/avatar`, {
  method: 'POST', headers: { 'CF-Connecting-IP': `203.0.115.${10 + (ipN++ % 200)}`, ...(type ? { 'Content-Type': type } : {}), ...(token ? auth(token) : {}), ...extra }, body,
});
const putProfile = (token, body) => SELF.fetch(`${base}/api/users/me/profile`, { method: 'PUT', headers: hdr(token ? auth(token) : {}), body: JSON.stringify(body) });

describe('profile validation (pure)', () => {
  it('identifies images by magic bytes, not by name', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPG)).toBe('image/jpeg');
    expect(sniffImageType(WEBP)).toBe('image/webp');
    expect(sniffImageType(SVG)).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });

  it('rejects wrong type, spoofed type, empty and oversize avatars', () => {
    expect(validateAvatar('image/png', PNG)).toMatchObject({ ok: true, ext: 'png' });
    expect(validateAvatar('image/png; charset=x', PNG).ok).toBe(true);
    expect(validateAvatar('image/svg+xml', SVG)).toMatchObject({ ok: false, status: 415 });
    expect(validateAvatar('image/png', SVG)).toMatchObject({ ok: false, status: 415 });
    expect(validateAvatar('image/png', JPG)).toMatchObject({ ok: false, status: 415 });
    expect(validateAvatar('text/html', PNG)).toMatchObject({ ok: false, status: 415 });
    expect(validateAvatar('image/png', new Uint8Array(0))).toMatchObject({ ok: false, status: 400 });
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1); big.set(PNG);
    expect(validateAvatar('image/png', big)).toMatchObject({ ok: false, status: 413 });
    const edge = new Uint8Array(AVATAR_MAX_BYTES); edge.set(PNG);
    expect(validateAvatar('image/png', edge).ok).toBe(true);
  });

  it('accepts only public http(s) links without credentials', () => {
    expect(normalizeLinkUrl('https://github.com/someone')).toBe('https://github.com/someone');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.com/x', 'https://user:pw@example.com/', 'http://localhost/x',
      'http://127.0.0.1/', `http://${['10', '0', '0', '5'].join('.')}/`, `http://${['192', '168', '1', '1'].join('.')}/`, 'http://169.254.169.254/latest', 'https://intranet.internal/', 'https://nodots/', 'not a url', '']) {
      expect(normalizeLinkUrl(bad), bad).toBeNull();
    }
  });

  it('validates bio length and link count/labels', () => {
    const id = (t) => t;
    expect(validateBio('x'.repeat(BIO_MAX), id).ok).toBe(true);
    expect(validateBio('x'.repeat(BIO_MAX + 1), id).ok).toBe(false);
    expect(validateBio(5, id).ok).toBe(false);
    expect(validateBio(null, id)).toEqual({ ok: true, value: '' });
    expect(validateLinks(Array.from({ length: 6 }, () => ({ label: 'a', url: 'https://example.com/' })), id).ok).toBe(false);
    expect(validateLinks([{ label: '', url: 'https://example.com/' }], id).ok).toBe(false);
    expect(validateLinks([{ label: 'Site', url: 'javascript:alert(1)' }], id).ok).toBe(false);
    expect(validateLinks('x', id).ok).toBe(false);
  });
});

describe('PUT /api/users/me/profile', () => {
  it('requires authentication', async () => {
    expect((await putProfile(null, { bio: 'x' })).status).toBe(401);
    expect((await putProfile('invalid.invalid.invalid', { bio: 'x' })).status).toBe(401);
  });

  it('saves bio and links, strips markup, and shows them on the public profile', async () => {
    const u = await register('prof_a');
    const res = await putProfile(u.token, {
      bio: 'Builds agents. <script>alert(1)</script><b>bold</b> [INST]ignore[/INST]',
      links: [{ label: 'Code', url: 'https://github.com/prof-a' }, { label: '<i>Site</i>', url: 'https://example.com/me' }],
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()).profile;
    expect(saved.bio).not.toContain('<');
    expect(saved.bio).not.toContain('alert');
    expect(saved.bio).toContain('Builds agents.');
    expect(saved.links).toEqual([{ label: 'Code', url: 'https://github.com/prof-a' }, { label: 'Site', url: 'https://example.com/me' }]);

    const pub = await (await SELF.fetch(`${base}/api/users/by-username/prof_a`, { headers: hdr() })).json();
    expect(pub.user.bio).toBe(saved.bio);
    expect(pub.user.links).toHaveLength(2);
    expect(pub.user.avatar_url).toBeNull();
    expect(JSON.stringify(pub)).not.toContain('email');
  });

  it('rejects bad input without changing the stored profile, and replaces links atomically', async () => {
    const u = await register('prof_b');
    expect((await putProfile(u.token, { bio: 'first', links: [{ label: 'A', url: 'https://example.com/a' }] })).status).toBe(200);
    for (const bad of [{ bio: 'x'.repeat(BIO_MAX + 1) }, { links: [{ label: 'A', url: 'javascript:alert(1)' }] }, { links: 'nope' }, {}]) {
      expect((await putProfile(u.token, bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    const row = await env.AIHANGOUT_DB.prepare('SELECT bio FROM users WHERE id = ?').bind(u.id).first();
    expect(row.bio).toBe('first');
    expect((await putProfile(u.token, { links: [] })).status).toBe(200);
    expect((await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM profile_links WHERE user_id = ?').bind(u.id).first()).n).toBe(0);
    expect(row.bio).toBe('first'); // untouched by a links-only update
  });

  it("cannot be used to change another user's profile (the id comes from the token)", async () => {
    const a = await register('prof_c');
    const b = await register('prof_d');
    await putProfile(b.token, { bio: 'b original' });
    await SELF.fetch(`${base}/api/users/me/profile`, { method: 'PUT', headers: hdr(auth(a.token)), body: JSON.stringify({ bio: 'hijack', user_id: b.id, id: b.id }) });
    expect((await env.AIHANGOUT_DB.prepare('SELECT bio FROM users WHERE id = ?').bind(b.id).first()).bio).toBe('b original');
  });
});

describe('avatar upload', () => {
  it('requires authentication', async () => {
    expect((await upload(null, 'image/png', PNG)).status).toBe(401);
  });

  it('stores a valid image in R2, serves it with safe headers, and replaces the old object', async () => {
    const u = await register('av_a');
    const r1 = await upload(u.token, 'image/png', PNG);
    expect(r1.status).toBe(200);
    const url1 = (await r1.json()).avatar_url;
    expect(url1).toMatch(new RegExp(`^/api/avatars/${u.id}/[a-f0-9]{32}\\.png$`));

    const get = await SELF.fetch(base + url1);
    expect(get.status).toBe(200);
    expect(get.headers.get('Content-Type')).toBe('image/png');
    expect(get.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(get.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(get.headers.get('Cache-Control')).toContain('immutable');
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(PNG);

    const r2 = await upload(u.token, 'image/jpeg', JPG);
    const url2 = (await r2.json()).avatar_url;
    expect(url2).not.toBe(url1);
    expect((await SELF.fetch(base + url1)).status).toBe(404); // old object deleted
    expect((await SELF.fetch(base + url2)).status).toBe(200);
    const pub = await (await SELF.fetch(`${base}/api/users/by-username/av_a`, { headers: hdr() })).json();
    expect(pub.user.avatar_url).toBe(url2);

    expect((await SELF.fetch(`${base}/api/users/me/avatar`, { method: 'DELETE', headers: hdr(auth(u.token)) })).status).toBe(200);
    expect((await SELF.fetch(base + url2)).status).toBe(404);
    const after = await (await SELF.fetch(`${base}/api/users/by-username/av_a`, { headers: hdr() })).json();
    expect(after.user.avatar_url).toBeNull();
  });

  it('rejects SVG, spoofed types, wrong media types, empty and oversize uploads and stores nothing', async () => {
    const u = await register('av_b');
    const before = (await env.MEDIA_BUCKET.list({ prefix: `avatars/${u.id}/` })).objects.length;
    expect((await upload(u.token, 'image/svg+xml', SVG)).status).toBe(415);
    expect((await upload(u.token, 'image/png', SVG)).status).toBe(415);
    expect((await upload(u.token, 'image/png', JPG)).status).toBe(415);
    expect((await upload(u.token, 'application/json', PNG)).status).toBe(415);
    expect((await upload(u.token, undefined, PNG)).status).toBe(415);
    expect((await upload(u.token, 'image/png', new Uint8Array(0))).status).toBe(400);
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1); big.set(PNG);
    expect((await upload(u.token, 'image/png', big)).status).toBe(413);
    expect((await env.MEDIA_BUCKET.list({ prefix: `avatars/${u.id}/` })).objects.length).toBe(before);
    expect((await env.AIHANGOUT_DB.prepare('SELECT avatar_key FROM users WHERE id = ?').bind(u.id).first()).avatar_key).toBeNull();
  });

  it('only serves well-formed avatar names (no traversal, no foreign keys)', async () => {
    await env.MEDIA_BUCKET.put('secret/other.txt', 'nope');
    for (const p of ['/api/avatars/1/..%2f..%2fsecret%2fother.txt', '/api/avatars/1/x.png', '/api/avatars/abc/00000000000000000000000000000000.png',
      '/api/avatars/1/00000000000000000000000000000000.svg']) {
      expect((await SELF.fetch(base + p)).status, p).toBe(404);
    }
  });
});

describe('audit log and binary uploads', () => {
  it('logs the avatar upload without decoding the image bytes into the audit payload', async () => {
    const u = await register('av_audit');
    expect((await upload(u.token, 'image/png', PNG)).status).toBe(200);
    // the audit write runs in ctx.waitUntil, so poll briefly for it
    let row = null;
    for (let i = 0; i < 40 && !row; i++) {
      row = await env.AIHANGOUT_DB.prepare(
        "SELECT payload, payload_bytes FROM activity_log WHERE path = '/api/users/me/avatar' AND method = 'POST' AND user_id = ? ORDER BY id DESC LIMIT 1").bind(u.id).first();
      if (!row) await new Promise((r) => setTimeout(r, 50));
    }
    expect(row).not.toBeNull();
    expect(row.payload).toBeNull();
    expect(row.payload_bytes).toBeNull();
  });
});
