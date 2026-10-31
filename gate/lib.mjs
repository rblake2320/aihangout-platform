// Pure comparator for the deploy capture gate. No fs / process / node: imports, so it runs
// unchanged under Node (scripts/capture-gate.mjs) and inside workerd (vitest).
//
// Input is REA `capture_browser_scenario` Evidence (the full envelope or just its
// normalized_result). We reduce it to the facts a deploy can legitimately break
// (per step: HTTP statuses, JSON response/request shapes, key DOM selectors, storage key
// names, page errors) and diff two reductions step by step.

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

export function unwrap(evidence) {
  const n = evidence && evidence.normalized_result ? evidence.normalized_result : evidence;
  if (!n || !Array.isArray(n.steps) || !n.events || !Array.isArray(n.events.items)) {
    throw new Error('not a capture_browser_scenario result: missing steps/events.items');
  }
  return n;
}

export function originSlug(origin) {
  const u = new URL(origin);
  return (u.host || u.hostname).replace(/:/g, '_');
}

// Refuse to run mutating scenarios against production. Matched on hostname so a path or
// port trick cannot slip through.
export function assertOriginAllowed(origin, rules) {
  const host = new URL(origin).hostname.toLowerCase();
  for (const f of rules.forbidden_hosts || []) {
    const h = f.toLowerCase();
    if (host === h || host.endsWith('.' + h)) {
      throw new Error(`refusing to run against ${host}: production hosts are forbidden by gate/rules.json`);
    }
  }
}

function compileAll(list) {
  return (list || []).map((r) => (typeof r === 'string'
    ? { re: new RegExp(r) }
    : { re: new RegExp(r.pattern, r.flags || 'g'), replacement: r.replacement }));
}

export function normalizeUrl(url, origin, rules) {
  let s = String(url);
  if (origin) s = s.split(origin).join('<ORIGIN>');
  for (const r of compileAll(rules.url_normalize)) s = s.replace(r.re, r.replacement);
  return s;
}

function isIgnoredRequest(normUrl, rules) {
  return compileAll(rules.ignore_requests).some((r) => r.re.test(normUrl));
}

function b64ToText(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// "path:type" lines for a JSON value; values are never compared, only structure.
export function jsonShape(value, path = '$', out = new Set()) {
  if (Array.isArray(value)) {
    out.add(`${path}:array`);
    for (const v of value) jsonShape(v, `${path}[]`, out);
  } else if (value && typeof value === 'object') {
    out.add(`${path}:object`);
    for (const k of Object.keys(value)) jsonShape(value[k], `${path}.${k}`, out);
  } else {
    out.add(`${path}:${value === null ? 'null' : typeof value}`);
  }
  return out;
}

function bodyShape(body) {
  if (!body || body.state !== 'captured') return body ? `<${body.state}>` : null;
  let text;
  try { text = b64ToText(body.content); } catch { return '<undecodable>'; }
  if (!text) return '<empty>';
  try { return [...jsonShape(JSON.parse(text))].sort().join(' '); } catch { return '<non-json>'; }
}

// Minimal selector matcher over serialized HTML: tag, #id, .class, [attr], [attr=value].
function parseSelector(sel) {
  const m = sel.match(/^([a-zA-Z][\w-]*)?((?:[#.][\w-]+|\[[\w-]+(?:=[^\]]+)?\])*)$/);
  if (!m) throw new Error(`unsupported selector in gate/rules.json: ${sel}`);
  const parts = { tag: m[1] ? m[1].toLowerCase() : null, id: null, classes: [], attrs: [] };
  for (const t of m[2].match(/[#.][\w-]+|\[[\w-]+(?:=[^\]]+)?\]/g) || []) {
    if (t[0] === '#') parts.id = t.slice(1);
    else if (t[0] === '.') parts.classes.push(t.slice(1));
    else {
      const [k, v] = t.slice(1, -1).split('=');
      parts.attrs.push([k.toLowerCase(), v === undefined ? null : v.replace(/^["']|["']$/g, '')]);
    }
  }
  return parts;
}

export function domSelectorPresence(html, selectors) {
  const tags = [];
  const re = /<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    const ar = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a;
    while ((a = ar.exec(m[2]))) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    tags.push({ tag: m[1].toLowerCase(), attrs });
  }
  const out = {};
  for (const sel of selectors) {
    const p = parseSelector(sel);
    out[sel] = tags.some((t) => (!p.tag || t.tag === p.tag)
      && (!p.id || t.attrs.id === p.id)
      && p.classes.every((c) => (t.attrs.class || '').split(/\s+/).includes(c))
      && p.attrs.every(([k, v]) => (k in t.attrs) && (v === null || t.attrs[k] === v)));
  }
  return out;
}

export function summarize(evidence, rules, origin) {
  const n = unwrap(evidence);
  const selectors = (rules.dom && rules.dom.key_selectors) || [];
  const byStep = new Map(n.steps.map((s) => [s.step_index, {
    id: s.step_id,
    status: s.status,
    url: normalizeUrl(s.after_url.url, origin, rules),
    dom: null,
    storage: null,
    responses: [],
    shapes: {},
    requestShapes: {},
  }]));

  const txn = new Map();
  for (const s of n.steps) {
    const step = byStep.get(s.step_index);
    const dom = s.artifacts && s.artifacts.dom;
    if (dom && dom.state === 'captured') step.dom = domSelectorPresence(dom.value.text, selectors);
    const st = s.artifacts && s.artifacts.storage;
    if (st && st.state === 'captured') {
      const ignoreKeys = new Set(rules.ignore_storage_keys || []);
      step.storage = [
        ...st.value.cookies.map((c) => `cookie:${c.name}`),
        ...st.value.local_storage.map((c) => `local:${c.name}`),
        ...st.value.session_storage.map((c) => `session:${c.name}`),
      ].filter((k) => !ignoreKeys.has(k)).sort();
    }
  }
  const pageErrors = [];
  // Network activity is attributed to the action that caused it, never to the step during
  // which it merely arrived: a response (or a request fired by an effect after DOMContentLoaded)
  // lands while the following wait step runs, and which side of the boundary it falls on is a
  // timing race. Waits never cause traffic, so roll their events back to the last real action.
  const WAITS = new Set(['wait_for', 'wait_for_timeout']);
  const actionOf = new Map(n.steps.map((s) => [s.step_index, s.action]));
  const causalStep = (idx) => {
    while (idx > 0 && WAITS.has(actionOf.get(idx))) idx--;
    return idx;
  };
  const requestStep = new Map();
  for (const e of n.events.items) if (e.kind === 'request') requestStep.set(e.transaction_id, causalStep(e.step_index));
  for (const e of n.events.items) {
    const step = byStep.get(e.kind === 'response' && requestStep.has(e.transaction_id) ? requestStep.get(e.transaction_id) : causalStep(e.step_index));
    if (!step) continue;
    if (e.kind === 'page-error') pageErrors.push(`${step.id}: ${String(e.message).split('\n')[0]}`);
    if (e.kind === 'response') {
      const u = normalizeUrl(e.url.url, origin, rules);
      txn.set(e.transaction_id, { step, key: `${e.method} ${u}`, ignored: isIgnoredRequest(u, rules) });
      if (!txn.get(e.transaction_id).ignored) step.responses.push(`${e.method} ${u} ${e.status}`);
    }
  }
  for (const e of n.events.items) {
    if (e.kind !== 'network-content') continue;
    const t = txn.get(e.transaction_id);
    if (!t || t.ignored) continue;
    const shape = bodyShape(e.body);
    if (shape === null) continue;
    (e.phase === 'response' ? t.step.shapes : t.step.requestShapes)[t.key] = shape;
  }
  const steps = [...byStep.values()].map((s) => ({
    ...s,
    responses: [...new Set(s.responses)].sort(),
  }));
  return { steps, pageErrors: pageErrors.sort() };
}

// Absolute expectations, independent of any baseline: required responses per step and no 5xx.
export function checkExpectations(summary, expectations, rules) {
  const diffs = [];
  const exp = expectations || {};
  for (const step of summary.steps) {
    for (const r of step.responses) {
      const status = Number(r.split(' ').pop());
      if (status >= 500) diffs.push({ step: step.id, axis: 'expectation', detail: `server error response: ${r}` });
    }
    for (const want of (exp[step.id] && exp[step.id].responses) || []) {
      if (!step.responses.includes(want)) {
        diffs.push({ step: step.id, axis: 'expectation', detail: `expected response "${want}" not observed; saw [${step.responses.join('; ')}]` });
      }
    }
  }
  for (const id of Object.keys(exp)) {
    if (!summary.steps.some((s) => s.id === id)) diffs.push({ step: id, axis: 'expectation', detail: 'expected step not present in capture' });
  }
  return diffs;
}

function setDiff(a, b) {
  return { removed: a.filter((x) => !b.includes(x)), added: b.filter((x) => !a.includes(x)) };
}

export function compareSummaries(base, cur) {
  const diffs = [];
  const bi = new Map(base.steps.map((s) => [s.id, s]));
  const ci = new Map(cur.steps.map((s) => [s.id, s]));
  for (const id of bi.keys()) if (!ci.has(id)) diffs.push({ step: id, axis: 'alignment', detail: 'step missing from current capture' });
  for (const id of ci.keys()) if (!bi.has(id)) diffs.push({ step: id, axis: 'alignment', detail: 'step not in baseline' });
  for (const [id, b] of bi) {
    const c = ci.get(id);
    if (!c) continue;
    if (b.status !== c.status) diffs.push({ step: id, axis: 'step-status', detail: `baseline=${b.status} current=${c.status}` });
    if (b.url !== c.url) diffs.push({ step: id, axis: 'url', detail: `baseline=${b.url} current=${c.url}` });
    const r = setDiff(b.responses, c.responses);
    for (const x of r.removed) diffs.push({ step: id, axis: 'response-status', detail: `only in baseline: ${x}` });
    for (const x of r.added) diffs.push({ step: id, axis: 'response-status', detail: `only in current: ${x}` });
    for (const [axis, key] of [['response-shape', 'shapes'], ['request-shape', 'requestShapes']]) {
      for (const k of new Set([...Object.keys(b[key]), ...Object.keys(c[key])])) {
        if (!(k in b[key]) || !(k in c[key])) continue; // presence is covered by response-status
        if (b[key][k] !== c[key][k]) {
          const d = setDiff(b[key][k].split(' '), c[key][k].split(' '));
          diffs.push({ step: id, axis, detail: `${k}: removed [${d.removed.join(', ')}] added [${d.added.join(', ')}]` });
        }
      }
    }
    if (b.dom && c.dom) {
      for (const sel of Object.keys(b.dom)) {
        if (b.dom[sel] !== c.dom[sel]) diffs.push({ step: id, axis: 'dom-selector', detail: `${sel}: baseline=${b.dom[sel] ? 'present' : 'absent'} current=${c.dom[sel] ? 'present' : 'absent'}` });
      }
    } else if (!!b.dom !== !!c.dom) {
      diffs.push({ step: id, axis: 'dom-selector', detail: 'DOM captured in only one of the two runs' });
    }
    if (b.storage && c.storage) {
      const s = setDiff(b.storage, c.storage);
      for (const x of s.removed) diffs.push({ step: id, axis: 'storage', detail: `key only in baseline: ${x}` });
      for (const x of s.added) diffs.push({ step: id, axis: 'storage', detail: `key only in current: ${x}` });
    }
  }
  const pe = setDiff(base.pageErrors, cur.pageErrors);
  for (const x of pe.removed) diffs.push({ step: '*', axis: 'page-error', detail: `only in baseline: ${x}` });
  for (const x of pe.added) diffs.push({ step: '*', axis: 'page-error', detail: `only in current: ${x}` });
  return diffs;
}

export function formatDiffs(scenario, diffs) {
  return diffs.map((d) => `  [${scenario}] step=${d.step} ${d.axis}: ${d.detail}`).join('\n');
}

// REA's own compare result: step alignment is required. Its artifact-level "changed" flags are
// informational because identical reruns already differ in session-id hashes. REA reports
// capture_context_mismatch whenever the scenario origin or the browser build differs (local vs
// staging, or a CI runner's Chrome vs the recorded one, is the whole point of the gate), so that
// one code is tolerated when the caller declares the context differs.
export function reaAlignmentDiffs(reaCompare, { contextDiffers = false } = {}) {
  const n = reaCompare && (reaCompare.normalized_result || reaCompare);
  if (!n || !n.alignment) return [{ step: '*', axis: 'rea-compare', detail: 'compare_web_captures returned no alignment block' }];
  if (n.alignment.status === 'aligned') return [];
  const failures = (n.alignment.failures || []).filter((f) => !(contextDiffers && f.code === 'capture_context_mismatch'));
  const stepsAligned = (n.alignment.before_only || []).length === 0 && (n.alignment.after_only || []).length === 0;
  if (!failures.length && stepsAligned) return [];
  return [{ step: '*', axis: 'rea-compare', detail: `alignment ${n.alignment.status}: ${JSON.stringify(failures)} before_only=${JSON.stringify(n.alignment.before_only || [])} after_only=${JSON.stringify(n.alignment.after_only || [])}` }];
}
