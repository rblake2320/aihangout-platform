// AIH-R9: first-party ad slots and campaigns. House ads first, sponsorship-friendly.
//
// No third-party ad code ever runs: campaigns are rows in D1, creatives are text plus an
// optional https image, links go straight to the advertiser with rel="sponsored".
// Targeting is contextual only (the tags of the page being viewed), never a profile of
// the viewer. Impression and click events are behavioural telemetry and are recorded
// only under the same consent rule as the rest of the site's analytics (AIH-R4); they
// carry no IP, user agent, user id or session.

// Placement ids are a stable contract with the frontend and with advertisers.
export const PLACEMENTS = {
  'feed-inline': { label: 'Home feed, after the third problem' },
  'problem-footer': { label: 'Problem page, below the answers' }
};

// Fill order: paid sponsorships, then community (free promotion for open projects),
// then house ads, which keep every slot useful when nothing is sold.
export const CAMPAIGN_KINDS = ['paid', 'community', 'house'];
export const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'ended'];
const KIND_RANK = { paid: 0, community: 1, house: 2 };
const EVENT_TYPES = { impression: 'ad_impression', click: 'ad_click' };
const MAX_EVENTS_PER_BATCH = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same rule as AIH-R4's telemetry gate: an explicit ?consent=analytics from the client,
// and no Global Privacy Control / Do Not Track signal. Anything else stores nothing.
export function eventConsentGiven(request) {
  if (request.headers.get('Sec-GPC') === '1' || request.headers.get('DNT') === '1') return false;
  return new URL(request.url).searchParams.get('consent') === 'analytics';
}

function parseJsonArray(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

export function normaliseTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  return [...new Set(list.map(t => String(t).trim().toLowerCase()).filter(t => /^[a-z0-9][a-z0-9+#.\- ]{0,39}$/.test(t)))].slice(0, 10);
}

// Links: https anywhere, or a same-site path. Never javascript:, data:, protocol-relative or http.
function safeUrl(value, { allowPath }) {
  const s = String(value || '').trim();
  if (allowPath && /^\/(?!\/)[^\s]*$/.test(s)) return s;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && u.hostname ? u.toString() : null;
  } catch (_) {
    return null;
  }
}

// Creative images are fetched by the Worker, never by the visitor's browser, so an
// advertiser's image host never sees a visitor's IP address, cookies or referrer.
// The image host must be a public DNS name: no IP literals, no localhost.
function safeImageUrl(value) {
  const u = safeUrl(value, { allowPath: false });
  if (!u) return null;
  const host = new URL(u).hostname;
  if (host === 'localhost' || host.endsWith('.localhost') || /^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return null;
  return u;
}

export const creativePath = (publicId) => `/api/ads/creative/${publicId}`;
export const CREATIVE_MAX_BYTES = 512 * 1024;
const IMAGE_SIGNATURES = {
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  'image/webp': (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
};

// Fetch one creative with a fresh request (no visitor headers are copied), no redirects,
// a raster-image type allowlist (no SVG: it can carry script), a magic-byte check that the
// bytes are what the header claims, and a size cap. Returns { ok, type, bytes } or { ok: false, reason }.
export async function fetchCreative(url, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(new Request(url, { method: 'GET', redirect: 'manual', headers: { Accept: Object.keys(IMAGE_SIGNATURES).join(', ') } }));
  } catch (_) {
    return { ok: false, reason: 'fetch_failed' };
  }
  if (res.status !== 200) return { ok: false, reason: `status_${res.status}` };
  const type = (res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_SIGNATURES[type]) return { ok: false, reason: 'type_not_allowed' };
  const declared = Number(res.headers.get('Content-Length') || 0);
  if (declared > CREATIVE_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, reason: 'empty' };
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CREATIVE_MAX_BYTES) { await reader.cancel(); return { ok: false, reason: 'too_large' }; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
  if (total < 12 || !IMAGE_SIGNATURES[type](bytes)) return { ok: false, reason: 'signature_mismatch' };
  return { ok: true, type, bytes };
}

function isoOrNull(value) {
  if (value == null || value === '') return { ok: true, value: null };
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? { ok: false } : { ok: true, value: new Date(t).toISOString().replace('T', ' ').slice(0, 19) };
}

// Validates a create (all fields) or update (only supplied fields). `clean` is the site's
// sanitizeContent pipeline, applied to every free-text field before it is stored.
export function validateCampaign(input, { partial = false, clean = (s) => s } = {}) {
  const errors = [];
  const out = {};
  const has = (k) => input[k] !== undefined;
  const text = (k, min, max) => {
    if (!has(k)) { if (!partial && min > 0) errors.push(`${k} is required`); return; }
    const v = clean(String(input[k] ?? '').trim());
    if (v.length < min || v.length > max) errors.push(`${k} must be ${min}-${max} characters`);
    else out[k] = v;
  };
  text('name', 1, 100);
  text('advertiser', 1, 100);
  text('headline', 1, 90);
  text('body', 0, 240);
  text('cta', 0, 30);
  if (has('kind') || !partial) {
    const kind = input.kind ?? 'house';
    if (!CAMPAIGN_KINDS.includes(kind)) errors.push(`kind must be one of ${CAMPAIGN_KINDS.join(', ')}`);
    else out.kind = kind;
  }
  if (has('status') || !partial) {
    const status = input.status ?? 'draft';
    if (!CAMPAIGN_STATUSES.includes(status)) errors.push(`status must be one of ${CAMPAIGN_STATUSES.join(', ')}`);
    else out.status = status;
  }
  if (has('placements') || !partial) {
    const p = Array.isArray(input.placements) ? [...new Set(input.placements)] : [];
    if (!p.length || p.some(x => !PLACEMENTS[x])) errors.push(`placements must be a non-empty list of: ${Object.keys(PLACEMENTS).join(', ')}`);
    else out.placements = JSON.stringify(p);
  }
  if (has('target_tags') || !partial) out.target_tags = JSON.stringify(normaliseTags(input.target_tags || []));
  if (has('click_url') || !partial) {
    const u = safeUrl(input.click_url, { allowPath: true });
    if (!u) errors.push('click_url must be an https URL or a site path starting with /');
    else out.click_url = u;
  }
  if (has('image_url')) {
    if (input.image_url == null || input.image_url === '') out.image_url = null;
    else {
      const u = safeImageUrl(input.image_url);
      if (!u) errors.push('image_url must be an https URL on a public host name');
      else out.image_url = u;
    }
  }
  for (const [k, min, max, dflt] of [['priority', -100, 100, 0], ['weight', 1, 100, 1]]) {
    if (!has(k) && partial) continue;
    const v = has(k) ? Number(input[k]) : dflt;
    if (!Number.isInteger(v) || v < min || v > max) errors.push(`${k} must be an integer ${min}..${max}`);
    else out[k] = v;
  }
  for (const k of ['starts_at', 'ends_at']) {
    if (!has(k) && partial) continue;
    const r = isoOrNull(input[k]);
    if (!r.ok) errors.push(`${k} must be an ISO 8601 date or null`);
    else out[k] = r.value;
  }
  if (out.starts_at && out.ends_at && out.ends_at <= out.starts_at) errors.push('ends_at must be after starts_at');
  return { ok: errors.length === 0, errors, value: out };
}

// The public shape of a served ad. Disclosure is not optional: every ad says what it is.
function publicAd(c, placement) {
  const sponsored = c.kind !== 'house';
  return {
    campaign_id: c.public_id,
    placement,
    kind: c.kind,
    label: sponsored ? `Sponsored by ${c.advertiser}` : 'From AI Hangout',
    advertiser: c.advertiser,
    headline: c.headline,
    body: c.body || null,
    cta: c.cta || null,
    // Same-origin proxy path, never the advertiser's URL (see fetchCreative).
    image_url: c.image_url ? creativePath(c.public_id) : null,
    url: c.click_url,
    rel: sponsored ? 'sponsored noopener noreferrer' : null
  };
}

// Pick one ad for a placement and the page's tags. Ranking: kind (paid > community >
// house), then a tag-targeted match over run-of-site, then priority; ties are broken by
// weighted random so equal campaigns share the slot.
export async function selectAd(db, { placement, tags = [], now = new Date(), random = Math.random }) {
  const nowSql = now.toISOString().replace('T', ' ').slice(0, 19);
  const rows = (await db.prepare(`
    SELECT id, public_id, kind, advertiser, headline, body, cta, image_url, click_url, placements, target_tags, priority, weight
    FROM ad_campaigns
    WHERE status = 'active' AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?)`).bind(nowSql, nowSql).all()).results || [];
  const pageTags = new Set(normaliseTags(tags));
  const eligible = [];
  for (const c of rows) {
    if (!parseJsonArray(c.placements).includes(placement)) continue;
    const targets = parseJsonArray(c.target_tags);
    const matched = targets.some(t => pageTags.has(t));
    if (targets.length && !matched) continue;
    eligible.push({ c, key: [KIND_RANK[c.kind] ?? 9, matched ? 0 : 1, -(c.priority || 0)] });
  }
  if (!eligible.length) return null;
  const cmp = (a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2];
  eligible.sort(cmp);
  const top = eligible.filter(e => cmp(e, eligible[0]) === 0);
  const total = top.reduce((s, e) => s + Math.max(1, e.c.weight || 1), 0);
  let r = random() * total;
  for (const e of top) {
    r -= Math.max(1, e.c.weight || 1);
    if (r < 0) return publicAd(e.c, placement);
  }
  return publicAd(top[top.length - 1].c, placement);
}

export async function campaignStats(db) {
  const rows = (await db.prepare(`
    SELECT CAST(json_extract(event_data, '$.campaign') AS INTEGER) AS campaign, event_type, COUNT(*) AS n
    FROM analytics_events WHERE event_type IN ('ad_impression', 'ad_click')
    GROUP BY campaign, event_type`).all()).results || [];
  const stats = new Map();
  for (const r of rows) {
    const s = stats.get(r.campaign) || { impressions: 0, clicks: 0 };
    if (r.event_type === 'ad_impression') s.impressions = r.n; else s.clicks = r.n;
    stats.set(r.campaign, s);
  }
  return stats;
}

function adminView(c, stats) {
  const s = stats.get(c.id) || { impressions: 0, clicks: 0 };
  return {
    id: c.public_id,
    name: c.name,
    advertiser: c.advertiser,
    kind: c.kind,
    status: c.status,
    placements: parseJsonArray(c.placements),
    target_tags: parseJsonArray(c.target_tags),
    headline: c.headline,
    body: c.body,
    cta: c.cta,
    image_url: c.image_url,
    click_url: c.click_url,
    priority: c.priority,
    weight: c.weight,
    starts_at: c.starts_at,
    ends_at: c.ends_at,
    created_at: c.created_at,
    updated_at: c.updated_at,
    impressions: s.impressions,
    clicks: s.clicks,
    ctr: s.impressions ? Number((s.clicks / s.impressions).toFixed(4)) : null
  };
}

// deps: authenticate, checkRateLimit, rateLimitResponse, jsonResponse, errResponse, sanitizeContent
export function registerAdRoutes(router, deps) {
  const { authenticate, checkRateLimit, rateLimitResponse, jsonResponse, errResponse, sanitizeContent } = deps;

  router.get('/api/ads/placements', () => jsonResponse({
    success: true,
    placements: Object.entries(PLACEMENTS).map(([id, p]) => ({ id, ...p })),
    kinds: CAMPAIGN_KINDS
  }, { headers: { 'Cache-Control': 'public, max-age=3600' } }));

  router.get('/api/ads/serve', async (request, env) => {
    try {
      const url = new URL(request.url);
      const placement = url.searchParams.get('placement') || '';
      if (!PLACEMENTS[placement]) return jsonResponse({ success: false, error: 'Unknown placement', code: 'INVALID_ARGUMENT' }, { status: 400 });
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rl = await checkRateLimit(env.AIHANGOUT_KV, ip, null, 'api');
      if (rl.limited) return rateLimitResponse(rl);
      const ad = await selectAd(env.AIHANGOUT_DB, { placement, tags: url.searchParams.get('tags') || '' });
      return jsonResponse({ success: true, ad }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      // An ad must never break a page: fail to "no ad".
      console.error('[Ads] serve failed', error?.message || error);
      return jsonResponse({ success: true, ad: null }, { headers: { 'Cache-Control': 'no-store' } });
    }
  });

  router.get('/api/ads/creative/:id', async (request, env) => {
    const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    try {
      const id = String(request.params.id || '').toLowerCase();
      if (!UUID_RE.test(id)) return notFound();
      const c = await env.AIHANGOUT_DB.prepare(
        "SELECT public_id, image_url, updated_at FROM ad_campaigns WHERE public_id = ? AND status != 'draft'"
      ).bind(id).first();
      if (!c || !c.image_url) return notFound();
      // Cache per campaign revision so one fetch serves every viewer until the campaign changes.
      const cacheKey = new Request(`https://ads-creative.internal/${c.public_id}?v=${encodeURIComponent(c.updated_at || '')}`);
      const cache = typeof caches !== 'undefined' ? caches.default : null;
      const hit = cache ? await cache.match(cacheKey) : null;
      if (hit) return hit;
      const got = await fetchCreative(c.image_url);
      if (!got.ok) {
        console.error('[Ads] creative unavailable', c.public_id, got.reason);
        return notFound();
      }
      const res = new Response(got.bytes, {
        headers: {
          'Content-Type': got.type,
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Cross-Origin-Resource-Policy': 'same-origin'
        }
      });
      if (cache) await cache.put(cacheKey, res.clone());
      return res;
    } catch (error) {
      console.error('[Ads] creative failed', error?.message || error);
      return notFound();
    }
  });

  router.post('/api/ads/events', async (request, env) => {
    try {
      if (!eventConsentGiven(request)) return new Response(null, { status: 204 });
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rl = await checkRateLimit(env.AIHANGOUT_KV, ip, null, 'telemetry');
      if (rl.limited) return rateLimitResponse(rl);
      let body;
      try { body = JSON.parse(await request.text()); } catch (_) { return errResponse('Invalid JSON', null, 400); }
      const events = Array.isArray(body?.events) ? body.events : null;
      if (!events || events.length === 0) return errResponse('events must be a non-empty array', null, 400);
      if (events.length > MAX_EVENTS_PER_BATCH) return errResponse(`At most ${MAX_EVENTS_PER_BATCH} events per batch`, null, 413);

      const wanted = [...new Set(events.map(e => String(e?.campaign_id || '').toLowerCase()).filter(id => UUID_RE.test(id)))];
      const known = new Map();
      if (wanted.length) {
        const rows = (await env.AIHANGOUT_DB.prepare(
          `SELECT id, public_id, placements FROM ad_campaigns WHERE public_id IN (${wanted.map(() => '?').join(',')})`
        ).bind(...wanted).all()).results || [];
        for (const r of rows) known.set(r.public_id, r);
      }
      const seen = new Set();
      const stmts = [];
      for (const e of events) {
        const type = EVENT_TYPES[e?.type];
        const c = known.get(String(e?.campaign_id || '').toLowerCase());
        const placement = String(e?.placement || '');
        const viewId = /^[A-Za-z0-9_-]{8,40}$/.test(String(e?.view_id || '')) ? String(e.view_id) : null;
        if (!type || !c || !parseJsonArray(c.placements).includes(placement)) continue;
        const dedupe = `${type}:${c.id}:${placement}:${viewId}`;
        if (viewId && seen.has(dedupe)) continue;
        seen.add(dedupe);
        // Deliberately no ip_address, user_agent, user_id or session_id.
        stmts.push(env.AIHANGOUT_DB.prepare(
          'INSERT INTO analytics_events (event_type, event_data) VALUES (?, ?)'
        ).bind(type, JSON.stringify({ campaign: c.id, campaign_id: c.public_id, placement, ...(viewId ? { view_id: viewId } : {}) })));
      }
      if (stmts.length) await env.AIHANGOUT_DB.batch(stmts);
      return jsonResponse({ success: true, accepted: stmts.length, rejected: events.length - stmts.length });
    } catch (error) {
      return errResponse('Unable to record ad events', error);
    }
  });

  async function requireAdmin(request, env) {
    const user = await authenticate(request, env);
    if (!user) return { response: errResponse('Authentication required', null, 401) };
    if (!user.is_admin) return { response: errResponse('Admin access required', null, 403) };
    return { user };
  }

  router.get('/api/admin/campaigns', async (request, env) => {
    try {
      const gate = await requireAdmin(request, env);
      if (gate.response) return gate.response;
      const db = env.AIHANGOUT_DB;
      const [rows, stats] = await Promise.all([
        db.prepare('SELECT * FROM ad_campaigns ORDER BY CASE status WHEN \'active\' THEN 0 WHEN \'draft\' THEN 1 WHEN \'paused\' THEN 2 ELSE 3 END, created_at DESC').all(),
        campaignStats(db)
      ]);
      return jsonResponse({
        success: true,
        placements: Object.entries(PLACEMENTS).map(([id, p]) => ({ id, ...p })),
        campaigns: (rows.results || []).map(c => adminView(c, stats))
      }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return errResponse('Unable to list campaigns', error);
    }
  });

  router.post('/api/admin/campaigns', async (request, env) => {
    try {
      const gate = await requireAdmin(request, env);
      if (gate.response) return gate.response;
      let input;
      try { input = JSON.parse(await request.text()); } catch (_) { return errResponse('Invalid JSON', null, 400); }
      const v = validateCampaign(input || {}, { clean: sanitizeContent });
      if (!v.ok) return jsonResponse({ success: false, error: v.errors.join('; '), errors: v.errors, code: 'INVALID_ARGUMENT' }, { status: 400 });
      const publicId = crypto.randomUUID();
      const c = v.value;
      await env.AIHANGOUT_DB.prepare(`
        INSERT INTO ad_campaigns (public_id, name, advertiser, kind, status, placements, target_tags, headline, body, cta,
          image_url, click_url, priority, weight, starts_at, ends_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        publicId, c.name, c.advertiser, c.kind, c.status, c.placements, c.target_tags, c.headline, c.body || null, c.cta || null,
        c.image_url ?? null, c.click_url, c.priority, c.weight, c.starts_at, c.ends_at, gate.user.id || null
      ).run();
      const row = await env.AIHANGOUT_DB.prepare('SELECT * FROM ad_campaigns WHERE public_id = ?').bind(publicId).first();
      return jsonResponse({ success: true, campaign: adminView(row, new Map()) }, { status: 201 });
    } catch (error) {
      return errResponse('Unable to create campaign', error);
    }
  });

  router.put('/api/admin/campaigns/:id', async (request, env) => {
    try {
      const gate = await requireAdmin(request, env);
      if (gate.response) return gate.response;
      const id = String(request.params.id || '').toLowerCase();
      if (!UUID_RE.test(id)) return errResponse('Campaign not found', null, 404);
      const db = env.AIHANGOUT_DB;
      const existing = await db.prepare('SELECT * FROM ad_campaigns WHERE public_id = ?').bind(id).first();
      if (!existing) return errResponse('Campaign not found', null, 404);
      let input;
      try { input = JSON.parse(await request.text()); } catch (_) { return errResponse('Invalid JSON', null, 400); }
      const v = validateCampaign(input || {}, { partial: true, clean: sanitizeContent });
      // A schedule edit is checked against the stored end of the window it did not touch.
      const starts = v.value.starts_at !== undefined ? v.value.starts_at : existing.starts_at;
      const ends = v.value.ends_at !== undefined ? v.value.ends_at : existing.ends_at;
      if (starts && ends && ends <= starts) v.errors.push('ends_at must be after starts_at');
      if (v.errors.length) return jsonResponse({ success: false, error: v.errors.join('; '), errors: v.errors, code: 'INVALID_ARGUMENT' }, { status: 400 });
      const fields = Object.keys(v.value);
      if (!fields.length) return errResponse('No changes supplied', null, 400);
      await db.prepare(`UPDATE ad_campaigns SET ${fields.map(f => `${f} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(...fields.map(f => v.value[f]), existing.id).run();
      const row = await db.prepare('SELECT * FROM ad_campaigns WHERE id = ?').bind(existing.id).first();
      return jsonResponse({ success: true, campaign: adminView(row, await campaignStats(db)) });
    } catch (error) {
      return errResponse('Unable to update campaign', error);
    }
  });
}
