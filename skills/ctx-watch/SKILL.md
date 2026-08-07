---
name: ctx-watch
description: >
  Check and act on the context watermark for the current session and its subagents.
  Use when the user asks about context size, token burn, whether a session should be
  wrapped up, or 看上下文水位 / 水位 / token 消耗 / 是不是该收口了; when a session
  feels slow; before or after dispatching subagents. Covers running ctx-audit,
  reading its output, the two-tier response (throttle, then hand off), why rotating a
  subagent differs from closing out a main session, and mapping transcript ids back
  to session titles.
---

# ctx-watch

**The rules are not in this file.** The four budget rules are injected into every
session at startup by this plugin's `SessionStart` hook (source: `RULES.md`). That
is the resident layer. This skill is the operational layer: how to run the tools,
read the output, and act. Repeating the rules here would turn on-demand content into
resident cost — the exact mistake this plugin exists to prevent.

## What burns tokens

One tool call = one API request = one full re-read of the context. Burn is
`requests x context size`. It does **not** scale with how much the model writes.

A session at 850k spends 850k tokens to answer `ls`. The same call in a fresh 100k
session costs an eighth. That multiplier is the whole problem — and it is why the
report leads with `next100`, the tokens the next 100 tool calls will burn at the
current watermark.

## Two tools

| | `ctx-audit` | `ctx-probe` |
|---|---|---|
| Audience | human | model |
| Shows | every instance, full report | one line, only when over a line |
| Speed | full scan, seconds | tail read, ~45ms |
| Trigger | you run it | `PostToolUse` hook, automatic |

The exact `ctx-audit` path for this machine is given at session start along with the
rules. If it is not in context, find it:

```bash
find ~/.claude/plugins -name ctx-audit.mjs -path '*ctx-watch*' | head -1
```

Flags: `--all` scans every project, `--cost` adds a dollar estimate.

## Thresholds calibrate themselves

`ctx-audit` infers the context window from the largest request ever recorded, then
sets throttle at 40% and handoff at 75%. A 1M window yields 400k/750k, a 200k window
yields 80k/150k, with no configuration. The resolved window is cached to
`~/.claude/.ctx-window`.

Override with `CTX_WINDOW`, `CTX_THROTTLE`, `CTX_ROTATE` (token counts).

**The probe cannot infer the window itself** — it sees one record, and early in a
session a 1M window reads as 200k, which fires "hand off" at 170k. It reads the
cached value and assumes 1M when there is none. Failing silent beats a false alarm:
a false alarm both pollutes the context and pushes the agent into the wrong action.

## Reading the report

| Marker | Meaning | Action |
|---|---|---|
| `*` | active within 2h | only these need action |
| `THROTTLE` | past 40% | slow the growth, do **not** hand off |
| `ROTATE` | past 75% | hand off at the next clean boundary |
| `past` | over a line but stopped | ignore, hindsight only |

Read the **`current`** column, not `peak`. A session that compacted has a high peak
forever; compaction is normal operation, not failure.

The summary line reports total burn and how much of it sat above the throttle line —
that portion is the avoidable part, the re-reads an earlier handoff would have saved.

## Handing off: two different situations

**This is the easiest thing to get wrong.**

**A subagent is over the line** → only the session that **spawned it** can rotate it.
No other session holds a handle. There: have the old instance write handoff notes,
confirm they landed, stop it, spawn a fresh named instance (`T5` → `T5-v2`), and let
the new one recover state from the notes plus git history.

**A main session is over the line** → the agent can only do half. It writes the
handoff notes; **the user must open the new session** — no agent can end the session
it is running in. Write the notes, give the path, and let the user resume there.

**If the flagged instance is not in the current session, say so.** Report which
window it belongs to. Do not imply it can be handled remotely.

## Mapping ids to session titles

Users see titles, not `74feb257`. Match by last activity:

```bash
python3 -c "
import json,glob
for f in sorted(glob.glob('*.jsonl')):
    last=None
    for line in open(f,encoding='utf-8'):
        try: o=json.loads(line)
        except: continue
        if o.get('timestamp'): last=o['timestamp']
    print(last, f[:8])"
```

Compare against the session list from whichever session-management tool the host
exposes (in Claude Code Desktop, `mcp__ccd_session_mgmt__list_sessions` and its
`lastActivityAt`, which runs ~2-3s behind). Session ids there are a different
namespace from transcript filenames, so time is the only join key.

When the match is uncertain, pull the last few user messages from the transcript and
let the user recognise the conversation. Content beats timestamps.

## Common mistakes

- **Acting on `past` rows** — only `*` rows matter.
- **Judging on peak** — a compacted session is permanently red under that rule.
- **Treating compaction as failure** — it is routine; with current handoff notes,
  losing detail does not stop the work.
- **Rotating because a task finished** — watermark is the only reason. One instance
  doing several related tasks is efficient; a new one re-pays for understanding.
- **Gating on tool-call count** — it does not scale with context size. 500 narrow
  greps cost less than 20 unfiltered dumps.
