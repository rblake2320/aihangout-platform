// Pure (no network, no fs) extraction + diff logic for scripts/bundle-recon.mjs.
// Kept separate so vitest can import it inside workerd.
import { createHash } from 'node:crypto';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const uniqSorted = (arr) => [...new Set(arr)].sort();

// Hosts that appear as inert strings in React/Vite/vendor code and are not
// network destinations the app contacts.
const NOISE_HOSTS = new Set([
  'www.w3.org', 'w3.org', 'github.com', 'reactjs.org', 'react.dev', 'localhost',
  'local.invalid', 'example.com', 'example.org', 'json-schema.org', 'reactrouter.com',
]);

const SUSPICIOUS_PATTERNS = [
  ['jwt', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.?[A-Za-z0-9_-]*/g],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/g],
  ['stripe-key', /sk_(?:live|test)_[A-Za-z0-9]{10,}/g],
  ['openai-style-key', /sk-[A-Za-z0-9]{20,}/g],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{30,}/g],
  ['slack-token', /xox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['google-api-key', /AIza[0-9A-Za-z_-]{35}/g],
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['private-ipv4', /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g],
  // Must follow a quote, @ or // so property access like `this.internal` is not a host.
  ['internal-hostname', /(?<=["'`@]|\/\/)[a-z0-9-]{2,}(?:\.[a-z0-9-]+)*\.(?:internal|lan|corp|intranet)\b/g],
  [
    'credential-assignment',
    /\b(?:secret|api[_-]?key|passw(?:or)?d|private[_-]?key|client[_-]?secret|auth[_-]?token)["']?\s*[:=]\s*["'`]([A-Za-z0-9+/_=-]{16,})["'`]/gi,
  ],
];

/** Redact a matched value: keep kind, length, hash, and a 4-char prefix only. */
function redact(value) {
  return { len: value.length, sha256: sha256(value).slice(0, 16), prefix: value.slice(0, 4) };
}

/** Pure extractor over one JS/HTML text. Exported for tests. */
export function extractFromText(text) {
  const normPath = (p) => p.replace(/\$\{[^}]*\}/g, '{}').replace(/[?#].*$/, '');
  const apiRoutes = new Set();
  const clientCalls = new Set();
  const pageRoutes = new Set();
  const hosts = new Set();
  const storageKeys = new Set();
  const flags = new Set();
  const emails = new Set();
  const adminGuards = [];
  const suspicious = [];

  for (const m of text.matchAll(/["'`](\/api\/[A-Za-z0-9_\-./${}:]*)/g)) apiRoutes.add(normPath(m[1]));

  // axios-style relative calls: client.get("/x"), .post(`/x/${id}`)
  for (const m of text.matchAll(/\.(get|post|put|patch|delete)\(\s*["'`](\/[A-Za-z0-9_\-./${}:]*)/g)) {
    clientCalls.add(`${m[1].toUpperCase()} ${normPath(m[2])}`);
  }
  const baseUrls = uniqSorted([...text.matchAll(/baseURL\s*:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]));

  for (const m of text.matchAll(/\bpath\s*:\s*["'`](\/?[A-Za-z0-9_\-/:*]*)["'`]/g)) {
    if (m[1]) pageRoutes.add(m[1].startsWith('/') ? m[1] : `/${m[1]}`);
  }

  for (const m of text.matchAll(/\b(https?|wss?):\/\/([A-Za-z0-9.-]+)(?::\d+)?/g)) {
    const host = m[2].replace(/\.$/, '').toLowerCase();
    if (NOISE_HOSTS.has(host)) continue;
    // Private/internal destinations must never be written verbatim into a committed baseline.
    const isPrivate = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|127\.)/.test(host) || /\.(?:internal|lan|corp|intranet)$/.test(host);
    hosts.add(isPrivate ? `${m[1]}://private-host:${sha256(host).slice(0, 12)}` : `${m[1]}://${host}`);
  }

  for (const m of text.matchAll(/(?:local|session)Storage\.(?:get|set|remove)Item\(\s*["'`]([^"'`]+)["'`]/g)) {
    storageKeys.add(m[1]);
  }
  for (const m of text.matchAll(/\bname\s*:\s*["'`](ai-hangout-[A-Za-z0-9_-]+)["'`]/g)) storageKeys.add(m[1]);

  for (const m of text.matchAll(/\bVITE_[A-Z0-9_]+\b|import\.meta\.env\.[A-Z0-9_]+/g)) flags.add(m[0]);
  for (const m of text.matchAll(/\b(?:enable|disable|feature|flag)[A-Z][A-Za-z0-9]*\s*[:=]\s*(?:!0|!1|true|false)/g)) {
    flags.add(m[0].replace(/\s+/g, ''));
  }

  for (const m of text.matchAll(/[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,}/g)) {
    const e = m[0].replace(/\.$/, '').toLowerCase();
    if (!/^(name|user|you)@example\./.test(e)) emails.add(e);
  }

  for (const m of text.matchAll(/\bis_?[aA]dmin\b/g)) {
    const ctx = text.slice(Math.max(0, m.index - 60), m.index + 80).replace(/\s+/g, ' ');
    adminGuards.push({ sha256: sha256(ctx).slice(0, 16), context: ctx });
  }

  for (const [kind, re] of SUSPICIOUS_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const value = m[1] ?? m[0];
      suspicious.push({ kind, ...redact(value) });
    }
  }

  const sourceMapRefs = uniqSorted([...text.matchAll(/\/\/[#@]\s*sourceMappingURL=(\S+)/g)].map((m) => m[1]));
  const adminRoutes = uniqSorted([
    ...[...apiRoutes].filter((r) => /\/admin/i.test(r)),
    ...[...clientCalls].filter((r) => /\/admin/i.test(r)).map((r) => r.replace(/^[A-Z]+ /, '/api')),
    ...[...pageRoutes].filter((r) => /\/admin/i.test(r)),
  ]);

  return {
    apiRoutes: uniqSorted(apiRoutes),
    clientCalls: uniqSorted(clientCalls),
    baseUrls,
    pageRoutes: uniqSorted(pageRoutes),
    adminRoutes,
    externalHosts: uniqSorted(hosts),
    storageKeys: uniqSorted(storageKeys),
    flags: uniqSorted(flags),
    emails: uniqSorted(emails),
    adminGuards,
    suspicious,
    sourceMapRefs,
  };
}

export function mergeInventories(parts) {
  const out = {
    apiRoutes: [], clientCalls: [], baseUrls: [], pageRoutes: [], adminRoutes: [], externalHosts: [],
    storageKeys: [], flags: [], emails: [], sourceMapRefs: [],
  };
  const suspicious = new Map();
  const adminGuards = new Map();
  for (const { asset, inv } of parts) {
    for (const k of Object.keys(out)) out[k].push(...inv[k]);
    for (const s of inv.suspicious) suspicious.set(`${s.kind}:${s.sha256}`, { ...s, asset });
    for (const g of inv.adminGuards) adminGuards.set(g.sha256, { ...g, asset });
  }
  for (const k of Object.keys(out)) out[k] = uniqSorted(out[k]);
  out.suspicious = [...suspicious.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, v]) => ({ id, ...v }));
  out.adminGuards = [...adminGuards.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
  return out;
}

/** Asset URLs referenced by index.html. */
export function assetRefsFromHtml(html) {
  return uniqSorted(
    [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"'#?]+\.(?:js|css|mjs))["']/g)].map((m) => m[1]),
  );
}

/** Chunk files referenced from inside a JS asset (relative or hashed names). */
export function chunkRefsFromJs(text) {
  const refs = new Set();
  for (const m of text.matchAll(/["'`]\.\/([A-Za-z0-9_.-]+\.(?:js|css|mjs))["'`]/g)) refs.add(`/assets/${m[1]}`);
  for (const m of text.matchAll(/["'`]\/assets\/([A-Za-z0-9_.-]+\.(?:js|css|mjs))["'`]/g)) refs.add(`/assets/${m[1]}`);
  for (const m of text.matchAll(/(?<![A-Za-z0-9_.-])([A-Za-z0-9_.]+(?:-[A-Za-z0-9_]+)*-[A-Za-z0-9_-]{8}\.(?:js|css))\b/g)) refs.add(`/assets/${m[1]}`);
  return [...refs];
}

/** A real source map is JSON with a "mappings" key; SPA fallbacks return HTML 200. */
export function isRealSourceMap(contentType, body) {
  if (/html/i.test(contentType || '')) return false;
  try {
    const j = JSON.parse(body);
    return typeof j === 'object' && j !== null && ('mappings' in j || 'sections' in j);
  } catch {
    return false;
  }
}


const LIST_KEYS = ['apiRoutes', 'clientCalls', 'pageRoutes', 'adminRoutes', 'externalHosts', 'storageKeys', 'flags', 'emails', 'sourceMapRefs'];

export function diffRecon(prev, next) {
  const out = { added: {}, removed: {}, newSuspicious: [], newAdminRoutes: [], newSourceMaps: [] };
  for (const k of LIST_KEYS) {
    const a = new Set(prev.inventory[k] || []);
    const b = new Set(next.inventory[k] || []);
    const add = [...b].filter((x) => !a.has(x));
    const rem = [...a].filter((x) => !b.has(x));
    if (add.length) out.added[k] = add;
    if (rem.length) out.removed[k] = rem;
  }
  const prevSusp = new Set((prev.inventory.suspicious || []).map((s) => s.id));
  out.newSuspicious = (next.inventory.suspicious || []).filter((s) => !prevSusp.has(s.id));
  out.newAdminRoutes = out.added.adminRoutes || [];
  const prevMaps = new Set((prev.assets || []).filter((a) => a.sourceMapExposed).map((a) => a.path));
  out.newSourceMaps = (next.assets || []).filter((a) => a.sourceMapExposed && !prevMaps.has(a.path)).map((a) => a.path);
  out.fail = out.newSuspicious.length > 0 || out.newAdminRoutes.length > 0 || out.newSourceMaps.length > 0;
  return out;
}

