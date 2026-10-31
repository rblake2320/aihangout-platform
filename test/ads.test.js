import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { selectAd, validateCampaign, normaliseTags } from '../src/ads.js';

// AIH-R9: first-party ad slots. Real workerd, real D1 with migration 0026 (house-ad seed),
// real routes. Event rows are read back from analytics_events.
const BASE = 'https://aihangout.ai';
let n = 0;
const ip = () => `198.51.100.${20 + (++n % 200)}`;

async function call(path, { method = 'GET', token, body, headers = {} } = {}) {
  const res = await SELF.fetch(BASE + path, {
    method,
    headers: { 'CF-Connecting-IP': ip(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.clone().json(); } catch { /* empty or not JSON */ }
  return { res, json };
}

async function register(prefix, { admin = false } = {}) {
  const username = `${prefix}_${++n}`;
  const { json } = await call('/api/auth/register', {
    method: 'POST', body: { username, email: `${username}@example.test`, password: 'correct horse battery staple 42', aiAgentType: 'human', accept_tos: true }
  });
  if (admin) await env.AIHANGOUT_DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(json.user.id).run();
  return { token: json.token, id: json.user.id };
}

const adRows = async () => (await env.AIHANGOUT_DB.prepare(
  "SELECT event_type, user_id, user_type, session_id, ip_address, user_agent, page_url, event_data FROM analytics_events WHERE event_type IN ('ad_impression','ad_click') ORDER BY id"
).all()).results;

let admin, member;
const sponsor = {
  name: 'Vector DB launch', advertiser: 'Example Vectors Inc', kind: 'paid', status: 'active',
  placements: ['problem-footer'], target_tags: ['Embeddings', 'vector-search'],
  headline: 'Managed vector search', body: 'Sub-10ms ANN queries.', cta: 'Try it',
  click_url: 'https://vectors.example.com/start', priority: 5
};

beforeAll(async () => {
  admin = await register('ads_admin', { admin: true });
  member = await register('ads_member');
});

describe('house ads first', () => {
  it('the migration seeds active house ads that fill every placement, labelled as house ads', async () => {
    for (const placement of ['feed-inline', 'problem-footer']) {
      const { res, json } = await call(`/api/ads/serve?placement=${placement}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(json.ad).toMatchObject({ placement, kind: 'house', label: 'From AI Hangout', rel: null });
      expect(json.ad.url.startsWith('/')).toBe(true); // house ads only point at this site
    }
  });

  it('unknown placement is a 400, and placements are discoverable', async () => {
    expect((await call('/api/ads/serve?placement=sidebar-of-doom')).res.status).toBe(400);
    const { json } = await call('/api/ads/placements');
    expect(json.placements.map(p => p.id).sort()).toEqual(['feed-inline', 'problem-footer']);
  });
});

describe('admin Campaigns API', () => {
  it('requires authentication and the admin flag', async () => {
    expect((await call('/api/admin/campaigns')).res.status).toBe(401);
    expect((await call('/api/admin/campaigns', { token: member.token })).res.status).toBe(403);
    expect((await call('/api/admin/campaigns', { method: 'POST', token: member.token, body: sponsor })).res.status).toBe(403);
  });

  it('rejects unsafe creatives: javascript:/data:/http/protocol-relative links, http images, bad placements, inverted schedules', async () => {
    const bad = [
      { click_url: 'javascript:alert(1)' }, { click_url: 'data:text/html,hi' }, { click_url: 'http://vectors.example.com' },
      { click_url: '//evil.example.com' }, { image_url: 'http://img.example.com/a.png' }, { placements: ['nope'] },
      { placements: [] }, { kind: 'popup' }, { starts_at: '2027-02-01', ends_at: '2027-01-01' }, { headline: '' }
    ];
    for (const patch of bad) {
      const { res, json } = await call('/api/admin/campaigns', { method: 'POST', token: admin.token, body: { ...sponsor, ...patch } });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(json.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('creates, lists and updates a sponsored campaign; free text is sanitised', async () => {
    const created = await call('/api/admin/campaigns', { method: 'POST', token: admin.token, body: { ...sponsor, body: 'Fast <script>alert(1)</script>ANN <b>queries</b>' } });
    expect(created.res.status).toBe(201);
    const c = created.json.campaign;
    expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.target_tags).toEqual(['embeddings', 'vector-search']);
    expect(c.body).toBe('Fast ANN queries');
    sponsor.id = c.id;

    const listed = await call('/api/admin/campaigns', { token: admin.token });
    expect(listed.json.campaigns.find(x => x.id === c.id)).toMatchObject({ kind: 'paid', status: 'active', impressions: 0, clicks: 0, ctr: null });
    expect(listed.json.campaigns.filter(x => x.kind === 'house').length).toBe(3);

    const paused = await call(`/api/admin/campaigns/${c.id}`, { method: 'PUT', token: admin.token, body: { status: 'paused' } });
    expect(paused.res.status).toBe(200);
    expect(paused.json.campaign.status).toBe('paused');
    expect((await call(`/api/admin/campaigns/${c.id}`, { method: 'PUT', token: admin.token, body: { status: 'active' } })).json.campaign.status).toBe('active');
    expect((await call(`/api/admin/campaigns/${c.id}`, { method: 'PUT', token: admin.token, body: { click_url: 'javascript:x' } })).res.status).toBe(400);
    expect((await call('/api/admin/campaigns/00000000-0000-4000-8000-000000000000', { method: 'PUT', token: admin.token, body: { status: 'paused' } })).res.status).toBe(404);
  });
});

describe('selection: contextual targeting, schedule, fill order', () => {
  it('a tag-targeted sponsorship wins its placement only on pages with a matching tag', async () => {
    const hit = (await call('/api/ads/serve?placement=problem-footer&tags=python,EMBEDDINGS')).json.ad;
    expect(hit).toMatchObject({ campaign_id: sponsor.id, kind: 'paid', label: 'Sponsored by Example Vectors Inc', rel: 'sponsored noopener noreferrer', url: 'https://vectors.example.com/start' });
    const miss = (await call('/api/ads/serve?placement=problem-footer&tags=python')).json.ad;
    expect(miss.kind).toBe('house');
    const otherSlot = (await call('/api/ads/serve?placement=feed-inline&tags=embeddings')).json.ad;
    expect(otherSlot.kind).toBe('house');
  });

  it('schedule and status are enforced; draft, paused, ended and out-of-window campaigns never serve', async () => {
    const db = env.AIHANGOUT_DB;
    const now = new Date('2027-06-15T12:00:00Z');
    const mk = async (fields) => {
      const id = crypto.randomUUID();
      await db.prepare(`INSERT INTO ad_campaigns (public_id, name, advertiser, kind, status, placements, target_tags, headline, click_url, priority, starts_at, ends_at)
        VALUES (?, 'sched', 'Sched Co', 'paid', ?, '["feed-inline"]', '["sched-tag"]', 'Scheduled', 'https://sched.example.com', 1, ?, ?)`)
        .bind(id, fields.status, fields.starts_at ?? null, fields.ends_at ?? null).run();
      return id;
    };
    const live = await mk({ status: 'active', starts_at: '2027-06-01 00:00:00', ends_at: '2027-07-01 00:00:00' });
    const later = await mk({ status: 'active', starts_at: '2027-07-01 00:00:00' });   // not started yet
    const earlier = await mk({ status: 'active', ends_at: '2027-06-01 00:00:00' });     // already finished
    await mk({ status: 'draft' });
    await mk({ status: 'paused' });
    await mk({ status: 'ended' });
    for (let i = 0; i < 20; i++) {
      const ad = await selectAd(db, { placement: 'feed-inline', tags: ['sched-tag'], now, random: () => i / 20 });
      expect(ad.campaign_id).toBe(live);
    }
    // After the first window closes, the later campaign has started and takes over.
    const after = await selectAd(db, { placement: 'feed-inline', tags: ['sched-tag'], now: new Date('2027-07-02T00:00:00Z') });
    expect(after.campaign_id).toBe(later);
    // Before the first window opens, the earlier campaign (ends 2027-06-01) is the live one.
    const before = await selectAd(db, { placement: 'feed-inline', tags: ['sched-tag'], now: new Date('2027-05-01T00:00:00Z') });
    expect(before.campaign_id).toBe(earlier);
  });

  it('equal campaigns share the slot by weight', async () => {
    const db = env.AIHANGOUT_DB;
    const counts = {};
    for (let i = 0; i < 300; i++) {
      const ad = await selectAd(db, { placement: 'feed-inline', tags: [], random: () => (i + 0.5) / 300 });
      counts[ad.headline] = (counts[ad.headline] || 0) + 1;
    }
    // seed weights: "ask a question" 2, "earn reputation" 1 (the bug-report ad is problem-footer only)
    expect(counts['Stuck on an AI or ML problem?']).toBe(200);
    expect(counts['Know the answer? Earn reputation for it.']).toBe(100);
  });
});

describe('impression and click events respect consent', () => {
  const batch = () => ({ events: [
    { type: 'impression', campaign_id: sponsor.id, placement: 'problem-footer', view_id: 'view_abcdef01' },
    { type: 'impression', campaign_id: sponsor.id, placement: 'problem-footer', view_id: 'view_abcdef01' }, // duplicate view
    { type: 'click', campaign_id: sponsor.id, placement: 'problem-footer', view_id: 'view_abcdef01' },
    { type: 'impression', campaign_id: sponsor.id, placement: 'feed-inline', view_id: 'view_abcdef02' },     // not its placement
    { type: 'impression', campaign_id: '00000000-0000-4000-8000-000000000000', placement: 'problem-footer' }, // unknown
    { type: 'hover', campaign_id: sponsor.id, placement: 'problem-footer' }                                   // unknown type
  ] });

  it('without ?consent=analytics nothing is stored (204)', async () => {
    const before = (await adRows()).length;
    const { res } = await call('/api/ads/events', { method: 'POST', body: batch() });
    expect(res.status).toBe(204);
    expect((await adRows()).length).toBe(before);
  });

  it('Global Privacy Control or Do Not Track overrides a stated consent', async () => {
    const before = (await adRows()).length;
    expect((await call('/api/ads/events?consent=analytics', { method: 'POST', body: batch(), headers: { 'Sec-GPC': '1' } })).res.status).toBe(204);
    expect((await call('/api/ads/events?consent=analytics', { method: 'POST', body: batch(), headers: { DNT: '1' } })).res.status).toBe(204);
    expect((await adRows()).length).toBe(before);
  });

  it('with consent, valid events are stored without any personal data, invalid ones dropped', async () => {
    const before = (await adRows()).length;
    const { res, json } = await call('/api/ads/events?consent=analytics', {
      method: 'POST', body: batch(), token: member.token, headers: { 'User-Agent': 'Mozilla/5.0 test-agent' }
    });
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ accepted: 2, rejected: 4 });
    const rows = (await adRows()).slice(before);
    expect(rows.map(r => r.event_type)).toEqual(['ad_impression', 'ad_click']);
    for (const r of rows) {
      expect([r.user_id, r.user_type, r.session_id, r.ip_address, r.user_agent, r.page_url]).toEqual([null, null, null, null, null, null]);
      expect(JSON.parse(r.event_data)).toMatchObject({ campaign_id: sponsor.id, placement: 'problem-footer', view_id: 'view_abcdef01' });
    }
    const stats = (await call('/api/admin/campaigns', { token: admin.token })).json.campaigns.find(c => c.id === sponsor.id);
    expect(stats).toMatchObject({ impressions: 1, clicks: 1, ctr: 1 });
  });

  it('rejects malformed and oversized batches', async () => {
    expect((await call('/api/ads/events?consent=analytics', { method: 'POST', body: { events: [] } })).res.status).toBe(400);
    expect((await call('/api/ads/events?consent=analytics', { method: 'POST', body: { nope: 1 } })).res.status).toBe(400);
    const big = { events: Array.from({ length: 21 }, () => ({ type: 'impression', campaign_id: sponsor.id, placement: 'problem-footer' })) };
    expect((await call('/api/ads/events?consent=analytics', { method: 'POST', body: big })).res.status).toBe(413);
  });
});

describe('validation helpers', () => {
  it('normalises contextual tags and keeps partial updates partial', () => {
    expect(normaliseTags(' Embeddings, vector-search ,,<x>, c++ ')).toEqual(['embeddings', 'vector-search', 'c++']);
    const v = validateCampaign({ status: 'paused' }, { partial: true });
    expect(v).toEqual({ ok: true, errors: [], value: { status: 'paused' } });
  });
});
