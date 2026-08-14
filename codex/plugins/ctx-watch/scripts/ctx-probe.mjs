#!/usr/bin/env node
/**
 * ctx-probe (Codex edition) — lightweight watermark probe, built for hooks.
 *
 * Wired to PostToolUse, where Codex automatically injects additional context from
 * the hook response. Reads only the tail of the current transcript and the last
 * `token_count` event in it, which already carries the watermark AND the real
 * context window — so unlike the Claude Code edition, nothing has to be inferred or
 * cached. Typical run: a few milliseconds.
 *
 * Debounced: each level is announced once per session (state in PLUGIN_DATA, with
 * OS temp fallback when missing or unusable). Otherwise every tool call appends
 * another notice, and those notices live in the context forever — the exact failure
 * this plugin exists to prevent.
 *
 * TWO THINGS ARE DEFENSIVE ON PURPOSE:
 *
 *   1. Input keys. Codex hook payloads are read with several fallback names, the
 *      same way the shipped subagent-orchestration hook does it. If no session
 *      identifier arrives, we fall back to "newest rollout whose cwd matches".
 *
 *   2. Output shape. Codex injects `hookSpecificOutput.additionalContext` back into
 *      the model context. `systemMessage` is emitted alongside it so the warning is
 *      also visible to the user.
 *
 * Always exits 0. It must never block a tool call.
 */
import { readdirSync, existsSync, statSync, openSync, readSync, closeSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const THROTTLE_RATIO = 0.4;
const ROTATE_RATIO = 0.75;
const SESSIONS = join(homedir(), '.codex', 'sessions');

let hookMode = false;

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

/** Read hook JSON from stdin, tolerating the key-name variation across versions. */
function readHookInput() {
  try {
    const raw = readFileSync(0, 'utf8');
    if (!raw.trim()) return null;
    const j = JSON.parse(raw);
    hookMode = true;
    const sessionId = ['session_id', 'thread_id', 'conversation_id', 'id']
      .map((k) => j[k])
      .find((value) => typeof value === 'string' && value);
    const cwd = typeof j.cwd === 'string' && j.cwd ? j.cwd : undefined;
    for (const k of ['transcript_path', 'rollout_path', 'session_file', 'thread_path']) {
      if (typeof j[k] === 'string' && existsSync(j[k])) return { file: j[k], sessionId, cwd };
    }
    return { sessionId, cwd };
  } catch {
    return null;
  }
}

/** Newest rollout, optionally filtered by session id or by matching cwd. */
function findRollout({ sessionId: id, cwd } = {}) {
  if (!existsSync(SESSIONS)) return null;
  const files = [];
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
      else if (e.name.endsWith('.jsonl')) files.push({ p, m: statSync(p).mtimeMs });
    }
  };
  walk(SESSIONS);
  files.sort((a, b) => b.m - a.m);

  const sessionCwd = cwd || process.cwd();
  for (const { p } of files.slice(0, 60)) {
    for (const line of slice(p, 64 * 1024, false)) {
      if (!line.includes('session_meta')) continue;
      try {
        const o = JSON.parse(line);
        if (o.type !== 'session_meta') continue;
        if (id) {
          if (o.payload?.id === id) return p;
        } else if (o.payload?.cwd === sessionCwd) {
          return p; // newest first, so the first cwd match is the live one
        }
      } catch {}
      break; // session_meta is at the top; stop scanning this file's head
    }
  }
  return null;
}

/** Last token_count event: watermark and the real window, both already computed. */
function readCounts(file) {
  for (const bytes of [256 * 1024, 2 * 1024 * 1024]) {
    const lines = slice(file, bytes, true);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('token_count')) continue;
      try {
        const o = JSON.parse(lines[i]);
        const info = o?.payload?.info;
        if (o.type === 'event_msg' && o.payload?.type === 'token_count' && info) {
          return {
            current: info.last_token_usage?.input_tokens || 0,
            window: info.model_context_window || 0,
            limits: o.payload.rate_limits || null,
          };
        }
      } catch {} // truncated first line of a tail slice, expected
    }
    if (statSync(file).size <= bytes) break;
  }
  return null;
}

const input = readHookInput();
const file = input?.file || findRollout(input || {}) || (process.argv[2] && existsSync(process.argv[2]) ? process.argv[2] : null);
if (!file) process.exit(0);

let counts = null;
try {
  counts = readCounts(file);
} catch {
  process.exit(0); // a probe never breaks the thing it is watching
}
if (!counts?.current) process.exit(0);

const window = Number(process.env.CTX_WINDOW) || counts.window || 200_000;
const throttle = Number(process.env.CTX_THROTTLE) || Math.round(window * THROTTLE_RATIO);
const rotate = Number(process.env.CTX_ROTATE) || Math.round(window * ROTATE_RATIO);
const ctx = counts.current;
const level = ctx >= rotate ? 'rotate' : ctx >= throttle ? 'throttle' : 'ok';

const stateKey = (input?.sessionId || basename(file)).replace(/[^a-zA-Z0-9_-]/g, '');
let prev = '';
const stateRoots = process.env.PLUGIN_DATA ? [process.env.PLUGIN_DATA, tmpdir()] : [tmpdir()];
for (const stateRoot of new Set(stateRoots)) {
  try {
    mkdirSync(stateRoot, { recursive: true });
    const stateFile = join(stateRoot, `ctx-probe-${stateKey}.state`);
    try {
      prev = readFileSync(stateFile, 'utf8').trim();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    writeFileSync(stateFile, level);
    break;
  } catch {
    prev = '';
  }
}
if (level === prev) process.exit(0);
if (level === 'ok') process.exit(0);

const n = (x) => Math.round(x).toLocaleString('en-US');
const pct = ((ctx / window) * 100).toFixed(0);
const burn100 = ((ctx * 100) / 1e6).toFixed(1);
const plan = counts.limits?.primary?.used_percent != null ? ` Plan usage is at ${counts.limits.primary.used_percent}% of the current window.` : '';

const msg =
  level === 'throttle'
    ? `[ctx-watch] Context is at ${n(ctx)} tokens, ${pct}% of the ${n(window)} window — past the throttle line. ` +
      `Every request now re-reads that much: the next 100 will burn ~${burn100}M tokens.${plan} ` +
      `Do NOT hand off yet — slow the growth instead. Tell the user you are throttling, then keep working. ` +
      `From here: narrow any command expected to return more than ~5KB before running it (grep for line numbers, ` +
      `then read that range; pipe through head/jq; use --quiet). Stop re-reading whole files. Write new output to ` +
      `disk and keep only the path plus a 3-line summary.`
    : `[ctx-watch] Context is at ${n(ctx)} tokens, ${pct}% of the ${n(window)} window — past the handoff line. ` +
      `The next 100 requests will burn ~${burn100}M tokens, and latency at this size runs well above a fresh ` +
      `session.${plan} Report the watermark to the user, say where the next clean boundary is (a verifiable unit ` +
      `finished with the handoff notes written), and let THEM decide whether to continue. Do not weigh it for them, ` +
      `and do not stop dead waiting for instructions. Make sure the handoff notes are current first: files changed, ` +
      `work remaining, verification evidence with exit codes, and the traps a fresh session would otherwise re-hit.`;

if (hookMode) {
  // Both channels on purpose — see the header note about additionalContext.
  console.log(
    JSON.stringify({
      systemMessage: msg,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
    })
  );
} else {
  console.log(msg);
}
