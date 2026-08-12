# ctx-watch

**Your agent session gets slower and more expensive the longer it runs. This tells you when, and by how much.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-d97757)](#install)
[![Codex](https://img.shields.io/badge/Codex-plugin-000000)](codex/)

[English](README.md) · [中文](README.zh-CN.md)

```
Context watermark  (* = active within 2h;  window 1,000,000 -> throttle 400,000, rotate 750,000)
rate = tokens added per call recently;  left = calls remaining before the handoff line

  type       name                        calls   current      peak    burned   rate   left  state
* session   56da8060                      458   686,073   686,073    169.0M  1,495     43  THROTTLE
* session   342dc543                      284   408,923   426,430     76.0M    525    650  THROTTLE
  session   dcc101ee                      395   937,249   937,249    210.7M  2,208      0  past
   subagent T3b backend API                292   604,834   604,834     96.4M  1,832      0  past

56da8060: growing 1,495/call recently vs 1,399 lifetime average (steady).
At the recent rate it has ~43 calls before the handoff line.
```

Look at the first two rows. Nearly the same watermark — **2.7x different runway**, entirely because one is growing at 525 tokens per call and the other at 1,295.

---

## The problem

One tool call = one API request = one full re-read of the context.

So the cost of a session is `requests × context size`, and it does **not** scale with how much the model writes. A session sitting at 850k tokens spends 850k to answer `ls`. The same command in a fresh 100k session costs an eighth of that.

Latency follows the same curve. Measured across ~2,000 requests on real transcripts:

| Context | Seconds per 1k output tokens | Median response |
|---:|---:|---:|
| 0–100k | 11.0s | 7.0s |
| 300–400k | 14.5s | 13.6s |
| 500–600k | 18.5s | 20.6s |
| 800–900k | **21.7s** | **18.8s** |

**Saving tokens and going faster are the same action.** Nothing in either harness tells you where you are on that curve — until the session is already slow.

## What it does

Two pieces:

- **`ctx-audit`** — a report for you. Every session and subagent, its watermark, growth rate, and how many calls remain before it should hand off.
- **`ctx-probe`** — a hook for the agent. Fires after every tool call, ~45ms, and tells the agent *itself* to throttle or hand off. It never speaks unless a line is crossed, and only once per level.

Thresholds are **not hardcoded**. The context window is detected, then throttle = 40% of it, handoff = 75%. A 1M-window setup gets 400k/750k; a 200k setup gets 80k/150k.

### Two tiers, and the first one is not a stop sign

| Level | Meaning | What the agent does |
|---|---|---|
| **40%** | throttle | **Keeps working.** Narrows tool output, stops re-reading files, writes results to disk instead of context |
| **75%** | handoff | Reports the watermark and lets *you* decide, after making sure the handoff notes are current |

Crossing the throttle line and continuing is normal. It is not a stop signal — it is a request to slow the growth. That distinction matters more than it sounds:

```
per-quarter growth on one real session:
  2,037 → 2,119 → 1,352 → 816   tokens per call
                  ^^^^^^^^^^^ throttle line crossed here
```

At the early rate that session reaches the handoff line in ~370 calls. At the throttled rate, ~900. **Throttling more than doubled its capacity — raising the threshold could not have done that.**

## Install

**Claude Code**

```bash
/plugin marketplace add juew/ctx-watch
/plugin install ctx-watch@ctx-watch-marketplace
```

**Codex** — see [`codex/`](codex/), which is built against Codex's own rollout format and reads its plan-usage numbers directly.

```bash
codex plugin marketplace add juew/ctx-watch
codex plugin add ctx-watch@ctx-watch
```

Requires Node.js. No dependencies, no network calls, no telemetry — it only reads transcript files already on your disk.

## Usage

You mostly don't. The hook runs on its own and stays quiet until a line is crossed.

When you want the full picture:

```bash
node <plugin>/scripts/ctx-audit.mjs           # sessions for this project
node <plugin>/scripts/ctx-audit.mjs --all     # every project on this machine
node <plugin>/scripts/ctx-audit.mjs --cost    # add a dollar estimate
```

Reading the report:

- **`*`** — active in the last 2 hours. Only these need action; `past` rows are hindsight.
- **`current`, not `peak`** — a session that compacted keeps a high peak forever. Judging on peak marks healthy sessions red permanently.
- **`rate`** — the number you can actually control. `-` means too few samples, or the watermark is shrinking.
- **`left`** — calls remaining at the current rate. Halve the rate, double this.

## Configuration

| Variable | Effect |
|---|---|
| `CTX_WINDOW` | Override the detected context window |
| `CTX_THROTTLE` | Override the throttle line (tokens) |
| `CTX_ROTATE` | Override the handoff line (tokens) |

`--cost` prices each model separately from `~/.claude/ctx-watch-pricing.json`, falling back to a built-in table. **Models it cannot price are counted in tokens and excluded from the dollar sum** — gateways rewrite model ids, and a confidently wrong number is worse than no number.

## Things this gets right that are easy to get wrong

- **Deduplicating by `requestId`.** The same assistant message is flushed to the transcript 1–2 extra times with identical usage. Not deduplicating inflates every total by nearly 2x.
- **Measuring rate over the last quarter, not the lifetime.** On real data those differ by 2.6x, and only the recent slope predicts anything.
- **Staying quiet.** The probe announces each level once. A notice on every tool call would itself live in the context forever — precisely the failure this exists to prevent.
- **Reading only the tail.** A hook on every tool call must not become the thing that slows every step down.
- **Treating compaction as normal.** It is routine operation, not failure. What matters is that the handoff notes are current.

## Verified

Every claim here was tested on a real machine, not assumed:

| | Status |
|---|---|
| Install from GitHub, both harnesses | Verified end to end |
| Hook reaches the model (`additionalContext`) | Verified — agent acted on an injected token |
| Rules reach the model at session start | Verified — fresh session recalled a value present only in `RULES.md` |
| Probe under a real hook | Verified — locates the transcript, emits valid JSON |
| Scan cost on a 5.1GB session store | 0.46s (Codex edition, head+tail reads only) |

## License

MIT
