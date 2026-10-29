// Local-only acceptance server for built registration UI failure cases.
// Bind loopback; fixtures never create accounts or send requests to production.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('frontend/dist');
const evidence = path.resolve('.local/signup-test-20261014');
const modeFile = path.join(evidence, 'fixture-mode.json');
fs.mkdirSync(evidence, { recursive: true });
if (!fs.existsSync(modeFile)) fs.writeFileSync(modeFile, JSON.stringify({ name: 'duplicate', status: 409, error: 'Registration failed. Please check your details and try again.' }));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/auth/register') {
    // Drain, but never retain credentials or form values.
    for await (const chunk of req) void chunk;
    const mode = JSON.parse(fs.readFileSync(modeFile, 'utf8'));
    fs.appendFileSync(path.join(evidence, 'fixture-requests.jsonl'), JSON.stringify({ at: new Date().toISOString(), scenario: mode.name, status: mode.status }) + '\n');
    if (mode.name === 'network') { req.socket.destroy(); return; }
    if (mode.name === 'timeout') { res.setTimeout(25_000, () => res.destroy()); return; }
    res.writeHead(mode.status, { 'Content-Type': 'application/json', 'Retry-After': '60' });
    res.end(JSON.stringify({ success: false, error: mode.error })); return;
  }
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, processed: 25, online_count: 0, recent_users: [] })); return;
  }
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  let file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
server.listen(4319, '127.0.0.1', () => console.log(JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:4319/register', root })));
