import { it, expect, vi } from 'vitest';
import { RageDetector } from '../frontend/src/telemetry/rage.ts';
import { DeadClickDetector, isDeadClickCandidate } from '../frontend/src/telemetry/dead.ts';
import { ActivityClock } from '../frontend/src/telemetry/activity.ts';
import { EventQueue } from '../frontend/src/telemetry/queue.ts';
import { sendBatch } from '../frontend/src/telemetry/transport.ts';
import { describeElement, isExcluded, sanitizeRoute, scrubStack, scrubText } from '../frontend/src/telemetry/mask.ts';
import { DEFAULT_CONFIG } from '../frontend/src/telemetry/types.ts';

// Pure client logic, run in workerd. DOM wiring (frontend/src/telemetry/index.ts) is covered
// by the browser check recorded in docs/telemetry-reconstruction.md, not here.
const { rage: R } = DEFAULT_CONFIG;

it('rage: fires at 5 clicks inside 2s on one target, once, and not at 4', () => {
  const d = new RageDetector(R);
  for (let i = 0; i < 4; i++) expect(d.onClick('button#a', 1000 + i * 300, '/x')).toBeNull();
  expect(d.onClick('button#a', 2200, '/x')).toEqual({ count: 5, navigated: false });
  expect(d.onClick('button#a', 2300, '/x')).toBeNull(); // already fired for this burst
});

it('rage: clicks spread beyond the window or across targets never fire', () => {
  const d = new RageDetector(R);
  for (let i = 0; i < 10; i++) expect(d.onClick('button#a', i * 2500, '/x')).toBeNull();
  const e = new RageDetector(R);
  for (let i = 0; i < 10; i++) expect(e.onClick(`button#${i}`, 1000 + i * 10, '/x')).toBeNull();
});

it('rage: needs 8 clicks when the route changed during the burst', () => {
  const d = new RageDetector(R);
  expect(d.onClick('a.nav', 0, '/a')).toBeNull();
  for (let i = 1; i < 7; i++) expect(d.onClick('a.nav', i * 100, '/b')).toBeNull();
  expect(d.onClick('a.nav', 700, '/b')).toEqual({ count: 8, navigated: true });
});

it('rage: re-arms after a quiet window', () => {
  const d = new RageDetector(R);
  for (let i = 0; i < 5; i++) d.onClick('b', i * 100, '/');
  expect(d.onClick('b', 5000, '/')).toBeNull();
  for (let i = 1; i < 4; i++) expect(d.onClick('b', 5000 + i * 100, '/')).toBeNull();
  expect(d.onClick('b', 5400, '/')).toMatchObject({ count: 5 });
});

it('dead click: fires after the wait with no reaction, is cancelled by a reaction, and only the latest click counts', () => {
  vi.useFakeTimers();
  const hits = [];
  const d = new DeadClickDetector(1000, h => hits.push(h));
  d.onClick('a.one');
  vi.advanceTimersByTime(999);
  expect(hits).toEqual([]);
  vi.advanceTimersByTime(2);
  expect(hits).toEqual([{ target: 'a.one', waitMs: 1000 }]);

  d.onClick('a.two');
  vi.advanceTimersByTime(500);
  d.noteReaction(); // DOM changed
  vi.advanceTimersByTime(2000);
  expect(hits).toHaveLength(1);

  d.onClick('a.three'); d.onClick('a.four');
  vi.advanceTimersByTime(1001);
  expect(hits.map(h => h.target)).toEqual(['a.one', 'a.four']);
  vi.useRealTimers();
});

it('dead click candidates exclude submit buttons, new-tab/anchor/mailto links and disabled controls', () => {
  expect(isDeadClickCandidate('button', { type: 'button' })).toBe(true);
  expect(isDeadClickCandidate('div', { role: 'button' })).toBe(true);
  expect(isDeadClickCandidate('button', { type: 'submit' })).toBe(false);
  expect(isDeadClickCandidate('button', {})).toBe(false);
  expect(isDeadClickCandidate('a', { href: '/x' })).toBe(true);
  expect(isDeadClickCandidate('a', { href: '#top' })).toBe(false);
  expect(isDeadClickCandidate('a', { href: 'mailto:a@b.c' })).toBe(false);
  expect(isDeadClickCandidate('a', { href: '/x', target: '_blank' })).toBe(false);
  expect(isDeadClickCandidate('button', { type: 'button', disabled: true })).toBe(false);
  expect(isDeadClickCandidate('p', {})).toBe(false);
});

it('activity: idle gaps beyond the threshold are not counted as active', () => {
  const c = new ActivityClock(30_000, 0);
  c.input(10_000);            // 10s active
  c.input(100_000);           // 90s gap: only 30s active
  const snap = c.snapshot(100_000);
  expect(snap).toEqual({ durationMs: 100_000, activeMs: 40_000, idleMs: 60_000 });
  expect(c.snapshot(160_000)).toEqual({ durationMs: 160_000, activeMs: 70_000, idleMs: 90_000 }); // trailing 30s grace
  c.reset(200_000);
  expect(c.snapshot(200_000)).toEqual({ durationMs: 0, activeMs: 0, idleMs: 0 });
});

it('queue: byte cap splits batches, failures back off exponentially up to the ceiling, ack resets', () => {
  const cfg = { ...DEFAULT_CONFIG, batch: { ...DEFAULT_CONFIG.batch, maxEvents: 20, maxBytes: 400, maxQueue: 50 } };
  const q = new EventQueue(cfg);
  for (let i = 0; i < 10; i++) q.push({ type: 'page_view', ts: i, route: '/', data: { pad: 'x'.repeat(60) } });
  const first = q.take();
  expect(first.length).toBeLessThan(10);
  expect(first.length).toBeGreaterThan(0);
  q.fail(first, 1000);
  expect(q.canSend(1000 + 1999)).toBe(false);
  expect(q.canSend(1000 + 2000)).toBe(true);
  q.fail(q.take(), 5000);                 // 2nd failure: 4s
  expect(q.canSend(5000 + 3999)).toBe(false);
  expect(q.canSend(5000 + 4000)).toBe(true);
  for (let i = 0; i < 30; i++) q.fail(q.take(), 0);
  expect(q.canSend(299_999)).toBe(false);  // capped at 300s, not unbounded
  expect(q.canSend(300_000)).toBe(true);
  q.ack();
  expect(q.canSend(0)).toBe(true);
});

it('queue: drops the oldest event when full', () => {
  const q = new EventQueue({ ...DEFAULT_CONFIG, batch: { ...DEFAULT_CONFIG.batch, maxQueue: 3 } });
  for (let i = 0; i < 5; i++) q.push({ type: 'page_view', ts: i, route: '/', data: {} });
  expect(q.dropped).toBe(2);
  expect(q.take().map(e => e.ts)).toEqual([2, 3, 4]);
});

it('transport: unloading uses sendBeacon; a refused or missing beacon falls back to fetch with the token; failures report false', async () => {
  const batch = { session_id: 'a'.repeat(32), events: [] };
  const fetchFn = vi.fn(async () => ({ ok: true }));
  const beacon = vi.fn(() => true);
  expect(await sendBatch('/e', batch, { fetchFn, sendBeacon: beacon, getToken: () => 't' }, true)).toBe(true);
  expect(beacon).toHaveBeenCalledOnce();
  expect(fetchFn).not.toHaveBeenCalled();

  expect(await sendBatch('/e', batch, { fetchFn, sendBeacon: () => false, getToken: () => 'tok' }, true)).toBe(true);
  expect(fetchFn).toHaveBeenCalledOnce();
  const [, init] = fetchFn.mock.calls[0];
  expect(init.keepalive).toBe(true);
  expect(init.headers.Authorization).toBe('Bearer tok');

  expect(await sendBatch('/e', batch, { fetchFn, sendBeacon: () => { throw new Error('x'); }, getToken: () => null }, true)).toBe(true);
  expect(fetchFn.mock.calls[1][1].headers.Authorization).toBeUndefined();

  // Not unloading: never uses the beacon.
  const b2 = vi.fn(() => true);
  await sendBatch('/e', batch, { fetchFn, sendBeacon: b2, getToken: () => null }, false);
  expect(b2).not.toHaveBeenCalled();

  expect(await sendBatch('/e', batch, { fetchFn: async () => ({ ok: false }), getToken: () => null }, false)).toBe(false);
  expect(await sendBatch('/e', batch, { fetchFn: async () => { throw new Error('offline'); }, getToken: () => null }, false)).toBe(false);
});

it('mask: routes lose query/hash, text loses emails/tokens/long numbers, excluded and credential fields are never described', () => {
  expect(sanitizeRoute('https://aihangout.ai/problems/7?token=abc#x')).toBe('/problems/7');
  expect(scrubText('mail a.b@c.io card 4111111111111111 key ' + 'k'.repeat(40), 500)).toBe('mail <email> card <num> key <token>');
  expect(scrubStack('at f (https://x.test/a.js?sig=SECRET:1:2)')).not.toContain('SECRET');

  const el = (tag, attrs = {}, extra = {}) => ({ tagName: tag, id: '', className: '', getAttribute: k => attrs[k] ?? null, closest: () => null, ...extra });
  expect(isExcluded(el('INPUT', { type: 'password' }))).toBe(true);
  expect(isExcluded(el('INPUT', { type: 'hidden' }))).toBe(true);
  expect(isExcluded(el('INPUT', { autocomplete: 'cc-number' }))).toBe(true);
  expect(isExcluded(el('INPUT', {}, { closest: sel => (sel === '.tel-exclude' ? {} : null) }))).toBe(true);
  expect(describeElement(el('INPUT', { type: 'password' }))).toBe('[excluded]');
  expect(describeElement(el('BUTTON', {}, { id: 'go', className: 'btn primary extra' }))).toBe('button#go.btn.primary');
  expect(describeElement(el('DIV', {}, { className: 'weird<script>' }))).toBe('div');
});
