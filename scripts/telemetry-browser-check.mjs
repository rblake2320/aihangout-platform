#!/usr/bin/env node
// Repeatable real-browser check for the session-telemetry client.
//
// Bundles frontend/src/telemetry with esbuild, serves it from a loopback fixture page,
// drives headless Chrome over the DevTools protocol (no extra dependencies) and asserts on
// exactly what the browser sent. Exits non-zero on any failed assertion.
//
//   npm run test:browser          (CHROME_PATH overrides browser discovery)
//
// What this proves that the workerd suite cannot: the DOM wiring (listeners, history/XHR
// patching, pagehide + visibilitychange, sendBeacon on unload) runs in a real browser, and
// typed values never appear in any request.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET_PASSWORD = 'hunter2-browser-secret';
const SECRET_EMAIL = 'typed.person@example.test';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find(p => existsSync(p));
if (!chromePath) {
  console.error('FAIL: no Chrome/Chromium/Edge found. Set CHROME_PATH.');
  process.exit(2);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- fixture app ---------------------------------------------------------------------
const bundle = await build({
  stdin: {
    contents: `import { createTelemetry } from './frontend/src/telemetry/index.ts'
      window.__tel = createTelemetry({ getToken: () => null,
        config: { batch: { flushIntervalMs: 400, maxEvents: 6, maxBytes: 48000, maxQueue: 500 } } })
      window.__tel.start()`,
    resolveDir: root, sourcefile: 'entry.ts', loader: 'ts',
  },
  bundle: true, format: 'iife', write: false, logLevel: 'silent',
});
const appJs = bundle.outputFiles[0].text;

const page = title => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
<h1>${title}</h1>
<button id="rage" type="button">rage me</button>
<button id="dead" type="button">dead</button>
<form id="login" onsubmit="return false"><input name="email" id="em"><input name="pw" type="password" id="pw" autocomplete="current-password"><button type="submit">go</button></form>
<a id="nav" href="/second">second</a>
<div style="height:3000px">tall</div>
<script src="/app.js"></script></body></html>`;

const posts = [];
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/analytics/batch') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      posts.push({ contentType: req.headers['content-type'], body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"success":true}');
    });
    return;
  }
  if (req.url === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(appJs); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page(req.url === '/second' ? 'second' : 'first'));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---- Chrome over CDP -----------------------------------------------------------------
const profile = mkdtempSync(path.join(tmpdir(), 'tel-check-'));
const chrome = spawn(chromePath, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
], { stdio: 'ignore' });

async function cleanup() {
  try { chrome.kill(); } catch { /* already gone */ }
  server.close();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* chrome may still hold files */ }
}

let wsUrl = '';
for (let i = 0; i < 100 && !wsUrl; i++) {
  await sleep(100);
  const f = path.join(profile, 'DevToolsActivePort');
  if (existsSync(f)) {
    const [port, p] = readFileSync(f, 'utf8').trim().split('\n');
    wsUrl = `ws://127.0.0.1:${port}${p}`;
  }
}
if (!wsUrl) { await cleanup(); console.error('FAIL: Chrome did not expose a DevTools port.'); process.exit(2); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('websocket error')); });
let nextId = 1;
const pending = new Map();
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(`${msg.error.message}`)) : res(msg.result);
  }
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
};

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (m, p) => send(m, p, sessionId);
  const evalJs = async expr => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

  const center = sel => evalJs(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`);
  const click = async (sel, count = 1) => {
    const { x, y } = await center(sel);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (let i = 1; i <= count; i++) {
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: i });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: i });
    }
  };
  const type = async (sel, text) => {
    await evalJs(`document.querySelector(${JSON.stringify(sel)}).focus()`);
    await cdp('Input.insertText', { text });
  };

  await cdp('Page.navigate', { url: `${origin}/` });
  await sleep(900);
  await click('#rage', 6);          // rage: 6 fast clicks on one target
  await click('#dead');             // dead: nothing happens
  await sleep(1600);
  await type('#em', SECRET_EMAIL);  // form touched, then abandoned by navigating away
  await type('#pw', SECRET_PASSWORD);
  await click('#nav');              // unload -> pagehide + visibilitychange -> beacon
  await sleep(1800);
} catch (err) {
  failures.push(`driver error: ${err.message}`);
  console.error(err);
}

// ---- assertions ----------------------------------------------------------------------
const events = posts.flatMap(p => { try { return JSON.parse(p.body).events; } catch { return []; } });
const of = (type, route) => events.filter(e => e.type === type && (!route || e.route === route));
const raw = posts.map(p => p.body).join('\n');

check('received telemetry batches', posts.length > 0, `${posts.length} batches, ${events.length} events`);
check('page_view on /', of('page_view', '/').length === 1);
check('rage_click on #rage with count >= 5', of('rage_click').some(e => e.data.selector === 'button#rage' && e.data.count >= 5));
check('dead_click on #dead', of('dead_click').some(e => e.data.selector === 'button#dead'));
const abandon = of('form_abandon');
check('form_abandon names only the email field (password excluded)', abandon.length === 1 && abandon[0].data.fields_touched === 1 && abandon[0].data.last_field === 'email', JSON.stringify(abandon[0]?.data));
const leaves = of('page_leave', '/');
check('exactly one page_leave on / (pagehide + visibilitychange must not double-count)', leaves.length === 1, `${leaves.length}`);
check('page_leave reports scroll depth > 0', (leaves[0]?.data.scroll_max_pct ?? 0) > 0, `${leaves[0]?.data.scroll_max_pct}%`);
check('page_view on /second after navigation', of('page_view', '/second').length >= 1);
check('unload batch used sendBeacon (text/plain)', posts.some(p => (p.contentType || '').startsWith('text/plain') && p.body.includes('page_leave')));
check('typed password never sent', !raw.includes(SECRET_PASSWORD));
check('typed email never sent', !raw.includes(SECRET_EMAIL) && !raw.includes('typed.person'));

await cleanup();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll real-browser telemetry checks passed.');
