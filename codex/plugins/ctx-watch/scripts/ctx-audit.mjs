#!/usr/bin/env node
/**
 * ctx-audit (Codex edition) — context watermark report for humans.
 *
 * Usage:
 *   node scripts/ctx-audit.mjs           # sessions whose cwd is the current dir
 *   node scripts/ctx-audit.mjs --all     # every session on this machine
 *   node scripts/ctx-audit.mjs --days 7  # recency cutoff (default 14)
 *
 * Always exits 0. This reports, it never blocks.
 *
 * THE POINT IS TOKEN BURN, NOT DOLLARS.
 *
 * One model request re-reads the whole context. Burn is (requests x context size)
 * and does not scale with output length. A session near its window limit spends
 * that much to answer "ls". Latency tracks the same curve.
 *
 * Codex makes this easier to measure than most harnesses. Every `token_count`
 * event carries, already summed:
 *   info.last_token_usage.input_tokens   -> the current watermark
 *   info.total_token_usage.input_tokens  -> cumulative burn
 *   info.model_context_window            -> the real window, no guessing
 *   rate_limits.{primary,secondary}      -> how much of the plan is spent
 *
 * Because those are cumulative, this reads only the HEAD (for cwd) and the TAIL
 * (for the latest counts) of each rollout file. On a multi-GB session store that is
 * the difference between seconds and minutes — a tool about not wasting resources
 * should not waste yours.
 */
import { readdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const THROTTLE_RATIO = 0.4;
const ROTATE_RATIO = 0.75;
const ACTIVE_WINDOW_MS = 2 * 60 * 60 * 1000;

const args = process.argv.slice(2);
const scanAll = args.includes('--all');
const days = Number(args[args.indexOf('--days') + 1]) || 14;

const SESSIONS = join(homedir(), '.codex', 'sessions');
if (!existsSync(SESSIONS)) {
  console.log(`\nNo Codex sessions found at ${SESSIONS}\n`);
  process.exit(0);
}

function slice(file, bytes, fromEnd) {
  const size = statSync(file).size;
  const len = Math.min(size, bytes);
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
    return buf.toString('utf8').split('\n');
  } finally {
    closeSync(fd);
  }
}
const head = (f, b = 64 * 1024) => slice(f, b, false);
const tail = (f, b = 256 * 1024) => slice(f, b, true);

function rolloutFiles() {
  const out = [];
  const cutoff = Date.now() - days * 86400_000;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        const st = statSync(p);
        if (st.mtimeMs >= cutoff) out.push({ file: p, mtime: st.mtimeMs });
      }
    }
  };
  walk(SESSIONS);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** cwd lives in session_meta at the top of the rollout. */
function readMeta(file) {
  for (const line of head(file)) {
    if (!line.includes('session_meta')) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === 'session_meta') return { cwd: o.payload?.cwd || '', id: o.payload?.id || '' };
    } catch {}
  }
  return null;
}

/**
 * The last token_count event holds every cumulative number we need, and the
 * preceding ones give the growth rate. Collect a short trailing series of
 * watermarks so "how much longer can this run" can be answered.
 */
function readCounts(file) {
  for (const bytes of [256 * 1024, 2 * 1024 * 1024, 16 * 1024 * 1024]) {
    const lines = tail(file, bytes);
    const series = [];
    let latest = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('token_count')) continue;
      try {
        const o = JSON.parse(lines[i]);
        const info = o?.payload?.info;
        if (o.type === 'event_msg' && o.payload?.type === 'token_count' && info) {
          const cur = info.last_token_usage?.input_tokens || 0;
          // Walking backwards, so unshift keeps the series chronological.
          if (cur) series.unshift(cur);
          if (!latest) {
            latest = {
              current: cur,
              burn: info.total_token_usage?.input_tokens || 0,
              window: info.model_context_window || 0,
              limits: o.payload.rate_limits || null,
            };
          }
          if (series.length >= 40) break; // enough for a slope, keeps the read cheap
        }
      } catch {} // the first line of a tail slice is usually truncated
    }
    if (latest) return { ...latest, series };
    if (statSync(file).size <= bytes) break;
  }
  return null;
}

/**
 * Tokens added per request over the last quarter of the sampled series.
 * Not a whole-session average: growth rate is not constant — early exploration
 * reads far more than later execution, and throttling cuts it further still.
 */
function recentRate(series = []) {
  if (series.length < 8) return 0;
  const seg = series.slice(Math.floor(series.length * 0.75));
  const span = seg.length - 1;
  return span > 0 ? (seg[seg.length - 1] - seg[0]) / span : 0;
}

/**
 * Model appears in turn_context; session_meta leaves it null. Look in the tail
 * first (the newest turn wins), then the head — short sessions emit turn_context
 * only near the start, and tailing alone reported them as unknown.
 */
function readModel(file) {
  for (const [lines, reverse] of [[tail(file, 512 * 1024), true], [head(file, 256 * 1024), false]]) {
    const seq = reverse ? [...lines].reverse() : lines;
    for (const line of seq) {
      if (!line.includes('turn_context')) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === 'turn_context' && o.payload?.model) return o.payload.model;
      } catch {}
    }
  }
  return '';
}

const cwd = process.cwd();
const rows = [];
for (const { file, mtime } of rolloutFiles()) {
  const meta = readMeta(file);
  if (!meta) continue;
  if (!scanAll && meta.cwd !== cwd) continue;
  const counts = readCounts(file);
  if (!counts?.current) continue;
  rows.push({ ...meta, ...counts, mtime, model: readModel(file), name: meta.id.slice(0, 13) });
}

// Resuming a session writes a new rollout file under the SAME session id. Keeping
// every file would list one conversation several times and double-count its burn.
// The newest file is the live state, so that one wins.
const newestById = new Map();
for (const r of rows) {
  const prev = newestById.get(r.id);
  if (!prev || r.mtime > prev.mtime) newestById.set(r.id, r);
}
rows.length = 0;
rows.push(...newestById.values());

if (!rows.length) {
  console.log(scanAll ? `\nNo sessions with token counts in the last ${days} days.\n` : `\nNo Codex sessions for ${cwd} in the last ${days} days. Try --all.\n`);
  process.exit(0);
}
rows.sort((a, b) => b.burn - a.burn);

// Codex reports the real window per session, so nothing is inferred. Sessions can
// differ (different models), so the lines are computed per row rather than globally.
const lineOf = (r) => {
  const w = Number(process.env.CTX_WINDOW) || r.window || 200_000;
  return {
    window: w,
    throttle: Number(process.env.CTX_THROTTLE) || Math.round(w * THROTTLE_RATIO),
    rotate: Number(process.env.CTX_ROTATE) || Math.round(w * ROTATE_RATIO),
  };
};
const level = (r) => {
  const l = lineOf(r);
  return r.current >= l.rotate ? 'rotate' : r.current >= l.throttle ? 'throttle' : 'ok';
};

const n = (x) => Math.round(x).toLocaleString('en-US');
const M = (x) => (x >= 1e9 ? (x / 1e9).toFixed(1) + 'B' : (x / 1e6).toFixed(1) + 'M');
const now = Date.now();
const isActive = (r) => now - r.mtime < ACTIVE_WINDOW_MS;

console.log(`\nContext watermark — Codex  (* = active within 2h, last ${days} days)`);
console.log(`rate = tokens added per request recently;  left = requests remaining before the handoff line\n`);
console.log(`  session        model           current    window   used%    burned   rate   left  state`);
for (const r of rows) {
  const l = lineOf(r);
  const lv = level(r);
  const pct = l.window ? ((r.current / l.window) * 100).toFixed(0) + '%' : '-';
  const state = lv !== 'ok' && !isActive(r) ? 'past' : lv === 'rotate' ? 'ROTATE' : lv === 'throttle' ? 'THROTTLE' : 'ok';
  console.log(
    `${isActive(r) ? '*' : ' '} ${r.name.padEnd(14)} ${(r.model || '?').padEnd(13)} ${n(r.current).padStart(9)} ${n(l.window).padStart(9)} ${pct.padStart(6)} ${M(r.burn).padStart(9)} ${(recentRate(r.series) > 0 ? n(recentRate(r.series)) : '-').padStart(6)} ${(() => { const rt = recentRate(r.series); if (rt <= 0) return '-'; const room = lineOf(r).rotate - r.current; return String(room <= 0 ? 0 : Math.round(room / rt)); })().padStart(6)}  ${state}`
  );
}

console.log(`\n${rows.length} session(s), ${M(rows.reduce((a, r) => a + r.burn, 0))} input tokens burned in total.`);

// Codex hands us the plan's own accounting. That beats a list-price guess outright:
// it is the actual number the provider is billing against.
const withLimits = rows.filter((r) => isActive(r) && r.limits);
if (withLimits.length) {
  const l = withLimits[0].limits;
  const fmt = (w) => `${w.used_percent}% used, resets ${new Date(w.resets_at * 1000).toLocaleString()}`;
  console.log(`\nPlan usage (${l.plan_type || 'unknown plan'}):`);
  if (l.primary) console.log(`  ${Math.round((l.primary.window_minutes || 0) / 60)}h window:  ${fmt(l.primary)}`);
  if (l.secondary) console.log(`  ${Math.round((l.secondary.window_minutes || 0) / 1440)}d window:  ${fmt(l.secondary)}`);
}

const toRotate = rows.filter((r) => isActive(r) && level(r) === 'rotate');
const toThrottle = rows.filter((r) => isActive(r) && level(r) === 'throttle');

if (toRotate.length) {
  console.log(`\nROTATE — ${toRotate.length} active session(s) past 75% of the window:`);
  toRotate.forEach((r) => console.log(`  - ${r.name} at ${n(r.current)} of ${n(lineOf(r).window)}, burning ${M(r.current * 100)} per 100 requests`));
  console.log('  Hand off at the next clean boundary: finish the verifiable unit, update the');
  console.log('  handoff notes, then start a fresh session and resume from those notes.');
}
if (toThrottle.length) {
  console.log(`\nTHROTTLE — ${toThrottle.length} active session(s) past 40%. Do not hand off, slow the growth:`);
  toThrottle.forEach((r) => console.log(`  - ${r.name} at ${n(r.current)} of ${n(lineOf(r).window)}, burning ${M(r.current * 100)} per 100 requests`));
  console.log('  Narrow any command expected to return >5KB; stop re-reading whole files;');
  console.log('  write new output to disk and keep only the path in context.');
}
if (!toRotate.length && !toThrottle.length) console.log('\nAll active sessions are below the throttle line.');
console.log();
