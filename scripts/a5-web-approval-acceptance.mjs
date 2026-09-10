#!/usr/bin/env node
// Finite web-approval acceptance for the mobile companion (A5-owned acceptance
// prep). Drives the REAL backend over HTTP with a synthetic device (P-256 key,
// same challenge/sign contract the Android client uses) up to the point where a
// HUMAN must act on the web approval page, then polls the readback and prints
// the final state. It never approves or denies by itself -- that click is the
// thing under test.
//
// Usage:
//   node scripts/a5-web-approval-acceptance.mjs <operator-private.json> [capability]
// operator-private.json is written by scripts/prepare-local-mobile-acceptance.ps1
// (base_url, email, password, package_name, signing_cert_sha256). For a deployed
// staging run, hand-write the same JSON for a disposable staging test account.
//
// Exit codes: 0 = readback reached a terminal state (approved/denied/expired),
// 2 = enrollment/intent refused, 3 = timeout waiting for the human decision.
import { readFileSync, writeFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const [,, privatePath, capabilityArg] = process.argv;
if (!privatePath) { console.error('usage: a5-web-approval-acceptance.mjs <operator-private.json> [capability]'); process.exit(2); }
const op = JSON.parse(readFileSync(privatePath, 'utf8'));
const base = op.base_url.replace(/\/$/, '');
const capability = capabilityArg || 'battery_status_read';
const receipt = { gate: 'a5-web-approval-acceptance', base_url: base, capability, steps: [], started_utc: new Date().toISOString() };
const b64 = data => Buffer.from(new Uint8Array(data)).toString('base64');

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
function step(name, r, ok) {
  receipt.steps.push({ name, status: r.status, ok, sample: JSON.stringify(r.json).slice(0, 200) });
  console.log(`${ok ? 'OK ' : 'ERR'} ${name} -> ${r.status}`);
  if (!ok) { receipt.result = 'refused_at_' + name; finish(2); }
}
function finish(code) { receipt.finished_utc = new Date().toISOString(); writeFileSync(privatePath.replace(/[^\\/]+$/, 'a5-web-approval-acceptance-receipt.json'), JSON.stringify(receipt, null, 2)); process.exit(code); }

// 1. Login (API, disposable local/staging test account -- never a real user).
const login = await api('/api/auth/login', { method: 'POST', body: { email: op.email, password: op.password } });
step('login', login, login.status === 200 && !!login.json?.token);
const token = login.json.token;

// 2. Enrollment: real Gate-2 challenge/response with a fresh P-256 key.
const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const claims = {
  agentName: `a5-web-acceptance-${Date.now().toString(36)}`,
  publicKeySpki: b64(await crypto.subtle.exportKey('spki', keys.publicKey)),
  packageName: op.package_name,
  signingCertSha256: op.signing_cert_sha256,
};
const challenge = await api('/api/mobile/devices/challenge', { method: 'POST', token, body: claims });
step('challenge', challenge, challenge.status === 200 && !!challenge.json?.signingPayload);
const signature = b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(challenge.json.signingPayload)));
const enroll = await api('/api/mobile/devices/enroll', { method: 'POST', token, body: { ...claims, challengeId: challenge.json.challengeId, signature } });
step('enroll', enroll, enroll.status === 200 && !!enroll.json?.deviceId);
const deviceId = enroll.json.deviceId;

// 3. One intent -> this is what the human sees on the web page.
const intent = await api('/api/mobile/actions/intent', { method: 'POST', token, body: {
  deviceId, capability, targetDescription: 'A5 web-approval acceptance: read battery state', idempotencyKey: `a5-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
} });
step('intent', intent, intent.status === 200 && !!intent.json?.actionId);
const actionId = intent.json.actionId;
receipt.actionId = actionId; receipt.actionDigest = intent.json.actionDigest; receipt.riskTier = intent.json.riskTier;
receipt.approval_url = `${base}/mobile-approvals/${actionId}`;
// The web app keeps auth in localStorage; for a browser session that is not
// already logged in as this account, the operator can inject this token
// (see report) instead of typing the disposable password into a form.
receipt.browser_token_hint = 'inject login token into the web app auth store for this origin, then open approval_url';
console.log(`\nHUMAN STEP -> open ${receipt.approval_url} as ${op.email} and click Approve or Deny.`);
console.log(`token (disposable test account, local/staging only): ${token}\n`);

// 4. Poll the readback until a terminal decision (or timeout). Never decides itself.
const deadline = Date.now() + 10 * 60 * 1000;
let last = null;
while (Date.now() < deadline) {
  const rb = await api(`/api/mobile/actions/${actionId}`, { token });
  last = rb.json;
  const s = rb.json?.intent?.status;
  if (s && s !== 'awaiting_approval') {
    receipt.final_status = s; receipt.readback = rb.json; receipt.result = 'terminal';
    console.log(`readback: status=${s} approved_digest=${rb.json.approval?.approved_digest ?? null}`);
    if (s === 'approved' && rb.json.approval?.approved_digest !== intent.json.actionDigest) { console.log('MISMATCH: approved_digest != actionDigest'); receipt.result = 'digest_mismatch'; finish(2); }
    finish(0);
  }
  await new Promise(r => setTimeout(r, 3000));
}
receipt.result = 'timeout_awaiting_human'; receipt.readback = last; finish(3);
