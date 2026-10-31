#!/usr/bin/env node
// Start a throwaway `wrangler dev` (fresh local D1 + KV in a temp dir, real migrations), run
// the capture gate against it, then stop it. A fresh store matters: signup is rate limited per
// IP (5/min, 20/h) and the scenarios register new users, so a reused store goes red on 429.
//
//   node scripts/capture-gate-local.mjs [--port N (default: a free port)] [capture-gate args, e.g. --baseline <dir> --out <dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
});
let port = await freePort();
const pi = argv.indexOf('--port');
if (pi >= 0) { port = Number(argv[pi + 1]); argv.splice(pi, 2); }
const origin = `http://127.0.0.1:${port}`;
const isWin = process.platform === 'win32';
const npx = isWin ? 'npx.cmd' : 'npx';
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-state-'));

const run = (args, opts = {}) => spawnSync(npx, args, { cwd: root, stdio: 'inherit', shell: isWin, ...opts });

function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

async function waitHealthy(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} not healthy after ${ms}ms`);
}

let dev;
let code = 2;
try {
  const stale = await fetch(`${origin}/api/health`).then(() => true, () => false);
  if (stale) throw new Error(`something is already serving ${origin}; refusing to gate against a server with unknown state (stop it or pass --port)`);
  const mig = run(['wrangler', 'd1', 'migrations', 'apply', 'aihangout-dev', '--local', '--env', 'development', '--persist-to', state]);
  if (mig.status !== 0) throw new Error(`migrations failed (exit ${mig.status})`);
  // Run wrangler's JS entry directly (no shell/npx wrapper) so the pid we kill owns workerd.
  dev = spawn(process.execPath, [path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'dev', '--env', 'development', '--local', '--port', String(port), '--inspector-port', String(await freePort()),
    '--persist-to', state, '--var', 'JWT_SECRET:gate-local-secret-32-chars-xxxxxx'], { cwd: root, stdio: 'ignore', windowsHide: true });
  await waitHealthy(`${origin}/api/health`, 90_000);
  const gate = spawnSync(process.execPath, [path.join(root, 'scripts', 'capture-gate.mjs'), '--origin', origin, '--slug', 'local', '--pause-ms', '15000', ...argv],
    { cwd: root, stdio: 'inherit' });
  code = gate.status ?? 2;
} catch (e) {
  console.error(`capture-gate-local error: ${e.message}`);
} finally {
  stop(dev);
  fs.rmSync(state, { recursive: true, force: true });
}
process.exit(code);
