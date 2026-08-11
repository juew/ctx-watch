---
name: ctx-watch
description: >
  Check and act on the context watermark of the current Codex session. Use when the
  user asks about context size, token burn, plan usage, whether a session should be
  wrapped up, or 看上下文水位 / 水位 / token 消耗 / 是不是该收口了; when a session
  feels slow; when deciding whether to keep going or start fresh. Covers running
  ctx-audit, reading its output, and the two-tier response (throttle, then hand off).
---

# ctx-watch (Codex)

## What burns tokens

Every model request re-reads the whole context. Burn is `requests x context size`,
and it does **not** scale with how much the model writes. A session at 89% of its
window spends that much to answer `ls`; the same command in a fresh session costs a
fraction. That multiplier is the problem — which is why the report leads with
`next100`, the tokens the next 100 requests will burn at the current watermark.

Latency follows the same curve. Saving tokens and going faster are one action.

## Run it

```bash
node <plugin>/scripts/ctx-audit.mjs            # sessions for this directory
node <plugin>/scripts/ctx-audit.mjs --all      # every session
node <plugin>/scripts/ctx-audit.mjs --days 7   # recency cutoff (default 14)
```

Codex reports the real `model_context_window` per session, so **nothing is
inferred**: the throttle line is 40% of that window and the handoff line is 75%,
computed per session because models differ. Override with `CTX_WINDOW`,
`CTX_THROTTLE`, `CTX_ROTATE`.

Reading only the head and tail of each rollout keeps a multi-GB session store to a
sub-second scan. Do not replace it with a full read.

## Reading the report

| Marker | Meaning | Action |
|---|---|---|
| `*` | active within 2h | only these need action |
| `THROTTLE` | past 40% of window | slow the growth, do **not** hand off |
| `ROTATE` | past 75% | hand off at the next clean boundary |
| `past` | over a line but stopped | ignore, hindsight only |

The `used%` column is the watermark against that session's own window. The **Plan
usage** block underneath comes from Codex's own `rate_limits` — the provider's
accounting, not an estimate.

Two ids that share a prefix are different sessions: Codex uses UUIDv7, so the
leading characters are a timestamp and sessions started around the same moment look
alike. Resuming a session writes a new rollout file under the same id; the report
keeps only the newest, otherwise one conversation is listed twice and its burn is
double counted.

## Two tiers

**Past 40% — throttle, do not hand off.** Say you are throttling, then keep working:

- Narrow any command expected to return more than ~5KB *before* running it. `grep -n`
  for line numbers, then read that range. Pipe through `head`, `jq`, `--quiet`.
- Stop re-reading whole files; never read the same file twice.
- Write new output to disk and keep only the path plus a 3-line summary.

**Past 75% — hand off at the next clean boundary.** Report the watermark, name the
boundary (a verifiable unit finished with handoff notes written), and let the user
decide. Do not weigh it for them; do not stop dead waiting either.

Handing off is not free — a fresh session re-pays for understanding. Slowing the
growth usually beats starting over, which is why 40% is a throttle and not a rotate.

## Before handing off

The handoff notes must contain: files and functions changed, work remaining,
verification evidence (build and check commands with their exit codes), and the traps
a fresh session would otherwise re-hit. Notes that are written continuously are what
make a handoff cheap; notes written at shutdown are usually too late.

## Common mistakes

- **Acting on `past` rows** — only `*` rows matter.
- **Handing off because a task finished** — watermark is the only reason. One session
  doing several related tasks is efficient; a new one re-pays for understanding.
- **Counting tool calls as the trigger** — call count does not scale with context
  size. 500 narrow greps cost less than 20 unfiltered dumps.
