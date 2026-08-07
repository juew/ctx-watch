#!/usr/bin/env node
/**
 * Inject RULES.md into the session context at startup.
 *
 * Why a hook and not a skill: the rules have to be resident to work. A skill loads
 * only when invoked, and by the time someone thinks to invoke it the context is
 * already large. Resident is the whole point.
 *
 * The cost is honest: 3.8KB (~1k tokens) in every session, forever. For a plugin
 * about saving tokens that is worth stating plainly — the rules do nothing if they
 * are not there when the decision is made. If you disagree, delete the SessionStart
 * block from hooks/hooks.json and paste RULES.md into your own CLAUDE.md instead.
 *
 * Always exits 0.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const rules = readFileSync(join(root, 'RULES.md'), 'utf8');

  // The install path is not fixed (it includes the marketplace and version), and
  // ${CLAUDE_PLUGIN_ROOT} is not interpolated inside skill bodies. Resolving it here
  // is the reliable way for the agent to learn the exact command to run.
  const cmd = `\n---\nWatermark report command for this machine:\n    node ${join(root, 'scripts', 'ctx-audit.mjs')}\nAdd --all to scan every project, --cost to also estimate dollars.\n`;

  console.log(
    JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: rules + cmd },
    })
  );
} catch {
  // Missing or unreadable rules must not break session startup.
}
