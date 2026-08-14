import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scripts = join(pluginRoot, 'scripts');

function run(script, payload, env = {}) {
  return spawnSync(process.execPath, [join(scripts, script)], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function writeRollout(root, { current, window = 100_000, id = 'session-1' }) {
  const dir = join(root, '.codex', 'sessions', '2026', '08', '14');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-test.jsonl');
  const lines = [
    { type: 'session_meta', payload: { id, cwd: root } },
    {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: current },
          total_token_usage: { input_tokens: current * 3 },
          model_context_window: window,
        },
        rate_limits: null,
      },
    },
  ];
  writeFileSync(file, lines.map(JSON.stringify).join('\n') + '\n');
  return file;
}

function probePayload(rollout, fixtureRoot) {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'session-1',
    transcript_path: rollout,
    cwd: fixtureRoot,
  };
}

test('ctx-init injects compact policy on startup', () => {
  const result = run('ctx-init.mjs', {
    hook_event_name: 'SessionStart',
    source: 'startup',
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /40%/);
  assert.match(output.hookSpecificOutput.additionalContext, /75%/);
});

test('ctx-init stays silent on resume and malformed input', () => {
  const resumed = run('ctx-init.mjs', {
    hook_event_name: 'SessionStart',
    source: 'resume',
  });
  const malformed = run('ctx-init.mjs', '{');
  assert.equal(resumed.status, 0);
  assert.equal(resumed.stdout, '');
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, '');
});

test('ctx-probe is silent below 40% and warns at throttle and handoff levels', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ctx-watch-probe-'));
  const pluginData = join(fixtureRoot, 'plugin-data');
  const env = { PLUGIN_DATA: pluginData };

  const quiet = run('ctx-probe.mjs', probePayload(writeRollout(fixtureRoot, { current: 20_000 }), fixtureRoot), env);
  const throttle = run('ctx-probe.mjs', probePayload(writeRollout(fixtureRoot, { current: 45_000 }), fixtureRoot), env);
  const handoff = run('ctx-probe.mjs', probePayload(writeRollout(fixtureRoot, { current: 80_000 }), fixtureRoot), env);

  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, '');
  assert.equal(throttle.status, 0);
  assert.match(throttle.stdout, /throttle/i);
  assert.equal(handoff.status, 0);
  assert.match(handoff.stdout, /handoff/i);
});

test('ctx-probe creates one PLUGIN_DATA state file on its first warning', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ctx-watch-probe-'));
  const pluginData = join(fixtureRoot, 'plugin-data');
  mkdirSync(pluginData);
  const rollout = writeRollout(fixtureRoot, { current: 45_000 });

  const result = run('ctx-probe.mjs', probePayload(rollout, fixtureRoot), { PLUGIN_DATA: pluginData });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /throttle/i);
  const stateFiles = readdirSync(pluginData);
  assert.equal(stateFiles.length, 1);
  assert.equal(basename(stateFiles[0]), 'ctx-probe-session-1.state');
});

test('ctx-probe resets watermark state below the throttle line', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ctx-watch-probe-'));
  const pluginData = join(fixtureRoot, 'plugin-data');
  const env = { PLUGIN_DATA: pluginData };
  const rollout = writeRollout(fixtureRoot, { current: 45_000 });

  writeRollout(fixtureRoot, { current: 20_000 });
  const initialReset = run('ctx-probe.mjs', probePayload(rollout, fixtureRoot), env);
  writeRollout(fixtureRoot, { current: 45_000 });
  const firstWarning = run('ctx-probe.mjs', probePayload(rollout, fixtureRoot), env);
  const repeatedWarning = run('ctx-probe.mjs', probePayload(rollout, fixtureRoot), env);
  writeRollout(fixtureRoot, { current: 20_000 });
  const reset = run('ctx-probe.mjs', probePayload(rollout, fixtureRoot), env);
  writeRollout(fixtureRoot, { current: 45_000 });
  const laterWarning = run('ctx-probe.mjs', probePayload(rollout, fixtureRoot), env);

  assert.equal(initialReset.stdout, '');
  assert.match(firstWarning.stdout, /throttle/i);
  assert.equal(repeatedWarning.stdout, '');
  assert.equal(reset.stdout, '');
  assert.match(laterWarning.stdout, /throttle/i);
});

test('ctx-probe honors the CTX_THROTTLE environment override', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ctx-watch-probe-'));
  const pluginData = join(fixtureRoot, 'plugin-data');
  const rollout = writeRollout(fixtureRoot, { current: 15_000 });

  const resetRollout = writeRollout(fixtureRoot, { current: 20_000 });
  const reset = run('ctx-probe.mjs', probePayload(resetRollout, fixtureRoot), { PLUGIN_DATA: pluginData });
  writeRollout(fixtureRoot, { current: 15_000 });

  const result = run('ctx-probe.mjs', probePayload(rollout, fixtureRoot), {
    PLUGIN_DATA: pluginData,
    CTX_THROTTLE: '10000',
  });

  assert.equal(reset.stdout, '');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /throttle/i);
});

test('ctx-probe stays silent for malformed input and missing transcripts', () => {
  const malformed = run('ctx-probe.mjs', '{');
  const missing = run('ctx-probe.mjs', {
    hook_event_name: 'PostToolUse',
    session_id: 'session-1',
    transcript_path: join(tmpdir(), 'ctx-watch-missing-rollout.jsonl'),
    cwd: tmpdir(),
  });

  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, '');
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout, '');
});
