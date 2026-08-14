# ctx-watch Codex-native redesign

## Goal

Make the Codex edition installable, self-configuring, and aligned with current
Codex hook and plugin contracts. Installing the plugin should be enough to load
the context-budget policy; users must not copy `RULES.md` into `AGENTS.md`.

## Scope

The implementation may change only:

- `.agents/plugins/marketplace.json`
- `codex/README.md`
- `codex/plugins/ctx-watch/**`
- this design and its implementation plan under `docs/superpowers/`

It must not change the Claude Code implementation at the repository root,
including `.claude-plugin/`, `hooks/`, `scripts/`, `skills/`, `README.md`,
`README.zh-CN.md`, and `RULES.md`.

## User experience

After installation, the user reviews and trusts the plugin hook once with
`/hooks`. No `AGENTS.md` edit is required.

For a new or cleared session, and after compaction, a `SessionStart` hook adds a
small context-budget policy as developer context. It does not inject again on a
normal resume, avoiding duplicate resident instructions.

During work, the existing `PostToolUse` probe reads Codex's latest
`token_count` event. Below 40% it stays silent. At 40% it tells the agent to
throttle context growth and continue. At 75% it tells the agent to report the
watermark and prepare a clean handoff boundary while leaving the final choice to
the user.

The manual `ctx-audit` command remains available for a detailed report.

## Components

### Session policy injection

Add `scripts/ctx-init.mjs`. It reads the hook payload, verifies that the event is
`SessionStart`, and emits a concise JSON envelope with:

- `hookSpecificOutput.hookEventName = "SessionStart"`
- compact `additionalContext` containing the 40% and 75% response policy

The handler matches `startup|clear|compact`. The message is deliberately much
shorter than `RULES.md` and contains only behavior that must remain resident.

### Watermark probe

Keep `PostToolUse` synchronous so a threshold warning reaches the next model
request in the active turn. Add a short hook timeout so a probe cannot stall a
tool workflow.

Prefer the documented hook fields `transcript_path`, `session_id`, and `cwd`.
Retain bounded fallbacks for older Codex versions. Continue reading only the
rollout tail and always fail open.

Store debounce state under `PLUGIN_DATA` when available, keyed by session id and
threshold level. Fall back to the operating-system temporary directory only when
the plugin data directory is unavailable. Returning to `ok` after compaction
resets the state so a later threshold crossing can warn again.

### Plugin metadata

Bring `.codex-plugin/plugin.json` up to the current Codex manifest contract by
adding component paths and an `interface` block with display metadata and starter
prompts. Keep the plugin dependency-free and local-only.

Complete the marketplace policy with `authentication: "ON_INSTALL"`. No product
gate or external authentication is needed.

### Skill and documentation

Update only the Codex skill. It should explain the automatic policy, the manual
audit path, and the two threshold responses without duplicating implementation
details.

Update `codex/README.md` in English and Chinese to document:

- installation
- `/hooks` trust review
- automatic `SessionStart` injection
- verification commands
- configuration overrides
- uninstall and privacy behavior

Remove the obsolete instruction to paste root `RULES.md` into `AGENTS.md`.

## Error handling

Every hook exits successfully on missing files, malformed JSON, unsupported
rollout records, or state-write failures. Hook commands also retain shell-level
fail-open behavior. No error may block a Codex tool call or session startup.

The probe uses the real `model_context_window` when present and keeps the current
200,000-token fallback for older records. Environment overrides remain supported.

## Tests

Use Node's built-in test runner and temporary fixture directories; add no runtime
dependencies. Tests cover:

- `SessionStart` output shape and event filtering
- no duplicate injection on `resume`
- `ok`, `throttle`, and `rotate` thresholds
- documented `transcript_path` selection
- debounce and reset after compaction
- malformed input and missing rollout fail-open behavior
- environment threshold overrides

Validation must also run the Codex plugin validator and skill validator. A final
Git diff scope check must prove that no Claude Code file changed.

## Local installation and publication

After tests and validation pass:

1. Add the local repository as a Codex marketplace if it is not already present.
2. Install `ctx-watch@ctx-watch` with the Codex plugin CLI.
3. Confirm it appears enabled in `codex plugin list --json`.
4. Confirm the installed cache contains the expected manifest, skill, and hooks.
5. Commit the implementation and push the approved branch to the repository's
   GitHub remote.

Hook trust is interactive and hash-based. Installation can be completed from the
CLI, but the user may still need to open `/hooks` in a new Codex task to trust the
new hook definition.
