#!/usr/bin/env node
/**
 * ctx-audit — full context watermark report for humans.
 *
 * Usage:
 *   node scripts/ctx-audit.mjs           # sessions for the current project
 *   node scripts/ctx-audit.mjs --all     # every project on this machine
 *   node scripts/ctx-audit.mjs --cost    # also estimate dollars (see caveat below)
 *
 * Always exits 0. This reports, it never blocks.
 *
 * THE POINT IS TOKEN BURN, NOT DOLLARS.
 *
 * One tool call = one API request = one full re-read of the context. So burn is
 * (number of requests) x (context size at the time), and it does NOT depend on how
 * much the model writes. A session sitting at 850k spends 850k tokens to answer
 * "ls". The same work in a fresh 100k session costs an eighth of that. That ratio,
 * not the invoice, is what this tool measures.
 *
 * Latency follows the same curve: measured here, seconds-per-1k-output-tokens
 * roughly doubled between a 100k and an 850k context. Saving tokens and going
 * faster are the same action.
 *
 * Thresholds are NOT hardcoded. The context window is inferred from the largest
 * request ever observed, then throttle = 40% of window, rotate = 75%. A 1M machine
 * gets 400k/750k; a 200k machine gets 80k/150k. The resolved window is cached to
 * ~/.claude/.ctx-window for ctx-probe to reuse.
 * Override with CTX_THROTTLE / CTX_ROTATE / CTX_WINDOW (token counts).
 *
 * Two details that are easy to get wrong, both learned the hard way:
 *
 *   1. Deduplicate by requestId. The same assistant message is flushed to the
 *      transcript 1-2 extra times with identical usage. Not deduplicating inflates
 *      every total by nearly 2x.
 *
 *   2. Judge on CURRENT context, not peak. A session that compacted keeps its high
 *      peak forever, so peak-based judging marks healthy sessions red permanently.
 *      Compaction is normal operation, not failure.
 */
import { readdirSync, existsSync, createReadStream, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

// An instance with no request in this long is history: its watermark is for
// hindsight only. Telling you to rotate something already stopped is noise.
const ACTIVE_WINDOW_MS = 2 * 60 * 60 * 1000;
const THROTTLE_RATIO = 0.4;
const ROTATE_RATIO = 0.75;

const showCost = process.argv.includes('--cost');
const scanAll = process.argv.includes('--all');

/**
 * Optional. Published list prices in USD per million tokens, as of 2026-08 —
 * VERIFY before trusting any dollar figure. Only used with --cost.
 *
 * Matching is by substring so dated ids (claude-opus-5-20260101) resolve. Models
 * that match nothing are counted in tokens but excluded from the dollar sum: a
 * wrong number is worse than no number, and gateways routinely rewrite model ids.
 *
 * Add your own in ~/.claude/ctx-watch-pricing.json, same shape:
 *   { "glm-5": { "in": 0.6, "cacheWrite": 0.75, "cacheRead": 0.06, "out": 2.2 } }
 */
const DEFAULT_PRICING = {
  'claude-opus-5': { in: 15, cacheWrite: 18.75, cacheRead: 1.5, out: 75 },
  'claude-opus-4': { in: 15, cacheWrite: 18.75, cacheRead: 1.5, out: 75 },
  'claude-sonnet-5': { in: 3, cacheWrite: 3.75, cacheRead: 0.3, out: 15 },
  'claude-sonnet-4': { in: 3, cacheWrite: 3.75, cacheRead: 0.3, out: 15 },
  'claude-haiku-4-5': { in: 1, cacheWrite: 1.25, cacheRead: 0.1, out: 5 },
};

const PRICING = (() => {
  const table = { ...DEFAULT_PRICING };
  try {
    Object.assign(table, JSON.parse(readFileSync(join(homedir(), '.claude/ctx-watch-pricing.json'), 'utf8')));
  } catch {} // no override file is the normal case
  return table;
})();

/** Longest substring match wins, so claude-haiku-4-5 beats a bare claude-haiku entry. */
function priceOf(model) {
  let best = null;
  for (const [key, val] of Object.entries(PRICING)) {
    if (model.includes(key) && (!best || key.length > best.key.length)) best = { key, val };
  }
  return best?.val || null;
}

const ROOT = join(homedir(), '.claude/projects');
// Claude Code replaces every non-alphanumeric character in the project path with '-'
const projectDirs = scanAll
  ? readdirSync(ROOT).map((d) => join(ROOT, d)).filter((d) => statSync(d).isDirectory())
  : [join(ROOT, process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))];

if (!scanAll && !existsSync(projectDirs[0])) {
  console.log(`No transcripts found for this directory: ${projectDirs[0]}`);
  console.log('(run from a project root, or pass --all)\n');
  process.exit(0);
}

/** Read one transcript, dedupe by requestId, record every context size. */
async function scan(file) {
  const seen = new Set();
  const t = { calls: 0, peak: 0, last: 0, burn: 0, ctxs: [], byModel: {}, lat: [] };
  // Only measure "tool_result returned -> assistant replied" so human thinking time
  // never lands in the latency numbers.
  let toolTs = null;

  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    if (o.type === 'user' && Array.isArray(o.message?.content) && o.message.content.some((c) => c.type === 'tool_result')) {
      toolTs = Date.parse(o.timestamp);
      continue;
    }
    if (o.type !== 'assistant' || !o.message) continue;

    const key = o.requestId || o.message.id;
    if (seen.has(key)) {
      toolTs = null; // duplicate flush of one message, do not sample it twice
      continue;
    }
    seen.add(key);

    const u = o.message.usage || {};
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    t.calls++;
    t.burn += ctx; // every request re-reads the whole context; this is the real spend
    if (ctx) {
      t.ctxs.push(ctx);
      t.last = ctx;
      if (ctx > t.peak) t.peak = ctx;
    }

    if (showCost) {
      const m = (t.byModel[o.message.model || 'unknown'] ||= { in: 0, cacheWrite: 0, cacheRead: 0, out: 0 });
      m.in += u.input_tokens || 0;
      m.cacheWrite += u.cache_creation_input_tokens || 0;
      m.cacheRead += u.cache_read_input_tokens || 0;
      m.out += u.output_tokens || 0;
    }

    if (toolTs && ctx > 0 && u.output_tokens > 0) {
      const ms = Date.parse(o.timestamp) - toolTs;
      if (ms > 0 && ms < 300_000) t.lat.push({ ctx, ms, out: u.output_tokens });
    }
    toolTs = null;
  }
  return t;
}

/** Collect main sessions plus their subagents. */
async function collect(projectDir) {
  const rows = [];
  const proj = projectDir.split('/').pop();
  if (!existsSync(projectDir)) return rows;

  for (const f of readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'))) {
    const id = f.replace('.jsonl', '');
    rows.push({ kind: 'session', name: id.slice(0, 8), proj, mtime: statSync(join(projectDir, f)).mtimeMs, ...(await scan(join(projectDir, f))) });

    const subDir = join(projectDir, id, 'subagents');
    if (!existsSync(subDir)) continue;
    for (const sf of readdirSync(subDir).filter((f) => f.endsWith('.jsonl'))) {
      let desc = sf.replace('.jsonl', '');
      const meta = join(subDir, sf.replace('.jsonl', '.meta.json'));
      if (existsSync(meta)) {
        try {
          desc = JSON.parse(readFileSync(meta, 'utf8')).description || desc;
        } catch {}
      }
      rows.push({ kind: ' subagent', name: desc.slice(0, 26), proj, mtime: statSync(join(subDir, sf)).mtimeMs, ...(await scan(join(subDir, sf))) });
    }
  }
  return rows;
}

/** Infer the context window from the largest request ever seen on this machine. */
function calibrate(rows) {
  const observedPeak = Math.max(0, ...rows.map((r) => r.peak));
  const window = Number(process.env.CTX_WINDOW) || (observedPeak > 250_000 ? 1_000_000 : 200_000);
  // Cache it for ctx-probe: the probe only sees the latest record and would
  // misjudge a 1M window as 200k early in a session.
  try {
    writeFileSync(join(homedir(), '.claude/.ctx-window'), String(window));
  } catch {}
  return {
    window,
    throttle: Number(process.env.CTX_THROTTLE) || Math.round(window * THROTTLE_RATIO),
    rotate: Number(process.env.CTX_ROTATE) || Math.round(window * ROTATE_RATIO),
  };
}

/**
 * Where latency starts degrading on THIS machine: first bucket whose
 * seconds-per-1k-output-tokens exceeds the cheapest bucket by 30%.
 * Informational only — the gates stay anchored to the window ratio so this script
 * can never contradict the rules it enforces. Mixing models in one sample makes
 * this noisy; treat it as a hint, not a measurement.
 */
function inflection(rows) {
  const bucket = new Map();
  for (const r of rows) {
    for (const s of r.lat) {
      const k = Math.floor(s.ctx / 100_000);
      const c = bucket.get(k) || { ms: 0, out: 0, n: 0 };
      c.ms += s.ms;
      c.out += s.out;
      c.n++;
      bucket.set(k, c);
    }
  }
  const pts = [...bucket.entries()]
    .filter(([, v]) => v.n >= 5)
    .map(([k, v]) => ({ k, perK: v.ms / v.out }))
    .sort((a, b) => a.k - b.k);
  if (pts.length < 2) return null;
  const base = pts[0].perK;
  return { at: pts.find((p) => p.perK > base * 1.3)?.k * 100_000 || null, pts };
}

let rows = [];
for (const d of projectDirs) rows = rows.concat(await collect(d));
rows = rows.filter((r) => r.calls > 0).sort((a, b) => b.burn - a.burn);

const { window, throttle, rotate } = calibrate(rows);
const n = (x) => Math.round(x).toLocaleString('en-US');
const M = (x) => (x >= 1e9 ? (x / 1e9).toFixed(1) + 'B' : (x / 1e6).toFixed(1) + 'M');
const now = Date.now();
const isActive = (r) => now - r.mtime < ACTIVE_WINDOW_MS;
const level = (r) => (r.last >= rotate ? 'rotate' : r.last >= throttle ? 'throttle' : 'ok');

/**
 * Tokens added per call, measured over the LAST QUARTER of the session only.
 *
 * Not the whole-session average: growth rate is not constant. Measured on a real
 * session, the four quarters ran 2037 / 2119 / 1352 / 816 tokens per call — early
 * exploration reads far more than later execution, and throttling cuts it further.
 * A whole-session average would understate what the session is doing right now,
 * which is the only thing "how much longer can this run" depends on.
 */
function recentRate(ctxs) {
  if (ctxs.length < 8) return 0; // too few points for the slope to mean anything
  const seg = ctxs.slice(Math.floor(ctxs.length * 0.75));
  const span = seg.length - 1;
  return span > 0 ? (seg[seg.length - 1] - seg[0]) / span : 0;
}

/** Calls left before the handoff line at the current rate. */
function callsLeft(r) {
  const rate = recentRate(r.ctxs);
  if (rate <= 0) return null; // flat or shrinking (compacted) — no meaningful estimate
  const room = rotate - r.last;
  return room <= 0 ? 0 : Math.round(room / rate);
}

console.log(`\nContext watermark  (* = active within 2h;  window ${n(window)} -> throttle ${n(throttle)}, rotate ${n(rotate)})`);
console.log(`rate = tokens added per call recently;  left = calls remaining before the handoff line\n`);
console.log(`  type       name                        calls   current      peak    burned   rate   left  state${scanAll ? '   project' : ''}`);
for (const r of rows) {
  const lv = level(r);
  const state = lv === 'rotate' ? 'ROTATE' : lv === 'throttle' ? 'THROTTLE' : 'ok';
  const rate = recentRate(r.ctxs);
  const left = callsLeft(r);
  console.log(
    `${isActive(r) ? '*' : ' '} ${r.kind.padEnd(9)} ${r.name.padEnd(26)} ${String(r.calls).padStart(5)} ${n(r.last).padStart(9)} ${n(r.peak).padStart(9)} ${M(r.burn).padStart(9)} ${(rate > 0 ? n(rate) : '-').padStart(6)} ${(left === null ? '-' : String(left)).padStart(6)}  ${lv !== 'ok' && !isActive(r) ? 'past' : state}${scanAll ? '   ' + r.proj.slice(-20) : ''}`
  );
}

const calls = rows.reduce((a, r) => a + r.calls, 0);
const burn = rows.reduce((a, r) => a + r.burn, 0);
// Tokens spent re-reading context above the throttle line. This is the avoidable
// part: the same work done below the line would not have paid it.
const overflow = rows.reduce((a, r) => a + r.ctxs.reduce((s, c) => s + Math.max(0, c - throttle), 0), 0);

console.log(`\n${calls} requests burned ${M(burn)} input tokens (avg ${n(burn / calls)} per call).`);
if (overflow > 0) {
  console.log(`${M(overflow)} of that (${((overflow / burn) * 100).toFixed(0)}%) was context above the throttle line —`);
  console.log(`re-reads that earlier handoffs would have avoided.`);
}

/**
 * Cache per-session growth rates for ctx-probe.
 *
 * The probe reads one record and cannot compute a slope without giving up the tail
 * read that keeps it at ~45ms. Rates are keyed by the same 8-char session prefix the
 * probe derives from its transcript filename. .ctx-window is still written by
 * calibrate() so older probes keep working.
 */
try {
  const rates = {};
  for (const r of rows) {
    const rate = recentRate(r.ctxs);
    if (rate > 0) rates[r.name] = Math.round(rate);
  }
  writeFileSync(join(homedir(), '.claude/.ctx-state'), JSON.stringify({ window, rates }));
} catch {} // caching is best-effort; the probe degrades to its old wording

/**
 * Show whether throttling is actually working on the busiest live session.
 * Capacity is set by the growth rate, not by the threshold: halving the rate
 * doubles how long the session can run before it has to hand off.
 */
const busiest = rows.filter((r) => isActive(r) && r.ctxs.length >= 16).sort((a, b) => b.calls - a.calls)[0];
if (busiest) {
  // burn/calls is the average CONTEXT SIZE, not the growth rate — different units.
  // The lifetime rate is the slope across the whole session.
  const c = busiest.ctxs;
  const whole = (c[c.length - 1] - c[0]) / (c.length - 1);
  const recent = recentRate(busiest.ctxs);
  if (recent > 0) {
    const trend = recent < whole * 0.8 ? 'slowing — throttling is working' : recent > whole * 1.2 ? 'accelerating' : 'steady';
    console.log(`\n${busiest.name}: growing ${n(recent)}/call recently vs ${n(whole)} lifetime average (${trend}).`);
    console.log(`At the recent rate it has ~${callsLeft(busiest)} calls before the handoff line.`);
  }
}

if (showCost) {
  let cost = 0;
  let unpriced = 0;
  const unknown = new Set();
  for (const r of rows) {
    for (const [model, m] of Object.entries(r.byModel)) {
      const p = priceOf(model);
      if (!p) {
        unpriced += m.in + m.cacheWrite + m.cacheRead + m.out;
        unknown.add(model);
        continue;
      }
      cost += (m.in / 1e6) * p.in + (m.cacheWrite / 1e6) * p.cacheWrite + (m.cacheRead / 1e6) * p.cacheRead + (m.out / 1e6) * p.out;
    }
  }
  console.log(`\n~$${cost.toFixed(0)} at list price (on a subscription this is quota, not a bill).`);
  if (unpriced > 0) {
    console.log(`  ${M(unpriced)} tokens excluded — no price known for: ${[...unknown].join(', ')}`);
    console.log(`  add it to ~/.claude/ctx-watch-pricing.json to include it`);
  }
}

const toRotate = rows.filter((r) => isActive(r) && level(r) === 'rotate');
const toThrottle = rows.filter((r) => isActive(r) && level(r) === 'throttle');

if (toRotate.length) {
  console.log(`\nROTATE — ${toRotate.length} active instance(s) past ${n(rotate)}:`);
  toRotate.forEach((r) => console.log(`  - ${r.name}  at ${n(r.last)}, burning ${M(r.last * 100)} per 100 calls`));
  console.log('  Hand off at the next clean boundary. A subagent can only be rotated by the');
  console.log('  session that spawned it; a main session can only close itself out.');
}
if (toThrottle.length) {
  console.log(`\nTHROTTLE — ${toThrottle.length} active instance(s) past ${n(throttle)}. Do not rotate, slow the growth:`);
  toThrottle.forEach((r) => console.log(`  - ${r.name}  at ${n(r.last)}, burning ${M(r.last * 100)} per 100 calls`));
  console.log('  Narrow any tool call expected to return >5KB; stop re-reading whole files;');
  console.log('  write new output to disk and keep only the path in context.');
}
if (!toRotate.length && !toThrottle.length) console.log('\nAll active instances are below the throttle line.');

const inf = inflection(rows);
if (inf) {
  console.log(`\nMeasured latency (sec per 1k output tokens): ${inf.pts.map((p) => `${p.k * 100}k:${p.perK.toFixed(1)}`).join('  ')}`);
  if (inf.at) console.log(`Degradation starts near ${n(inf.at)}. Informational — noisy when several models share the sample.`);
}
console.log();
