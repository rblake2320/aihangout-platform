#!/usr/bin/env node
// Deploy gate: run declared REA browser scenarios against an origin, store canonical Evidence
// JSON, and (with --baseline) fail on any step whose status codes, response shape or key DOM
// selectors differ. See docs/capture-gate.md.
//
//   node scripts/capture-gate.mjs --origin http://127.0.0.1:8799 [--baseline gate/captures/127.0.0.1_8799]
//        [--out gate/captures] [--slug local] [--only 03,05] [--from-evidence <dir>] [--pause-ms 0]
//
// Environment:
//   REA_BIN     REA CLI command (default "rea"); may include arguments, e.g. "npx -y rea-agents@6.7.0"
//   GATE_CHROME absolute path to a Chromium/Chrome executable (required unless --from-evidence)
//   GATE_USERNAME / GATE_EMAIL / GATE_PASSWORD / GATE_BAD_PASSWORD  optional; random per run if unset
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  canonicalize, unwrap, originSlug, assertOriginAllowed, summarize, checkExpectations,
  compareSummaries, formatDiffs, reaAlignmentDiffs,
} from '../gate/lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function parseArgs(argv) {
  const a = { out: path.join(root, 'gate', 'captures'), pauseMs: 0 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      return argv[++i];
    };
    if (k === '--origin') a.origin = v();
    else if (k === '--baseline') a.baseline = path.resolve(v());
    else if (k === '--out') a.out = path.resolve(v());
    else if (k === '--only') a.only = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--from-evidence') a.fromEvidence = path.resolve(v());
    else if (k === '--slug') a.slug = v();
    else if (k === '--pause-ms') a.pauseMs = Number(v());
    else throw new Error(`unknown argument: ${k}`);
  }
  if (!a.origin) throw new Error('--origin <url> is required');
  a.origin = a.origin.replace(/\/+$/, '');
  return a;
}

function reaCommand() {
  const parts = (process.env.REA_BIN || 'rea').split(/\s+/).filter(Boolean);
  return { cmd: parts[0], pre: parts.slice(1) };
}

function runRea(args) {
  const { cmd, pre } = reaCommand();
  const r = spawnSync(cmd, [...pre, ...args], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32',
  });
  if (r.error) throw new Error(`failed to start REA (${cmd}): ${r.error.message}`);
  if (r.status !== 0) throw new Error(`REA ${args[0]} exited ${r.status}: ${(r.stdout || '').slice(0, 800)} ${(r.stderr || '').slice(0, 400)}`);
  try { return JSON.parse(r.stdout); } catch (e) {
    throw new Error(`REA ${args[0]} returned non-JSON output: ${String(r.stdout).slice(0, 300)}`);
  }
}

function prepareScenario(file, origin, chrome) {
  const text = fs.readFileSync(file, 'utf8').split('__ORIGIN__').join(origin);
  const s = JSON.parse(text);
  s.browser = { mode: 'launch', executable_path: chrome.replace(/\\/g, '/') };
  return s;
}

// Fresh account identity per scenario: each scenario registers its own user, so reusing one
// across scenarios (or reruns against a persistent DB) would 409. Values are passed to REA as
// declared secrets, so they are redacted in the stored Evidence. GATE_* set by the caller win.
const callerSecrets = Object.fromEntries(['GATE_USERNAME', 'GATE_EMAIL', 'GATE_PASSWORD', 'GATE_BAD_PASSWORD']
  .filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
function freshSecrets() {
  const id = crypto.randomBytes(4).toString('hex');
  Object.assign(process.env, {
    GATE_USERNAME: `gate${id}`,
    GATE_EMAIL: `gate+${id}@example.test`,
    GATE_PASSWORD: `Gate-${crypto.randomBytes(6).toString('hex')}-Pw1!`,
    GATE_BAD_PASSWORD: `wrong-${crypto.randomBytes(5).toString('hex')}`,
  }, callerSecrets);
}

// The browser path is machine-specific (and may contain a user name); the repo is public.
function scrubMachinePaths(ev) {
  const b = ev && ev.parameters && ev.parameters.browser;
  if (b && b.executable_path) b.executable_path = '<GATE_CHROME>';
  return ev;
}

const writeCanonical = (p, obj) => fs.writeFileSync(p, JSON.stringify(canonicalize(obj), null, 1) + '\n');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rules = readJson(path.join(root, 'gate', 'rules.json'));
  const expectations = readJson(path.join(root, 'gate', 'expectations.json'));
  assertOriginAllowed(args.origin, rules);

  const scenarioDir = path.join(root, 'gate', 'scenarios');
  const names = fs.readdirSync(scenarioDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()
    .filter((n) => !args.only || args.only.some((o) => n.startsWith(o)));
  if (!names.length) throw new Error(`no scenarios matched ${JSON.stringify(args.only)} in ${scenarioDir}`);

  const slug = args.slug || originSlug(args.origin);
  const outDir = path.join(args.out, slug);
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-gate-'));
  const chrome = process.env.GATE_CHROME;
  if (!args.fromEvidence && !chrome) throw new Error('GATE_CHROME must point at a Chromium/Chrome executable');

  const report = { origin: args.origin, slug, baseline: args.baseline || null, scenarios: {} };
  let failed = 0;

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const evPath = path.join(outDir, `${name}.evidence.json`);
    let evidence;
    if (args.fromEvidence) {
      evidence = readJson(path.join(args.fromEvidence, `${name}.evidence.json`));
    } else {
      if (i > 0 && args.pauseMs) await new Promise((r) => setTimeout(r, args.pauseMs));
      freshSecrets();
      const input = path.join(tmp, `${name}.in.json`);
      fs.writeFileSync(input, JSON.stringify(prepareScenario(path.join(scenarioDir, `${name}.json`), args.origin, chrome)));
      evidence = runRea(['capture-browser-scenario', input, '--format', 'json']);
    }
    unwrap(evidence); // throws on a malformed capture rather than gating on nothing
    writeCanonical(evPath, scrubMachinePaths(evidence));

    const evOrigin = evidence.normalized_result.scenario.start_origin;
    const cur = summarize(evidence, rules, evOrigin);
    const diffs = checkExpectations(cur, expectations[name], rules);
    const entry = { evidence_id: evidence.evidence_id, steps: cur.steps.length, diffs: [] };

    if (args.baseline) {
      const basePath = path.join(args.baseline, `${name}.evidence.json`);
      if (!fs.existsSync(basePath)) {
        diffs.push({ step: '*', axis: 'baseline', detail: `no baseline capture at ${basePath}` });
      } else {
        const baseEv = readJson(basePath);
        const baseOrigin = baseEv.normalized_result.scenario.start_origin;
        const baseBrowser = baseEv.normalized_result.browser;
        diffs.push(...compareSummaries(summarize(baseEv, rules, baseOrigin), cur));
        const b = path.join(tmp, `${name}.base.json`);
        const c = path.join(tmp, `${name}.cur.json`);
        fs.writeFileSync(b, JSON.stringify(baseEv.normalized_result));
        fs.writeFileSync(c, JSON.stringify(evidence.normalized_result));
        const rea = runRea(['compare-web-captures', b, c, '--format', 'json']);
        writeCanonical(path.join(outDir, `${name}.rea-compare.json`), rea);
        diffs.push(...reaAlignmentDiffs(rea, { contextDiffers: baseOrigin !== evOrigin || baseBrowser.version !== evidence.normalized_result.browser.version }));
        entry.rea_compare_evidence_id = rea.evidence_id;
        entry.rea_overall_status = rea.normalized_result && rea.normalized_result.overall_status;
      }
    }
    entry.diffs = diffs;
    report.scenarios[name] = entry;
    if (diffs.length) {
      failed++;
      console.error(`FAIL ${name} (${evidence.evidence_id})\n${formatDiffs(name, diffs)}`);
    } else {
      console.log(`PASS ${name} (${evidence.evidence_id}, ${cur.steps.length} steps${args.baseline ? ', matches baseline' : ''})`);
    }
  }

  writeCanonical(path.join(outDir, 'report.json'), report);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${names.length - failed}/${names.length} scenarios passed; evidence in ${outDir}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(`capture-gate error: ${e.message}`); process.exit(2); });
