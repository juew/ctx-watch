#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const allowedSources = new Set(['startup', 'clear', 'compact']);

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (input.hook_event_name !== 'SessionStart' || !allowedSources.has(input.source)) {
    process.exit(0);
  }

  const policy =
    '[ctx-watch] Keep context growth low. Below 40% of the model window, work normally. ' +
    'At or above 40%, tell the user you are throttling, continue working, narrow large tool output, ' +
    'and avoid rereading whole files. At or above 75%, report the watermark, finish the next ' +
    'verifiable unit, update handoff notes with files, remaining work, and verification evidence, ' +
    'then let the user decide whether to continue or start a fresh task.';

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: policy,
    },
  }));
} catch {
  process.exit(0);
}
