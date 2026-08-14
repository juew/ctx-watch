# ctx-watch Codex-native Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Codex edition automatically load its context-budget policy, pass current plugin validation, remain fail-open, and install locally without changing the Claude Code edition.

**Architecture:** A small `SessionStart` script injects resident policy on `startup`, `clear`, and `compact`. The existing synchronous `PostToolUse` probe continues to read Codex `token_count` records, but uses documented hook fields and `PLUGIN_DATA` for per-session debounce state. Node's built-in test runner drives both scripts as subprocesses against synthetic rollout files.

**Tech Stack:** Node.js ESM, `node:test`, Codex lifecycle hooks, JSON plugin manifests, Markdown.

## Global Constraints

- Modify only `.agents/plugins/marketplace.json`, `codex/README.md`, `codex/plugins/ctx-watch/**`, and `docs/superpowers/**`.
- Do not modify `.claude-plugin/`, `hooks/`, `scripts/`, `skills/`, `README.md`, `README.zh-CN.md`, or `RULES.md` at the repository root.
- Add no runtime or development dependencies.
- Every hook must fail open and exit successfully on malformed or missing input.
- Do not inject policy on a normal `resume`.
- Keep the existing `CTX_WINDOW`, `CTX_THROTTLE`, and `CTX_ROTATE` overrides.
- Bump the Codex plugin version from `0.2.0` to `0.3.0`.

---

### Task 1: SessionStart policy injection

**Files:**
- Create: `codex/plugins/ctx-watch/tests/ctx-watch.test.mjs`
- Create: `codex/plugins/ctx-watch/scripts/ctx-init.mjs`

**Interfaces:**
- Consumes: Codex hook JSON on stdin with `hook_event_name` and `source`.
- Produces: JSON with `hookSpecificOutput.hookEventName = "SessionStart"` and concise `additionalContext`, or no output for unsupported input.

- [ ] **Step 1: Write the failing SessionStart tests**

Create the shared subprocess helper and these tests:

```js
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
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test codex/plugins/ctx-watch/tests/ctx-watch.test.mjs
```

Expected: FAIL because `scripts/ctx-init.mjs` does not exist.

- [ ] **Step 3: Implement the minimal SessionStart script**

Create `ctx-init.mjs` with this behavior:

```js
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
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run `node --test codex/plugins/ctx-watch/tests/ctx-watch.test.mjs`.

Expected: 2 tests pass, 0 fail.

- [ ] **Step 5: Commit the SessionStart unit**

```bash
git add codex/plugins/ctx-watch/scripts/ctx-init.mjs codex/plugins/ctx-watch/tests/ctx-watch.test.mjs
git commit -m "feat(codex): inject context policy on session start"
```

### Task 2: Codex-native watermark state and probe tests

**Files:**
- Modify: `codex/plugins/ctx-watch/tests/ctx-watch.test.mjs`
- Modify: `codex/plugins/ctx-watch/scripts/ctx-probe.mjs`

**Interfaces:**
- Consumes: documented `transcript_path`, `session_id`, and `cwd` fields plus Codex rollout `token_count` events.
- Produces: no output below 40%, a `PostToolUse` throttle message at 40%, and a rotate message at 75%; state is stored under `PLUGIN_DATA`.

- [ ] **Step 1: Add failing probe tests and fixture helpers**

Extend the test imports with `mkdtempSync`, `mkdirSync`, `readdirSync`, `writeFileSync`, `tmpdir`, and `basename`. Add a helper that writes `session_meta` and `token_count` JSON lines:

```js
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
```

Add tests that:

1. Run at 20%, 45%, and 80% and assert silent, `throttle`, and `handoff` output.
2. Assert the first warning creates one state file inside `PLUGIN_DATA`.
3. Assert a repeated 45% run is silent, a 20% run resets state, and a later 45% run warns again.
4. Set `CTX_THROTTLE=10000` and verify 15,000 tokens triggers throttling.
5. Pass malformed stdin and a missing transcript path and assert exit 0 with no output.

Use payloads shaped as:

```js
{
  hook_event_name: 'PostToolUse',
  session_id: 'session-1',
  transcript_path: rollout,
  cwd: fixtureRoot,
}
```

- [ ] **Step 2: Run the probe tests and verify RED**

Run `node --test codex/plugins/ctx-watch/tests/ctx-watch.test.mjs`.

Expected: the `PLUGIN_DATA` assertion fails because the current probe writes debounce state to the operating-system temporary directory.

- [ ] **Step 3: Update the probe minimally**

Make these focused changes:

- Import `mkdirSync` and `basename`.
- Preserve `session_id` and `cwd` from the parsed hook payload.
- Pass the payload `cwd` into the bounded rollout fallback instead of assuming it is always `process.cwd()`.
- Select `process.env.PLUGIN_DATA || tmpdir()` as the state directory and create it recursively.
- Key the state filename by sanitized `session_id`, falling back to `basename(file)`.
- Keep direct `transcript_path` selection first, the tail-reading algorithm, environment overrides, JSON output shape, and exit-0 behavior.

The state path must be constructed as:

```js
const stateRoot = process.env.PLUGIN_DATA || tmpdir();
try {
  mkdirSync(stateRoot, { recursive: true });
} catch {}
const stateKey = (input?.sessionId || basename(file)).replace(/[^a-zA-Z0-9_-]/g, '');
const stateFile = join(stateRoot, `ctx-probe-${stateKey}.state`);
```

- [ ] **Step 4: Run the full Node test file and verify GREEN**

Run `node --test codex/plugins/ctx-watch/tests/ctx-watch.test.mjs`.

Expected: all SessionStart and probe tests pass.

- [ ] **Step 5: Commit the probe unit**

```bash
git add codex/plugins/ctx-watch/scripts/ctx-probe.mjs codex/plugins/ctx-watch/tests/ctx-watch.test.mjs
git commit -m "fix(codex): use hook session data for watermark state"
```

### Task 3: Hook wiring and valid plugin metadata

**Files:**
- Modify: `codex/plugins/ctx-watch/hooks/hooks.json`
- Modify: `codex/plugins/ctx-watch/.codex-plugin/plugin.json`
- Modify: `.agents/plugins/marketplace.json`

**Interfaces:**
- Consumes: Codex default plugin discovery for `hooks/hooks.json` and `skills/`.
- Produces: a version `0.3.0` plugin that passes validation and exposes both lifecycle hooks.

- [ ] **Step 1: Capture the current manifest failure**

Run:

```bash
python3 /Users/zhonghao/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py codex/plugins/ctx-watch
```

Expected: FAIL with `plugin.json field interface must be an object`.

- [ ] **Step 2: Wire both hooks with bounded output and timeout**

Set `hooks/hooks.json` to contain:

```json
{
  "description": "Inject ctx-watch policy and report context watermark thresholds.",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${PLUGIN_ROOT}/scripts/ctx-init.mjs\" 2>/dev/null || true",
            "timeout": 3,
            "additionalContextLimit": 600
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${PLUGIN_ROOT}/scripts/ctx-probe.mjs\" 2>/dev/null || true",
            "timeout": 3,
            "additionalContextLimit": 700
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Update the plugin manifest and marketplace policy**

Set version `0.3.0`, add `"skills": "./skills/"`, and add this interface object:

```json
{
  "displayName": "ctx-watch",
  "shortDescription": "Monitor Codex context watermarks",
  "longDescription": "Automatically keeps Codex aware of context-budget policy and reports when active sessions should throttle growth or prepare a clean handoff.",
  "developerName": "juew",
  "category": "Developer Tools",
  "capabilities": ["Interactive", "Read"],
  "websiteURL": "https://github.com/juew/ctx-watch",
  "privacyPolicyURL": "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement",
  "termsOfServiceURL": "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service",
  "defaultPrompt": ["Check this Codex session's context watermark."]
}
```

Add `"authentication": "ON_INSTALL"` beside the marketplace installation policy.

- [ ] **Step 4: Validate manifests and JSON**

Run:

```bash
python3 /Users/zhonghao/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py codex/plugins/ctx-watch
jq empty .agents/plugins/marketplace.json codex/plugins/ctx-watch/.codex-plugin/plugin.json codex/plugins/ctx-watch/hooks/hooks.json
```

Expected: validator succeeds and `jq` exits 0.

- [ ] **Step 5: Commit packaging changes**

```bash
git add .agents/plugins/marketplace.json codex/plugins/ctx-watch/.codex-plugin/plugin.json codex/plugins/ctx-watch/hooks/hooks.json
git commit -m "fix(codex): align plugin packaging with current contracts"
```

### Task 4: Codex skill and user documentation

**Files:**
- Modify: `codex/plugins/ctx-watch/skills/ctx-watch/SKILL.md`
- Modify: `codex/README.md`

**Interfaces:**
- Consumes: installed plugin behavior from Tasks 1-3.
- Produces: discoverable Codex guidance and complete English/Chinese installation, trust, verification, privacy, and uninstall instructions.

- [ ] **Step 1: Run a baseline skill scenario before editing**

Dispatch a fresh subagent with only this task and the current skill path:

```text
Use the ctx-watch skill at codex/plugins/ctx-watch/skills/ctx-watch/SKILL.md. A user has just installed the Codex plugin. Explain what happens at session start, what manual configuration remains, and how they verify the plugin is active.
```

Record its response in the implementation notes. Expected baseline gap: the current skill does not describe automatic `SessionStart` injection or `/hooks` trust verification.

- [ ] **Step 2: Update only the Codex skill**

Change the frontmatter description to trigger-only wording beginning with `Use when`. Add a short `Automatic behavior` section that states:

- policy is injected on new, cleared, and compacted sessions
- no `AGENTS.md` copy is required
- `/hooks` trust is required after installation or hook changes
- `ctx-probe` remains silent below 40%, throttles at 40%, and prepares handoff at 75%

Keep manual `ctx-audit`, report interpretation, two-tier behavior, and common mistakes concise. Remove any claim that current Codex behavior is inferred rather than read from `token_count`.

- [ ] **Step 3: Rewrite the Codex README installation and rules sections**

In both English and Chinese:

- replace the manual `RULES.md` copy with automatic injection behavior
- add `/hooks` trust review immediately after installation
- add verification commands using `codex plugin list --json` and `node .../ctx-audit.mjs --all`
- add uninstall with `codex plugin remove ctx-watch@ctx-watch`
- state that the plugin reads local rollout files, writes debounce state under `PLUGIN_DATA`, performs no network calls, and sends no telemetry
- retain configuration overrides and marketplace layout

- [ ] **Step 4: Forward-test the revised skill**

Dispatch a fresh subagent with the same scenario from Step 1 and the revised skill. Verify its response now explains automatic injection, no `AGENTS.md` step, `/hooks` trust, and the audit verification path.

Run:

```bash
python3 /Users/zhonghao/.codex/skills/.system/skill-creator/scripts/quick_validate.py codex/plugins/ctx-watch/skills/ctx-watch
rg -n 'SessionStart|/hooks|AGENTS.md|no network|不发送|无网络' codex/plugins/ctx-watch/skills/ctx-watch/SKILL.md codex/README.md
```

Expected: skill validation succeeds; matches show automatic behavior and privacy language, while `AGENTS.md` appears only to say it is not required.

- [ ] **Step 5: Commit skill and docs**

```bash
git add codex/plugins/ctx-watch/skills/ctx-watch/SKILL.md codex/README.md
git commit -m "docs(codex): document automatic policy injection"
```

### Task 5: Full verification, local installation, and GitHub publication

**Files:**
- Verify all files from Tasks 1-4
- Modify no additional product files

**Interfaces:**
- Consumes: completed version `0.3.0` plugin.
- Produces: tested local installation and pushed Git history on `origin/main`.

- [ ] **Step 1: Run the complete verification suite**

```bash
node --test codex/plugins/ctx-watch/tests/ctx-watch.test.mjs
python3 /Users/zhonghao/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py codex/plugins/ctx-watch
python3 /Users/zhonghao/.codex/skills/.system/skill-creator/scripts/quick_validate.py codex/plugins/ctx-watch/skills/ctx-watch
jq empty .agents/plugins/marketplace.json codex/plugins/ctx-watch/.codex-plugin/plugin.json codex/plugins/ctx-watch/hooks/hooks.json
git diff --check 3f5ffd0..HEAD
```

Expected: all commands exit 0.

- [ ] **Step 2: Prove the Claude Code edition is untouched**

```bash
git diff --name-only 3f5ffd0..HEAD | rg -v '^(\.agents/plugins/marketplace\.json|codex/|docs/superpowers/)'
```

Expected: no output and exit 1 from `rg`, meaning every changed path is within the approved scope.

- [ ] **Step 3: Install the local marketplace and plugin**

Inspect configured marketplaces first:

```bash
codex plugin marketplace list --json
```

If `ctx-watch` is absent, run:

```bash
codex plugin marketplace add "$PWD" --json
```

Then install:

```bash
codex plugin add ctx-watch@ctx-watch --json
```

The user has explicitly authorized this local Codex installation.

- [ ] **Step 4: Verify the installed plugin**

```bash
codex plugin list --json | jq '.installed[] | select(.pluginId == "ctx-watch@ctx-watch") | {pluginId, version, installed, enabled, source}'
```

Expected: one object with version `0.3.0`, `installed: true`, and `enabled: true`.

Start a new Codex task and open `/hooks` to trust the exact hook definition. This UI trust step cannot be completed by the installation command itself.

- [ ] **Step 5: Review final history and push**

```bash
git status --short --branch
git log --oneline --decorate -8
git push origin main
```

Expected: a clean `main` branch and a successful push to `https://github.com/juew/ctx-watch`.
