// Actual source modules, with deterministic browser/network boundaries.
// No production requests or messages are made by this unit harness.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transform } from 'esbuild';

const baselineArg = process.argv.find(arg => arg === '--baseline' || arg.startsWith('--baseline='));
const baseline = baselineArg ? baselineArg.split('=')[1] || 'HEAD' : null;
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
async function load(file, globals, imports) {
  const source = baseline ? execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' }) : readFileSync(file, 'utf8');
  const { code } = await transform(source, { loader: file.endsWith('tsx') ? 'tsx' : 'ts', format: 'cjs', jsx: 'automatic' });
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console, Date, Math, ...globals, require: name => {
    if (!(name in imports)) throw new Error(`Unstubbed boundary: ${name}`);
    return imports[name];
  } });
  return module.exports;
}

async function analyticsHarness() {
  let now = 100_000, healthy = true, interval, unload;
  const attempts = [], delivered = [], beacons = [];
  class Clock extends Date { static now() { return now; } }
  const { analyticsTracker } = await load('frontend/src/services/analytics.ts', {
    Date: Clock,
    sessionStorage: { getItem: () => 'local-audit', setItem() {} },
    window: { location: { pathname: '/local-audit' }, addEventListener: (name, fn) => { if (name === 'beforeunload') unload = fn; } },
    navigator: { sendBeacon: (_, payload) => { beacons.push(JSON.parse(payload)); return true; } },
    setInterval: fn => { interval = fn; return 1; }, clearInterval() {},
    fetch: async (_, options) => {
      const body = JSON.parse(options.body);
      attempts.push(body);
      if (healthy) delivered.push(...body.events);
      return { ok: healthy };
    }
  }, { '../stores/authStore': { useAuthStore: { getState: () => ({ user: null, token: null }) } } });
  return { tracker: analyticsTracker, attempts, delivered, beacons, fail: () => { healthy = false; }, recover: () => { healthy = true; }, tick: async () => { now += 60_000; await interval(); }, unload: () => unload() };
}

test('analytics resumes after five failures and delivers queued and new events', async () => {
  const h = await analyticsHarness();
  h.fail(); h.tracker.track('before_outage');
  for (let i = 0; i < 5; i++) await h.tick();
  assert.equal(h.attempts.length, 5);
  h.recover(); h.tracker.track('after_outage'); await h.tick();
  assert.deepEqual(h.delivered.map(e => e.event_type), ['before_outage', 'after_outage']);
});

test('analytics sends a burst without exceeding the API batch cap or losing events', async () => {
  const h = await analyticsHarness();
  for (let i = 0; i < 80; i++) h.tracker.track(`burst_${i}`);
  await settle();
  for (let i = 0; i < 5; i++) await h.tick();
  assert.equal(new Set(h.delivered.map(e => e.event_type)).size, 80);
  assert.ok(h.attempts.every(batch => batch.events.length <= 50));
});

test('unload partitions a backlog into API-sized beacon batches', async () => {
  const h = await analyticsHarness();
  h.fail(); h.tracker.track('first'); await h.tick();
  for (let i = 0; i < 70; i++) h.tracker.track(`queued_${i}`);
  await settle(); h.unload();
  assert.ok(h.beacons.every(batch => batch.events.length <= 50));
  assert.equal(h.beacons.flatMap(batch => batch.events).length, 71);
});

async function chatHarness(open = true) {
  const effects = [], timers = new Map(), tracked = [];
  const state = [open, [], '', 0, [], false, open ? null : new Date(Date.now() - 1000), [], true];
  if (!open) state[1] = [{ id: 1, message: 'not solved', username: 'local-fixture', created_at: new Date().toISOString() }];
  let cursor = 0, sequence = 0, stream, historyReads = 0;
  let history = [];
  const auth = Object.assign(() => ({ isAuthenticated: true, user: { id: 1 } }), { getState: () => ({ token: 'local-fixture-token' }) });
  class Stream {
    constructor() { stream = this; queueMicrotask(() => { this.opened = true; this.onopen?.({}); }); }
    close() { this.closed = true; }
  }
  const { default: Chat } = await load('frontend/src/components/Chat.tsx', {
    setInterval: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; },
    clearInterval: id => timers.delete(id), EventSource: Stream,
    fetch: async path => ({ json: async () => {
      if (path.includes('/messages/')) { historyReads++; return { success: true, messages: [...history] }; }
      if (path.includes('/ticket')) return { success: true, ticket: 'local-only' };
      return { success: true, online_count: 0, recent_users: [] };
    } })
  }, {
    react: { useState: initial => { const n = cursor++; if (!(n in state)) state[n] = initial; return [state[n], value => { state[n] = typeof value === 'function' ? value(state[n]) : value; }]; }, useEffect: fn => effects.push(fn), useRef: () => ({ current: null }) },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
    'react-router-dom': { Link: () => null },
    '../stores/authStore': { useAuthStore: auth },
    '../hooks/useAnalytics': { useAnalytics: () => ({ track: (type, data) => tracked.push({ type, data }) }) },
    '../utils/date': { parseApiDate: value => new Date(value) },
    '@heroicons/react/24/outline': {}
  });
  Chat();
  return { effects, timers, tracked, state, stream: () => stream, reads: () => historyReads, history: value => { history = value; } };
}

test('chat reconciles history while SSE is healthy, and stops its timers on close', async () => {
  const h = await chatHarness();
  const cleanup = h.effects.at(-1)(); await settle();
  assert.equal(h.stream().opened, true);
  const before = h.reads();
  h.history([{ id: 2, created_at: new Date().toISOString(), message: 'local fixture' }]);
  for (const { fn, ms } of h.timers.values()) if (ms === 5000) fn();
  await settle();
  assert.ok(h.reads() > before, 'healthy SSE must not suppress durable history reconciliation');
  assert.equal(h.state[1][0].id, 2);
  cleanup(); assert.equal(h.timers.size, 0); assert.equal(h.stream().closed, true);
});

test('chat counts session sends separately and never infers a solved outcome from text', async () => {
  const h = await chatHarness(false);
  for (const effect of h.effects) effect();
  const close = h.tracked.find(e => e.type === 'chat_close');
  assert.equal(close.data.outcome, undefined);
  assert.equal(close.data.messages_sent_count, 0);
  assert.equal(close.data.messages_visible_count, 1);
});
