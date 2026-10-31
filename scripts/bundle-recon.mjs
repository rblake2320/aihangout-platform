#!/usr/bin/env node
// Repeatable bundle recon: fetch the served index + assets of an origin (or a
// local dist directory), extract a deterministic inventory, write
// recon/<origin>/<date>.json, and optionally diff against a previous run.
//
//   node scripts/bundle-recon.mjs https://aihangout.ai
//   node scripts/bundle-recon.mjs --dist frontend/dist --label local-dist
//   node scripts/bundle-recon.mjs <origin|--dist dir> --diff recon/<origin>/<prev>.json
//
// Exit codes: 0 ok, 1 usage/fetch error, 2 diff found new suspicious literals
// or new admin routes.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assetRefsFromHtml, chunkRefsFromJs, diffRecon, extractFromText, isRealSourceMap, mergeInventories, sha256 } from './lib/bundle-extract.mjs';
export { extractFromText, assetRefsFromHtml, chunkRefsFromJs, isRealSourceMap, diffRecon };

async function fetchBytes(base, path) {
  const res = await fetch(new URL(path, base), { headers: { 'user-agent': 'aih-bundle-recon/1.0' } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type') || '', buf };
}

export async function recon(base) {
  const index = await fetchBytes(base, '/');
  if (index.status !== 200) throw new Error(`GET ${base} -> ${index.status}`);
  const indexText = index.buf.toString('utf8');
  const queue = assetRefsFromHtml(indexText);
  const seen = new Set();
  const assets = [];
  const parts = [{ asset: 'index.html', inv: extractFromText(indexText) }];
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const r = await fetchBytes(base, path);
    if (r.status !== 200 || /html/i.test(r.type)) {
      assets.push({ path, status: r.status, missing: true });
      continue;
    }
    const text = r.buf.toString('utf8');
    const map = await fetchBytes(base, `${path}.map`);
    const mapExposed = isRealSourceMap(map.type, map.buf.toString('utf8'));
    assets.push({ path, status: r.status, bytes: r.buf.length, sha256: sha256(r.buf), sourceMapExposed: mapExposed });
    if (path.endsWith('.js') || path.endsWith('.mjs')) {
      parts.push({ asset: path, inv: extractFromText(text) });
      for (const c of chunkRefsFromJs(text)) if (!seen.has(c)) queue.push(c);
    }
  }
  assets.sort((a, b) => a.path.localeCompare(b.path));
  return {
    schema: 'bundle-recon/1',
    origin: new URL(base).origin,
    fetchedAt: new Date().toISOString(),
    index: { sha256: sha256(index.buf), bytes: index.buf.length },
    assets,
    inventory: mergeInventories(parts),
  };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

/** Serve a built dist directory with SPA fallback to index.html (matches the live behaviour). */
export function serveDist(dir) {
  const root = resolve(dir);
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(root, urlPath));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    } catch {
      file = join(root, 'index.html');
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

function parseArgs(argv) {
  const o = { origin: null, dist: null, diff: null, out: 'recon', label: null, write: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dist') o.dist = argv[++i];
    else if (a === '--diff') o.diff = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--label') o.label = argv[++i];
    else if (a === '--no-write') o.write = false;
    else if (!a.startsWith('--') && !o.origin) o.origin = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.origin && !o.dist) throw new Error('usage: bundle-recon.mjs <origin> | --dist <dir> [--label name] [--diff prev.json] [--out dir] [--no-write]');
  return o;
}

/** --diff accepts a file, or a directory (latest <date>.json inside it). */
async function resolveDiffFile(p) {
  if (!(await stat(p)).isDirectory()) return p;
  const names = (await readdir(p)).filter((n) => n.endsWith('.json')).sort();
  if (!names.length) throw new Error(`no .json baseline in ${p}`);
  return join(p, names[names.length - 1]);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  let served = null;
  let base = o.origin;
  if (o.dist) {
    if (!existsSync(join(o.dist, 'index.html'))) throw new Error(`no index.html in ${resolve(o.dist)}`);
    served = await serveDist(o.dist);
    base = served.url;
  }
  let result;
  try {
    result = await recon(base);
  } finally {
    served?.server.close();
  }
  if (o.dist) result.origin = o.label || 'local-dist';
  const slug = (o.label || result.origin).replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9.-]/g, '_');
  const file = join(o.out, slug, `${result.fetchedAt.slice(0, 10)}.json`);
  if (o.write) {
    await mkdir(join(o.out, slug), { recursive: true });
    await writeFile(file, JSON.stringify(result, null, 2) + '\n');
    console.log(`wrote ${file}`);
  }
  const inv = result.inventory;
  console.log(`assets=${result.assets.length} api=${inv.apiRoutes.length} calls=${inv.clientCalls.length} admin=${inv.adminRoutes.length} hosts=${inv.externalHosts.length} suspicious=${inv.suspicious.length}`);
  if (o.diff) {
    const prev = JSON.parse(await readFile(await resolveDiffFile(o.diff), 'utf8'));
    const d = diffRecon(prev, result);
    for (const [k, v] of Object.entries(d.added)) console.log(`+ ${k}: ${v.join(', ')}`);
    for (const [k, v] of Object.entries(d.removed)) console.log(`- ${k}: ${v.join(', ')}`);
    for (const s of d.newSuspicious) console.error(`NEW SUSPICIOUS ${s.kind} ${s.asset} len=${s.len} sha256=${s.sha256}`);
    for (const r of d.newAdminRoutes) console.error(`NEW ADMIN ROUTE ${r}`);
    for (const r of d.newSourceMaps) console.error(`NEW EXPOSED SOURCE MAP ${r}`);
    if (d.fail) process.exit(2);
    console.log('diff: no new suspicious literals, admin routes or source maps');
  } else if (inv.suspicious.length) {
    for (const s of inv.suspicious) console.error(`SUSPICIOUS ${s.kind} ${s.asset} len=${s.len} sha256=${s.sha256}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(`bundle-recon: ${e.message}`);
    process.exit(1);
  });
}
