# Changelog

## 0.2.0

Reports **growth rate** and **remaining runway**, not just the current watermark.

- `ctx-audit` gains `rate` and `left` columns, replacing `next100`. Rate is measured over the last quarter of the session rather than as a lifetime average, since only the recent slope predicts remaining runway.
- `ctx-probe` reports runway in its throttle notice, reading the rate `ctx-audit` caches.
- Cost estimation moved behind `--cost` and is now priced per model, with unpriced models excluded from the dollar sum rather than guessed at.
- Codex edition: marketplace manifest moved to the repository root. `--sparse` does not move the marketplace root, so the documented install command could not work before this.
- Marketplace renamed to `ctx-watch-marketplace` so it no longer collides with the plugin name.

## 0.1.0

Initial release. Context watermark monitoring for Claude Code and Codex: automatic threshold calibration from the detected context window, a `PostToolUse` probe that tells the agent to throttle or hand off, and session rules injected at startup.
