#!/usr/bin/env node
/**
 * ctx-probe — lightweight watermark probe, built for hooks.
 *
 * Division of labour with ctx-audit:
 *   ctx-audit  full scan, every instance, a report for a human. Seconds on a big
 *              transcript.
 *   ctx-probe  tail of the current transcript only, latest usage record. ~45ms.
 *              For the model, fired automatically after every tool call.
 *
 * Reading only the tail is not an optimisation, it is the requirement: a hook that
 * runs on every tool call must not turn "the tool that saves tokens" into "the tool
 * that slows down every step".
 *
 * Debounced — each level is announced once (state in tmpdir). Otherwise every tool
 * call appends another notice, and those notices live in the context forever, which
 * is exactly the failure mode this plugin exists to prevent.
 *
 * Usage:
 *   hook     hook JSON on stdin (transcript_path is read from it)
 *   manual   node scripts/ctx-probe.mjs [path/to/transcript.jsonl]
 * Always exits 0. It must never block a tool call.
 */
import { statSync, openSync, readSync, closeSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const THROTTLE_RATIO = 0.4;
const ROTATE_RATIO = 0.75;

let hookMode = false; // hooks want JSON back, humans want a sentence

/** Read the last n bytes of a file, split into lines. */
function tail(file, bytes) {
  const size = statSync(file).size;
  const len = Math.min(size, bytes);
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').split('\n');
  } finally {
    closeSync(fd);
  }
}

/** Walk backwards for the most recent assistant record carrying usage. */
function latestContextSize(file) {
  for (const bytes of [256 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
    const lines = tail(file, bytes);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"usage"')) continue;
      let o;
      try {
        o = JSON.parse(lines[i]);
      } catch {
        continue; // the first line of a tail slice is usually truncated
      }
      const u = o?.message?.usage;
      if (o.type === 'assistant' && u) {
        return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      }
    }
    if (statSync(file).size <= bytes) break; // whole file already read
  }
  return 0;
}

function resolveTranscript() {
  const arg = process.argv[2];
  if (arg && existsSync(arg)) return arg;

  try {
    const raw = readFileSync(0, 'utf8');
    if (raw.trim()) {
      const j = JSON.parse(raw);
      hookMode = true;
      if (j.transcript_path && existsSync(j.transcript_path)) return j.transcript_path;
    }
  } catch {} // no stdin, or not JSON: fall through

  const dir = join(homedir(), '.claude/projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? files[0].f : null;
}

const file = resolveTranscript();
if (!file) process.exit(0);

let ctx = 0;
try {
  ctx = latestContextSize(file);
} catch {
  process.exit(0); // a probe never breaks the thing it is watching
}
if (!ctx) process.exit(0);

/**
 * The probe must not infer the window itself. It sees one record; early in a
 * session the watermark is low and a 1M window would be misread as 200k, firing
 * "time to hand off" at 170k. Read the value ctx-audit cached, else assume 1M.
 * Failing silent beats a false alarm: a false alarm pollutes the context AND
 * pushes the agent into the wrong action.
 */
let window = Number(process.env.CTX_WINDOW) || 0;
if (!window) {
  try {
    window = Number(readFileSync(join(homedir(), '.claude/.ctx-window'), 'utf8').trim());
  } catch {}
}
if (!window) window = 1_000_000;

const throttle = Number(process.env.CTX_THROTTLE) || Math.round(window * THROTTLE_RATIO);
const rotate = Number(process.env.CTX_ROTATE) || Math.round(window * ROTATE_RATIO);
const level = ctx >= rotate ? 'rotate' : ctx >= throttle ? 'throttle' : 'ok';

// Debounce: announce each level once per transcript.
const stateFile = join(tmpdir(), 'ctx-probe-' + file.split('/').pop().slice(0, 8) + '.state');
let prev = '';
try {
  prev = readFileSync(stateFile, 'utf8').trim();
} catch {}
if (level === prev) process.exit(0);
try {
  writeFileSync(stateFile, level);
} catch {}
if (level === 'ok') process.exit(0);

const n = (x) => Math.round(x).toLocaleString('en-US');
const burn100 = (ctx * 100) / 1e6;

const msg =
  level === 'throttle'
    ? `[ctx-watch] Context is at ${n(ctx)} tokens, past the throttle line of ${n(throttle)}. ` +
      `Every tool call now re-reads that much: the next 100 calls will burn ~${burn100.toFixed(1)}M tokens. ` +
      `Do NOT hand off yet — slow the growth instead. Tell the user you are throttling, then keep working. ` +
      `From here: narrow any tool call expected to return more than ~5KB before running it (grep to find the line ` +
      `numbers, then read that range; pipe through head/jq; use --quiet). Stop re-reading whole files. Prefer text ` +
      `page reads over screenshots — an image is roughly 500x the tokens and never leaves the context. Write new ` +
      `output to disk and keep only the path plus a 3-line summary.`
    : `[ctx-watch] Context is at ${n(ctx)} tokens, past the handoff line of ${n(rotate)}. ` +
      `The next 100 tool calls will burn ~${burn100.toFixed(1)}M tokens, and latency here runs about double a fresh ` +
      `session. Report the watermark to the user, say where the next clean boundary is (a verifiable unit finished ` +
      `with the handoff notes written), and let THEM decide whether to continue. Do not weigh it for them, and do ` +
      `not stop dead waiting for instructions. Make sure the handoff notes are current first: files changed, work ` +
      `remaining, verification evidence with exit codes, and the traps a fresh instance would otherwise re-hit.`;

// Hooks must use additionalContext. Bare stdout only reaches the transcript and is
// not guaranteed to enter the model's context. suppressOutput keeps it out of the
// terminal: this line is for the model, the human reads ctx-audit.
if (hookMode) {
  console.log(
    JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
    })
  );
} else {
  console.log(msg);
}
