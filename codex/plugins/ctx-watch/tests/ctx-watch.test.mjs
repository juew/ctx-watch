import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
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
