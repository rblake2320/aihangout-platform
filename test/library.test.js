import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import {
  validateDocumentFile, validateMeta, parseAuthors, parseRef, citationId, escapeLike, FILE_MAX_BYTES, LICENSES,
} from '../src/library.js';

// AIH-R8: white-paper library. Real routes, real D1, real R2 (workerd).
const base = 'https://aihangout.ai';
let n = 0;
const ip = () => `203.0.116.${10 + (++n % 200)}`;
const enc = (s) => new TextEncoder().encode(s);
const PDF = enc('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const MD = enc('# Title\n\nSome **markdown** body.\n');

async function register(name) {
  const res = await SELF.fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip() },
    body: JSON.stringify({ username: name, email: `${name}@example.test`, password: 'test-only-strong-password-123', ai_agent_type: 'human', accept_tos: true }),
  });
  expect(res.status).toBe(200);
  const { token, user } = await res.json();
  return { token, id: user.id };
}
async function admin(name) {
  const u = await register(name);
  await env.AIHANGOUT_DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(u.id).run();
  return u;
}

function form(fields, file) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  if (file) f.set('file', new File([file.bytes], file.name, { type: file.type }));
  return f;
}
const META = { title: 'Agent Reliability Patterns', abstract: 'How production agents fail and recover.', authors: 'Ada Lovelace, Grace Hopper', license: 'CC-BY-4.0' };
async function post(path, token, body) {
  // FormData bodies have no Content-Length header unless we materialise them
  const req = new Request(base + path, { method: 'POST', body });
  const bytes = await req.arrayBuffer();
  return SELF.fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': req.headers.get('Content-Type'), 'Content-Length': String(bytes.byteLength), 'CF-Connecting-IP': ip(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: bytes,
  });
}
const publish = (token, fields = META, file = { bytes: PDF, name: 'paper.pdf', type: 'application/pdf' }) => post('/api/library', token, form(fields, file));
const get = (path, headers = {}) => SELF.fetch(base + path, { headers: { 'CF-Connecting-IP': ip(), ...headers } });

describe('library helpers (pure)', () => {
  it('validates file content, not just the name', () => {
    expect(validateDocumentFile('a.pdf', 'application/pdf', PDF)).toMatchObject({ ok: true, ext: 'pdf' });
    expect(validateDocumentFile('a.md', 'text/markdown', MD)).toMatchObject({ ok: true, ext: 'md' });
    expect(validateDocumentFile('a.pdf', 'application/pdf', MD)).toMatchObject({ ok: false, status: 415 });
    expect(validateDocumentFile('a.pdf', 'application/pdf', enc('%PDF-1.4 truncated'))).toMatchObject({ ok: false, status: 415 });
    expect(validateDocumentFile('a.pdf', 'text/html', PDF)).toMatchObject({ ok: false, status: 415 });
    expect(validateDocumentFile('a.html', 'text/html', MD)).toMatchObject({ ok: false, status: 415 });
    expect(validateDocumentFile('a.exe', 'application/pdf', PDF)).toMatchObject({ ok: false, status: 415 });
    expect(validateDocumentFile('a.md', 'text/markdown', Uint8Array.from([0x23, 0x00, 0x41]))).toMatchObject({ ok: false, status: 415 });
    expect(validateDocumentFile('a.md', 'text/markdown', Uint8Array.from([0xff, 0xfe, 0xfd]))).toMatchObject({ ok: false, status: 415 });
    expect(validateDocumentFile('a.md', 'text/markdown', new Uint8Array(0))).toMatchObject({ ok: false, status: 400 });
    expect(validateDocumentFile('a.md', 'text/markdown', new Uint8Array(FILE_MAX_BYTES + 1).fill(65))).toMatchObject({ ok: false, status: 413 });
  });

  it('parses authors, metadata, references and citation ids', () => {
    expect(parseAuthors('A, B; C')).toEqual({ ok: true, value: ['A', 'B', 'C'] });
    expect(parseAuthors('["X","Y"]').value).toEqual(['X', 'Y']);
    expect(parseAuthors('').ok).toBe(false);
    expect(parseAuthors(Array.from({ length: 11 }, (_, i) => `a${i}`)).ok).toBe(false);
    expect(parseAuthors('[broken').ok).toBe(false);
    expect(validateMeta({ ...META, license: 'WTFPL' }, (t) => t).ok).toBe(false);
    expect(validateMeta({ ...META, title: '' }, (t) => t).ok).toBe(false);
    expect(validateMeta({ changelog: 'x' }, (t) => t, { partial: true })).toMatchObject({ ok: true, value: { changelog: 'x' } });
    expect(LICENSES).toContain('CC-BY-4.0');
    expect(parseRef('12')).toEqual({ id: 12 });
    expect(parseRef('AIH-LIB-2026-0012')).toEqual({ citation: 'AIH-LIB-2026-0012' });
    expect(parseRef('AIH-LIB-2026-0012v3')).toEqual({ citation: 'AIH-LIB-2026-0012', version: 3 });
    for (const bad of ['', 'x', '1; DROP TABLE documents', 'AIH-LIB-26-1', '-1', '../etc']) expect(parseRef(bad), bad).toBeNull();
    expect(citationId(7, 2026)).toBe('AIH-LIB-2026-0007');
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});

describe('publishing', () => {
  it('requires an admin', async () => {
    expect((await publish(null)).status).toBe(401);
    const user = await register('lib_user');
    expect((await publish(user.token)).status).toBe(403);
    expect((await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM documents').first()).n).toBe(0);
  });

  it('publishes a PDF with a citation id, stores it in R2 and lists it publicly', async () => {
    const a = await admin('lib_admin');
    const res = await publish(a.token);
    expect(res.status).toBe(201);
    const doc = (await res.json()).document;
    expect(doc.citation_id).toMatch(/^AIH-LIB-\d{4}-\d{4}$/);
    expect(doc).toMatchObject({ title: META.title, authors: ['Ada Lovelace', 'Grace Hopper'], license: 'CC-BY-4.0', latest_version: 1, download_count: 0 });
    expect(doc.versions).toHaveLength(1);
    expect(doc.versions[0]).toMatchObject({ version: 1, file_type: 'pdf', file_bytes: PDF.length });
    expect(doc.versions[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    const stored = await env.MEDIA_BUCKET.get(`library/${doc.id}/v1-${doc.versions[0].sha256.slice(0, 16)}.pdf`);
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(PDF);

    const list = await (await get('/api/library')).json();
    expect(list.documents.map((d) => d.citation_id)).toContain(doc.citation_id);
    expect(list.documents[0].versions).toEqual([]); // list view is summary only
    const byCitation = await get(`/api/library/${doc.citation_id}`);
    expect(byCitation.status).toBe(200);
    expect((await get(`/api/library/${doc.id}`)).status).toBe(200);
  });

  it('rejects bad files and metadata and leaves no document or object behind', async () => {
    const a = await admin('lib_admin2');
    const docsBefore = (await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM documents').first()).n;
    const objsBefore = (await env.MEDIA_BUCKET.list({ prefix: 'library/' })).objects.length;
    const cases = [
      [META, { bytes: MD, name: 'x.pdf', type: 'application/pdf' }, 415],         // markdown claiming to be pdf
      [META, { bytes: PDF, name: 'x.html', type: 'text/html' }, 415],
      [META, { bytes: enc('<script>alert(1)</script>'), name: 'x.md', type: 'image/svg+xml' }, 415],
      [{ ...META, license: 'WTFPL' }, { bytes: PDF, name: 'x.pdf', type: 'application/pdf' }, 400],
      [{ ...META, title: '' }, { bytes: PDF, name: 'x.pdf', type: 'application/pdf' }, 400],
      [META, null, 400],
    ];
    for (const [fields, file, status] of cases) expect((await publish(a.token, fields, file)).status, JSON.stringify(fields).slice(0, 30) + (file?.name || '')).toBe(status);
    const big = { bytes: new Uint8Array(FILE_MAX_BYTES + 1).fill(65), name: 'big.md', type: 'text/markdown' };
    expect((await publish(a.token, META, big)).status).toBe(413);
    // JSON body is not accepted on the upload route
    const json = await SELF.fetch(`${base}/api/library`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}`, 'CF-Connecting-IP': ip() }, body: '{}' });
    expect(json.status).toBe(415);
    expect((await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM documents').first()).n).toBe(docsBefore);
    expect((await env.MEDIA_BUCKET.list({ prefix: 'library/' })).objects.length).toBe(objsBefore);
  });

  it('strips markup from metadata', async () => {
    const a = await admin('lib_admin3');
    const doc = (await (await publish(a.token, { ...META, title: 'T <script>alert(1)</script><b>x</b>', abstract: 'A <img src=x onerror=alert(1)> ok' })).json()).document;
    expect(doc.title).not.toMatch(/[<>]/);
    expect(doc.abstract).not.toMatch(/[<>]/);
    expect(doc.abstract).toContain('ok');
  });
});

describe('versions, download and counts', () => {
  it('adds immutable versions, keeps old ones downloadable, and counts one download per visitor per hour', async () => {
    const a = await admin('lib_admin4');
    const doc = (await (await publish(a.token, META, { bytes: MD, name: 'p.md', type: 'text/markdown' })).json()).document;

    // new version needs a changelog and an admin
    const v2bytes = enc('# Title\n\nRevised.\n');
    const form2 = (extra) => form(extra, { bytes: v2bytes, name: 'p2.md', type: 'text/markdown' });
    expect((await post(`/api/library/${doc.citation_id}/versions`, a.token, form2({}))).status).toBe(400);
    const user = await register('lib_user2');
    expect((await post(`/api/library/${doc.citation_id}/versions`, user.token, form2({ changelog: 'x' }))).status).toBe(403);
    expect((await post('/api/library/AIH-LIB-2000-9999/versions', a.token, form2({ changelog: 'x' }))).status).toBe(404);
    const r2 = await post(`/api/library/${doc.citation_id}/versions`, a.token, form2({ changelog: 'Fixed section 2', abstract: 'Updated abstract.' }));
    expect(r2.status).toBe(201);
    const d2 = (await r2.json()).document;
    expect(d2.latest_version).toBe(2);
    expect(d2.abstract).toBe('Updated abstract.');
    expect(d2.title).toBe(META.title);
    expect(d2.versions.map((v) => v.citation_id)).toEqual([`${doc.citation_id}v1`, `${doc.citation_id}v2`]);

    const dl = async (q, headers) => get(`/api/library/${doc.citation_id}/download${q}`, headers);
    const old = await dl('?version=1', { 'CF-Connecting-IP': '198.51.100.1' });
    expect(old.status).toBe(200);
    expect(new Uint8Array(await old.arrayBuffer())).toEqual(MD);
    expect(old.headers.get('Content-Disposition')).toBe(`attachment; filename="${doc.citation_id}v1.md"`);
    expect(old.headers.get('Content-Type')).toContain('text/markdown');
    expect(old.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(old.headers.get('Content-Security-Policy')).toContain('sandbox');

    const latest = await dl('', { 'CF-Connecting-IP': '198.51.100.1' }); // no version -> latest
    expect(new Uint8Array(await latest.arrayBuffer())).toEqual(v2bytes);
    await (await dl('?version=2', { 'CF-Connecting-IP': '198.51.100.1' })).arrayBuffer(); // same visitor again
    await (await dl('?version=2', { 'CF-Connecting-IP': '198.51.100.2' })).arrayBuffer(); // different visitor

    const after = (await (await get(`/api/library/${doc.id}`)).json()).document;
    expect(after.versions.map((v) => v.download_count)).toEqual([1, 2]);
    expect(after.download_count).toBe(3);

    expect((await dl('?version=9')).status).toBe(404);
    expect((await dl('?version=abc')).status).toBe(404);
    expect((await get(`/api/library/${doc.citation_id}v1/download`)).status).toBe(200); // version in the ref
  });

  it('returns markdown text for agents on request, but never for PDFs', async () => {
    const a = await admin('lib_admin5');
    const md = (await (await publish(a.token, META, { bytes: MD, name: 'p.md', type: 'text/markdown' })).json()).document;
    const pdf = (await (await publish(a.token, META)).json()).document;
    const withText = (await (await get(`/api/library/${md.citation_id}?include=content`)).json()).document;
    expect(withText.content_md).toEqual({ version: 1, text: '# Title\n\nSome **markdown** body.\n' });
    expect((await (await get(`/api/library/${md.citation_id}`)).json()).document.content_md).toBeUndefined();
    expect((await (await get(`/api/library/${pdf.citation_id}?include=content`)).json()).document.content_md).toBeUndefined();
  });
});

describe('search and retirement', () => {
  it('searches title, abstract, author and citation id; treats % and _ literally', async () => {
    const a = await admin('lib_admin6');
    const x = (await (await publish(a.token, { ...META, title: 'Zebra Quorum Protocol', authors: 'Zed Unique' })).json()).document;
    await publish(a.token, { ...META, title: 'Plain paper', abstract: 'Mentions 100% coverage_ratio' });
    const q = async (s) => (await (await get(`/api/library?q=${encodeURIComponent(s)}`)).json());
    expect((await q('zebra quorum')).documents.map((d) => d.id)).toEqual([x.id]);
    expect((await q('Zed Unique')).documents.map((d) => d.id)).toEqual([x.id]);
    expect((await q(x.citation_id)).documents.map((d) => d.id)).toEqual([x.id]);
    expect((await q('100% coverage_ratio')).total).toBe(1);
    expect((await q('%')).total).toBe(1); // only the abstract containing a literal percent sign
    expect((await q("' OR 1=1 --")).total).toBe(0);
    expect((await q('nothing matches this')).total).toBe(0);
    expect((await get('/api/library?limit=0')).status).toBe(400);
  });

  it('retired documents disappear from list, detail and download for the public but not for admins', async () => {
    const a = await admin('lib_admin7');
    const user = await register('lib_user3');
    const doc = (await (await publish(a.token, { ...META, title: 'Soon retired xylophone' })).json()).document;
    const patch = (token, status) => SELF.fetch(`${base}/api/library/${doc.citation_id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip(), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ status }),
    });
    expect((await patch(null, 'retired')).status).toBe(401);
    expect((await patch(user.token, 'retired')).status).toBe(403);
    expect((await patch(a.token, 'deleted')).status).toBe(400);
    expect((await patch(a.token, 'retired')).status).toBe(200);
    expect((await (await get('/api/library?q=xylophone')).json()).total).toBe(0);
    expect((await get(`/api/library/${doc.citation_id}`)).status).toBe(404);
    expect((await get(`/api/library/${doc.citation_id}/download`)).status).toBe(404);
    expect((await get(`/api/library/${doc.citation_id}`, { Authorization: `Bearer ${a.token}` })).status).toBe(200);
    expect((await patch(a.token, 'published')).status).toBe(200);
    expect((await get(`/api/library/${doc.citation_id}`)).status).toBe(200);
  });
});

describe('MCP tools search_documents and get_document', () => {
  const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  let rid = 0;
  const tool = async (token, name, args) => {
    const res = await SELF.fetch(`${base}/mcp`, {
      method: 'POST', headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}`, 'CF-Connecting-IP': ip() },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    return (await res.json()).result;
  };

  it('search_documents finds papers, pages with an opaque cursor, and get_document returns versions and markdown text', async () => {
    const a = await admin('lib_admin8');
    const reader = await register('lib_agent');
    const mk = async (title, bytes = MD, name = 'p.md', type = 'text/markdown') =>
      (await (await publish(a.token, { ...META, title }, { bytes, name, type })).json()).document;
    const d1 = await mk('Mcp findable gamma one');
    await mk('Mcp findable gamma two');
    await mk('Mcp findable gamma three');

    const page1 = (await tool(reader.token, 'search_documents', { query: 'findable gamma', limit: 2 })).structuredContent;
    expect(page1.documents).toHaveLength(2);
    expect(page1.total).toBe(3);
    expect(page1.next_cursor).toBeTruthy();
    const page2 = (await tool(reader.token, 'search_documents', { query: 'findable gamma', limit: 2, cursor: page1.next_cursor })).structuredContent;
    expect(page2.documents).toHaveLength(1);
    expect(page2.next_cursor).toBeNull();
    const ids = [...page1.documents, ...page2.documents].map((d) => d.id);
    expect(new Set(ids).size).toBe(3);
    expect(page1.documents[0]).not.toHaveProperty('versions');

    const got = (await tool(reader.token, 'get_document', { ref: d1.citation_id, include_content: true })).structuredContent.document;
    expect(got).toMatchObject({ citation_id: d1.citation_id, license: 'CC-BY-4.0' });
    expect(got.versions[0].download_url).toBe(`/api/library/${d1.citation_id}/download?version=1`);
    expect(got.content_md.text).toContain('Some **markdown** body.');

    const noText = (await tool(reader.token, 'get_document', { ref: String(d1.id) })).structuredContent.document;
    expect(noText.content_md).toBeUndefined();

    const missing = await tool(reader.token, 'get_document', { ref: 'AIH-LIB-2000-9999' });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent.error.code).toBe('NOT_FOUND');
    const bad = await tool(reader.token, 'get_document', { ref: '1; DROP TABLE documents' });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.error.code).toBe('NOT_FOUND');
  });
});
