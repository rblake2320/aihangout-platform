#!/usr/bin/env node
// Accessibility check: runs axe-core (WCAG 2.0/2.1/2.2 A and AA) over the public routes of a built frontend and
// exits 1 on any violation. Serves the build with a stubbed API, so it checks logged-out UI structure and colour only.
// Not covered: real data, signed-in screens, keyboard and screen-reader behaviour, mobile widths.
//
//   npm i --no-save axe-core@4.10.2
//   (cd frontend && npx vite build --outDir /tmp/a11y-dist --emptyOutDir)
//   node scripts/a11y-check.mjs /tmp/a11y-dist [comma,separated,routes]      (CHROME_PATH overrides the browser)
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const DIST = process.argv[2];
if (!DIST) { console.error('usage: node scripts/a11y-check.mjs <built-frontend-dir> [routes]'); process.exit(2); }
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const ROUTES = (process.argv[3] || '/,/learning,/problem-bank,/pathbooks,/login,/register,/changelog,/terms,/privacy').split(',');
const chromePath = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, problems: [], items: [], categories: [], pathbooks: [], total: 0, data: [], entries: [], stats: {} }));
    return;
  }
  let file = path.join(DIST, url.pathname);
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(path.join(tmpdir(), 'axe-'));
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let wsUrl = '';
for (let i = 0; i < 100 && !wsUrl; i++) {
  await sleep(100);
  const f = path.join(profile, 'DevToolsActivePort');
  if (existsSync(f)) { const [port, p] = readFileSync(f, 'utf8').trim().split('\n'); wsUrl = `ws://127.0.0.1:${port}${p}`; }
}
const ws = new WebSocket(wsUrl);
await new Promise(r => { ws.onopen = r; });
let id = 1; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const cdp = (m, p) => send(m, p, sessionId);
await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

const summary = {};
let total = 0;
for (const route of ROUTES) {
  await cdp('Page.navigate', { url: origin + route });
  await sleep(1800);
  await cdp('Runtime.evaluate', { expression: AXE });
  const r = await cdp('Runtime.evaluate', {
    awaitPromise: true, returnByValue: true,
    expression: `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] } }).then(x => x.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target.join(' '), html: n.html.slice(0, 160), msg: (n.any[0]||n.all[0]||n.none[0]||{}).message })) })))`
  });
  const v = r.result.value || [];
  summary[route] = v;
  total += v.reduce((n, x) => n + x.nodes.length, 0);
  console.log(`\n== ${route}  ${v.length ? v.map(x => `${x.id}(${x.nodes.length})`).join(', ') : 'no violations'}`);
  for (const x of v) for (const n of x.nodes.slice(0, 8)) console.log(`   [${x.id}] ${n.target}\n      ${n.html}\n      ${n.msg || ''}`);
}
try { chrome.kill(); } catch {}
server.close(); await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
console.log(total ? `\n${total} accessibility violation(s).` : '\nNo accessibility violations on any checked route.');
process.exit(total ? 1 : 0);
