import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import shellHtml from '../frontend/index.html?raw';
import { renderIntoShell, sitemapIndex, problemsSitemap } from '../src/seo/render.js';
import { problemPath } from '../src/public-ids.js';

// AIH-R1: what a crawler or AI assistant sees with no JavaScript. Real workerd, real D1
// with real migrations, content created through the real REST routes.
const BASE = 'https://aihangout.ai';
let n = 0;
const ip = () => `198.51.100.${10 + (++n % 200)}`;

async function api(path, { method = 'GET', token, body, from = ip() } = {}) {
  const res = await SELF.fetch(BASE + path, {
    method,
    headers: { 'CF-Connecting-IP': from, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { res, json };
}

async function register(prefix, type = 'human') {
  const username = `${prefix}_${++n}`;
  const { res, json } = await api('/api/auth/register', {
    method: 'POST',
    body: { username, email: `${username}@example.test`, password: 'correct horse battery staple 42', aiAgentType: type, accept_tos: true }
  });
  expect(res.status).toBe(200);
  return { username, token: json.token, id: json.user.id };
}

async function postProblem(user, fields) {
  const { res, json } = await api('/api/problems', { method: 'POST', token: user.token, body: { category: 'backend', ...fields } });
  expect(res.status).toBe(200);
  return json.problemId ?? json.problem?.id ?? json.id;
}

async function page(path, host = BASE) {
  const res = await SELF.fetch(host + path, { headers: { 'CF-Connecting-IP': ip(), 'User-Agent': 'Googlebot/2.1' } });
  return { res, html: await res.text() };
}

function jsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  expect(blocks.length).toBe(1);
  return JSON.parse(blocks[0][1]);
}

const XSS_TITLE = 'Why does </script><script>alert(1)</script> <img src=x onerror=alert(2)> break my parser?';
let asker, agent, publicId, xssId, pendingId, privateId, solutionId, solutionPublicId, canon;
const canonicalOf = async (id) => problemPath(await env.AIHANGOUT_DB.prepare('SELECT public_id, title FROM problems WHERE id = ?').bind(id).first());

beforeAll(async () => {
  asker = await register('seo_asker');
  agent = await register('seo_agent', 'research');
  publicId = await postProblem(asker, {
    title: 'Socket leak under load in a Node worker pool',
    description: 'Under sustained load the pool opens sockets and never closes them.\n\nHeap snapshots show handles piling up.',
    tags: ['nodejs', 'Sockets']
  });
  xssId = await postProblem({ ...asker }, { title: 'placeholder title for escaping probe', description: 'placeholder body', tags: ['parsing'] });
  // REST input sanitisation already strips tags, so write hostile text straight to D1: the
  // renderer must stay safe for legacy, harvested or future rows that bypass that path.
  await env.AIHANGOUT_DB.prepare('UPDATE problems SET title = ?, description = ? WHERE id = ?')
    .bind(XSS_TITLE, 'Body with <b>markup</b> & "quotes".', xssId).run();
  // AI agent posts are held for review: not public, so never indexable.
  pendingId = await postProblem(agent, { title: 'Agent draft awaiting review', description: 'pending body text' });
  const other = await register('seo_private');
  privateId = await postProblem(other, { title: 'Private problem not for crawlers', description: 'private body text' });
  await env.AIHANGOUT_DB.prepare('UPDATE problems SET is_public = 0 WHERE id = ?').bind(privateId).run();

  const sol = await api(`/api/problems/${publicId}/solutions`, {
    method: 'POST', token: agent.token,
    body: { solution_text: 'Close each socket in a finally block.', code_snippet: 'try { use(s) } finally { s.destroy() }', why_explanation: 'Handles leak when an exception skips cleanup.' }
  });
  expect(sol.res.status).toBe(200);
  solutionId = sol.json.solutionId;
  solutionPublicId = sol.json.public_id;
  const accept = await api(`/api/problems/${publicId}/solutions/${solutionId}/accept`, { method: 'POST', token: asker.token, body: {} });
  expect(accept.res.status).toBe(200);
  canon = await canonicalOf(publicId);
});

describe('server-rendered problem page', () => {
  it('returns question, answers and QAPage JSON-LD in the first HTML response', async () => {
    const { res, html } = await page(canon);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Content-Security-Policy')).toMatch(/script-src 'self' 'nonce-/);
    expect(html).toContain('<h1>Socket leak under load in a Node worker pool</h1>');
    expect(html).toContain('Heap snapshots show handles piling up.');
    expect(html).toContain('Close each socket in a finally block.');
    expect(html).toContain('<strong>Accepted answer</strong>');
    expect(html).toMatch(/Answer by <a href="\/profile\/seo_agent_\d+">seo_agent_\d+<\/a> \(AI agent\)/);
    expect(html).toContain(`<link rel="canonical" href="${BASE}${canon}" />`);
    expect(html).toContain('<meta property="og:title" content="Socket leak under load in a Node worker pool | AI Hangout" />');
    expect(html).toContain('<title>Socket leak under load in a Node worker pool | AI Hangout</title>');
    expect(html).toContain('<a href="/tags/nodejs" rel="tag">nodejs</a>');
    expect(html).not.toMatch(/name="robots" content="noindex"/);

    const ld = jsonLd(html);
    expect(ld['@type']).toBe('QAPage');
    const q = ld.mainEntity;
    expect(q).toMatchObject({ '@type': 'Question', name: 'Socket leak under load in a Node worker pool', answerCount: 1 });
    expect(q.dateCreated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(q.author).toMatchObject({ '@type': 'Person', name: asker.username, url: `${BASE}/profile/${asker.username}` });
    expect(q.author.description).toBeUndefined(); // human
    expect(q.acceptedAnswer).toMatchObject({ '@type': 'Answer', url: `${BASE}${canon}#solution-${solutionPublicId}` });
    expect(q.acceptedAnswer.author.description).toBe('AI agent account');
    expect(q.acceptedAnswer.text).toContain('s.destroy()');
    expect(q.suggestedAnswer).toBeUndefined();
  });

  it('escapes hostile titles in HTML and keeps JSON-LD intact', async () => {
    const { res, html } = await page(await canonicalOf(xssId));
    expect(res.status).toBe(200);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror');
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Body with &lt;b&gt;markup&lt;/b&gt; &amp; &quot;quotes&quot;.');
    expect(jsonLd(html).mainEntity.name).toBe(XSS_TITLE); // < escaping round-trips exactly
  });

  it('pending, private and unknown problems are 404 + noindex with no content', async () => {
    for (const id of [pendingId, privateId, 987654]) {
      const { res, html } = await page(`/problem/${id}`);
      expect(res.status).toBe(404);
      expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
      expect(html).toContain('<meta name="robots" content="noindex" />');
      expect(html).not.toContain('Agent draft awaiting review');
      expect(html).not.toContain('Private problem not for crawlers');
      expect(html).not.toContain('application/ld+json');
    }
  });

  it('www host canonicalises to the apex domain', async () => {
    const { html } = await page(canon, 'https://www.aihangout.ai');
    expect(html).toContain(`<link rel="canonical" href="https://aihangout.ai${canon}" />`);
  });
});

describe('shell injection into the real frontend/index.html', () => {
  it('replaces head metadata once, keeps the app scripts and fills #root', () => {
    const html = renderIntoShell(shellHtml, {
      title: 'T <x>', description: 'D', canonical: 'https://aihangout.ai/problem/1', jsonLd: { '@type': 'QAPage' }, bodyHtml: '<main id="ssr-content">body</main>'
    });
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('<title>T &lt;x&gt;</title>');
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html.match(/property="og:title"/g)).toHaveLength(1);
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain('<div id="root"><main id="ssr-content">body</main></div>');
    expect(html).toMatch(/<script type="module"[^>]*src="\/src\/main\.tsx"/); // SPA still mounts on top
    expect(html).toContain('<meta name="viewport"');
    expect(html).toMatch(/<html lang="en"/);
  });
});

describe('sitemaps', () => {
  const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);

  it('index points at static, problem, tag and profile sitemaps', async () => {
    const res = await SELF.fetch(`${BASE}/sitemap.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/xml');
    const xml = await res.text();
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<sitemapindex xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
    expect(locs(xml)).toEqual(expect.arrayContaining([
      `${BASE}/sitemaps/static.xml`, `${BASE}/sitemaps/problems-1.xml`, `${BASE}/sitemaps/tags.xml`, `${BASE}/sitemaps/profiles-1.xml`
    ]));
  });

  it('problem sitemap lists every approved public problem and nothing else', async () => {
    const xml = await (await SELF.fetch(`${BASE}/sitemaps/problems-1.xml`)).text();
    const listed = locs(xml);
    const approved = (await env.AIHANGOUT_DB.prepare(
      "SELECT public_id, title FROM problems WHERE status IN ('open','approved') AND (is_public = 1 OR is_public IS NULL) AND (moderation_score IS NULL OR moderation_score >= 0.6) ORDER BY id"
    ).all()).results.map(r => BASE + problemPath(r));
    expect(listed).toEqual(approved);
    expect(listed).toContain(BASE + canon);
    expect(listed).not.toContain(BASE + await canonicalOf(pendingId));
    expect(listed).not.toContain(BASE + await canonicalOf(privateId));
    expect(listed.some(u => /\/problem\/\d+$/.test(u))).toBe(false); // integers stay internal
    expect(xml).toMatch(new RegExp(`<loc>${BASE}${canon}</loc><lastmod>\\d{4}-\\d{2}-\\d{2}T`));
  });

  it('chunks partition the problem set exactly (no gaps, no duplicates)', async () => {
    const db = env.AIHANGOUT_DB;
    const index = await sitemapIndex(db, BASE, 1);
    const chunkUrls = locs(index).filter(u => /problems-\d+\.xml$/.test(u));
    const all = [];
    for (let i = 1; i <= chunkUrls.length; i++) all.push(...locs(await problemsSitemap(db, BASE, i, 1)));
    const full = locs(await problemsSitemap(db, BASE, 1, 50000));
    expect(chunkUrls.length).toBe(full.length);
    expect(all).toEqual(full);
    expect(await problemsSitemap(db, BASE, chunkUrls.length + 1, 1)).toBeNull();
  });

  it('tag and profile sitemaps list public tags and contributors only', async () => {
    const tags = locs(await (await SELF.fetch(`${BASE}/sitemaps/tags.xml`)).text());
    expect(tags).toEqual(expect.arrayContaining([`${BASE}/tags/nodejs`, `${BASE}/tags/sockets`, `${BASE}/tags/parsing`]));
    const profiles = locs(await (await SELF.fetch(`${BASE}/sitemaps/profiles-1.xml`)).text());
    expect(profiles).toContain(`${BASE}/profile/${asker.username}`);
    expect(profiles).toContain(`${BASE}/profile/${agent.username}`); // answered a public problem
    expect((await SELF.fetch(`${BASE}/sitemaps/problems-999.xml`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/sitemaps/../worker.js`)).status).not.toBe(200);
  });
});

describe('robots.txt and llms.txt', () => {
  it('robots allows content, blocks private surfaces and names the sitemap', async () => {
    const res = await SELF.fetch(`${BASE}/robots.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    const txt = await res.text();
    expect(txt).toMatch(/^User-agent: \*$/m);
    expect(txt).toMatch(/^Allow: \/$/m);
    for (const p of ['/api/', '/admin', '/settings']) expect(txt).toContain(`Disallow: ${p}`);
    expect(txt).not.toMatch(/^Disallow: \/$/m);
    expect(txt).toContain(`Sitemap: ${BASE}/sitemap.xml`);
  });

  it('llms.txt follows the H1 + summary + link-list layout and names the MCP endpoint', async () => {
    const txt = await (await SELF.fetch(`${BASE}/llms.txt`)).text();
    expect(txt.split('\n')[0]).toBe('# AI Hangout');
    expect(txt).toMatch(/^> .+/m);
    expect(txt).toContain(`[MCP endpoint](${BASE}/mcp)`);
    expect(txt).toContain(`[Sitemap](${BASE}/sitemap.xml)`);
  });
});

describe('tag and profile pages', () => {
  it('tag page lists tagged public problems with CollectionPage JSON-LD; tag match is case-insensitive', async () => {
    const { res, html } = await page('/tags/sockets');
    expect(res.status).toBe(200);
    expect(html).toContain('<h1>Problems tagged sockets</h1>');
    expect(html).toContain(`<a href="${canon}">Socket leak under load in a Node worker pool</a>`);
    const ld = jsonLd(html);
    expect(ld['@type']).toBe('CollectionPage');
    expect(ld.mainEntity.itemListElement[0].url).toBe(BASE + canon);
  });

  it('empty tag page is served but noindex; feed API filters by tag', async () => {
    const { res, html } = await page('/tags/no-such-tag-anywhere');
    expect(res.status).toBe(200);
    expect(html).toContain('<meta name="robots" content="noindex" />');
    const { json } = await api('/api/problems?tag=NODEJS');
    expect(json.problems.map(p => p.id)).toEqual([publicId]);
  });

  it('profile page renders ProfilePage JSON-LD and labels AI agents', async () => {
    const { res, html } = await page(`/profile/${agent.username}`);
    expect(res.status).toBe(200);
    expect(html).toContain(`<h1>${agent.username}</h1>`);
    expect(html).toContain('AI agent account');
    const ld = jsonLd(html);
    expect(ld['@type']).toBe('ProfilePage');
    expect(ld.mainEntity).toMatchObject({ '@type': 'Person', name: agent.username, description: 'AI agent account' });
    expect(html).not.toContain('@example.test'); // never the email
    expect((await page('/profile/nobody_here_at_all')).res.status).toBe(404);
  });
});
