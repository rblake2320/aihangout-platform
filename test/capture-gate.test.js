import { describe, it, expect } from 'vitest';
import {
  summarize, compareSummaries, checkExpectations, assertOriginAllowed, reaAlignmentDiffs, canonicalize,
} from '../gate/lib.mjs';
import rules from '../gate/rules.json';

const ORIGIN = 'http://127.0.0.1:8800';
const b64 = (s) => btoa(s);
const url = (u) => ({ url: u, origin: ORIGIN, query_parameter_names: [], redacted: false });

// Smallest capture_browser_scenario Evidence the comparator accepts: two steps, one POST
// whose JSON response body is captured.
function fixture({ status = 200, body = { success: true, user: { id: 1, username: 'u' } }, path = '/api/auth/login', html, storage, session } = {}) {
  const dom = (text) => ({ state: 'captured', value: { sha256: 'x', bytes: text.length, text } });
  const page = html ?? '<html><body><nav></nav><form><input id="email"><button type="submit">Go</button></form></body></html>';
  const artifacts = (text) => ({
    dom: dom(text),
    storage: { state: 'captured', value: { cookies: [], local_storage: storage || [], session_storage: session || [] } },
    url: { state: 'not_requested' },
  });
  return {
    evidence_id: 'ev_fixture',
    normalized_result: {
      scenario: { start_origin: ORIGIN },
      steps: [
        { step_index: 0, step_id: 'scenario_start', action: 'goto_start', status: 'completed', after_url: url(`${ORIGIN}/login`), artifacts: artifacts(page) },
        { step_index: 1, step_id: 'submit', action: 'click', status: 'completed', after_url: url(`${ORIGIN}/login`), artifacts: artifacts(page) },
        { step_index: 2, step_id: 'settle', action: 'wait_for_timeout', status: 'completed', after_url: url(`${ORIGIN}/login`), artifacts: artifacts(page) },
      ],
      events: {
        items: [
          { kind: 'request', step_index: 1, transaction_id: 't1', method: 'POST', url: url(`${ORIGIN}${path}`) },
          // arrives during the wait step: must still be attributed to the click that caused it
          { kind: 'response', step_index: 2, transaction_id: 't1', method: 'POST', status, url: url(`${ORIGIN}${path}`) },
          { kind: 'network-content', step_index: 2, transaction_id: 't1', phase: 'response', body: { state: 'captured', content: b64(JSON.stringify(body)) } },
        ],
      },
    },
  };
}

const sum = (ev) => summarize(ev, rules, ORIGIN);
const diff = (a, b) => compareSummaries(sum(a), sum(b));

describe('capture gate comparator', () => {
  it('passes identical captures', () => {
    expect(diff(fixture(), fixture())).toEqual([]);
  });

  it('attributes a response that lands during a wait to the causing action', () => {
    const s = sum(fixture());
    expect(s.steps.find((x) => x.id === 'submit').responses).toEqual([`POST <ORIGIN>/api/auth/login 200`]);
    expect(s.steps.find((x) => x.id === 'settle').responses).toEqual([]);
  });

  it('fails when a response status changes', () => {
    const d = diff(fixture({ status: 401 }), fixture({ status: 500 }));
    expect(d.map((x) => x.axis)).toContain('response-status');
    expect(d.some((x) => /only in current: POST <ORIGIN>\/api\/auth\/login 500/.test(x.detail))).toBe(true);
  });

  it('fails when the response shape changes but ignores changed values', () => {
    const valueOnly = diff(fixture(), fixture({ body: { success: true, user: { id: 999, username: 'other' } } }));
    expect(valueOnly).toEqual([]);
    const shape = diff(fixture(), fixture({ body: { success: true, user: { id: 1 } } }));
    expect(shape.find((x) => x.axis === 'response-shape').detail).toMatch(/removed \[\$\.user\.username:string\]/);
  });

  it('fails when a key DOM selector disappears', () => {
    const d = diff(fixture(), fixture({ html: '<html><body><nav></nav></body></html>' }));
    expect(d.filter((x) => x.axis === 'dom-selector').map((x) => x.detail.split(':')[0]).sort())
      .toEqual(expect.arrayContaining(['#email', 'button[type=submit]', 'form']));
  });

  it('ignores declared timestamp / id / asset-hash noise in URLs', () => {
    const a = fixture({ path: '/api/problems/12?ts=111&x=1' });
    const b = fixture({ path: '/api/problems/907?ts=222&x=1' });
    expect(diff(a, b)).toEqual([]);
    const c = fixture({ path: '/assets/index-Bv9XazIt.js' });
    const d = fixture({ path: '/assets/index-Q2w8LmZp.js' });
    expect(diff(c, d)).toEqual([]);
    const e = fixture({ path: '/api/events?at=2026-10-31T12:00:00.000Z' });
    const f = fixture({ path: '/api/events?at=2026-11-01T01:02:03.456Z' });
    expect(diff(e, f)).toEqual([]);
  });

  it('ignores declared polling endpoints and session-id storage keys', () => {
    const noisy = fixture({ path: '/api/live/count', status: 200 });
    const other = fixture({ path: '/api/live/count', status: 503 });
    expect(diff(noisy, other)).toEqual([]);
    const ids = fixture({ session: [{ name: 'guestSessionId' }] });
    expect(diff(fixture(), ids)).toEqual([]);
    const auth = fixture({ storage: [{ name: 'ai-hangout-auth' }] });
    expect(new Set(diff(fixture(), auth).map((x) => x.axis))).toEqual(new Set(['storage']));
  });

  it('flags absolute expectations and any 5xx without needing a baseline', () => {
    const exp = { submit: { responses: ['POST <ORIGIN>/api/auth/login 401'] } };
    expect(checkExpectations(sum(fixture({ status: 401 })), exp, rules)).toEqual([]);
    const bad = checkExpectations(sum(fixture({ status: 500 })), exp, rules);
    expect(bad.map((x) => x.detail).join('\n')).toMatch(/server error response/);
    expect(bad.map((x) => x.detail).join('\n')).toMatch(/expected response "POST <ORIGIN>\/api\/auth\/login 401" not observed/);
  });

  it('reports a step missing from the current capture as an alignment failure', () => {
    const cur = fixture();
    cur.normalized_result.steps.pop();
    expect(diff(fixture(), cur).map((x) => x.axis)).toContain('alignment');
  });

  it('rejects input that is not a scenario capture instead of gating on nothing', () => {
    expect(() => summarize({ foo: 1 }, rules, ORIGIN)).toThrow(/not a capture_browser_scenario result/);
  });

  it('refuses production hosts, including subdomains', () => {
    expect(() => assertOriginAllowed('https://aihangout.ai', rules)).toThrow(/forbidden/);
    expect(() => assertOriginAllowed('https://www.aihangout.ai/x', rules)).toThrow(/forbidden/);
    expect(() => assertOriginAllowed('https://aihangout-staging.example.workers.dev', rules)).not.toThrow();
    expect(() => assertOriginAllowed('http://127.0.0.1:8800', rules)).not.toThrow();
  });

  it("tolerates REA's origin-scope mismatch only when the capture context is declared different", () => {
    const rea = { normalized_result: { alignment: { status: 'partial', aligned_steps: 3, before_only: [], after_only: [], failures: [{ code: 'capture_context_mismatch', step_id: null, reason: 'origin' }] } } };
    expect(reaAlignmentDiffs(rea, { contextDiffers: true })).toEqual([]);
    expect(reaAlignmentDiffs(rea, { contextDiffers: false })).toHaveLength(1);
    const lost = { normalized_result: { alignment: { status: 'partial', before_only: ['submit'], after_only: [], failures: [] } } };
    expect(reaAlignmentDiffs(lost, { contextDiffers: true })).toHaveLength(1);
  });

  it('canonicalizes key order so stored Evidence is byte-stable', () => {
    expect(JSON.stringify(canonicalize({ b: 1, a: { d: 1, c: [{ z: 1, y: 2 }] } }))).toBe('{"a":{"c":[{"y":2,"z":1}],"d":1},"b":1}');
  });
});
