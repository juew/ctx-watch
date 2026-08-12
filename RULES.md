# Context budget

**Goal: let one instance work as long as possible while keeping its context low.**
These are not in tension. Context grows from what you pull in per call, not from how
long you have been running — 500 narrow `grep`s cost less than 20 unfiltered dumps.

**Cost model:** one tool call = one API request = one full re-read of the context.
Burn is `requests x context size`, and it does **not** scale with output length.
A session at 850k spends 850k tokens to answer "ls". Latency tracks the same curve:
measured, seconds-per-1k-output-tokens roughly doubled from 100k to 850k.
**Saving tokens and going faster are the same action.**

Run `ctx-audit` for the current watermark (`--all` across projects). It reports a
growth rate and how many calls remain before the handoff line.

**The throttle line is not a stop line.** Crossing it and continuing to work is
normal and expected — it only means slow the growth. Capacity is set by the rate,
not the threshold: measured on a real session, throttling cut growth from ~2,100 to
~816 tokens per call, which more than doubled how long that session could run.

## Four rules

1. **Watermark, two tiers. Tool-call count is not a gate** — it does not scale with
   context size, and gating on it would rotate an instance doing light lookups.

   | Watermark | Response |
   |---|---|
   | **< 40% of window** | Work normally; rule 2 still applies |
   | **>= 40%** | **Throttle, do not hand off.** Rule 2 becomes mandatory per call; stop re-reading anything whole; write new output to disk instead of into the conversation |
   | **>= 75%** | Hand off at the **next clean boundary** = a verifiable unit finished + handoff notes updated |

   **Report it.** Crossing 40%: say you are throttling, then keep working. Crossing
   75%: report the watermark, name the next clean boundary, and let the user decide.
   Do not weigh it for them; do not stop dead waiting either.

2. **Throttle output — the highest-leverage rule.** If a tool call is expected to
   return more than ~5KB, narrow it before running. Never "fetch it and look". What
   comes back stays forever and is re-billed on every later request.
   - Commands: `grep`, `head -c`, `jq`, `--quiet`. Never `cat` a big file.
   - Files: `grep -n` for line numbers, then read that range. Read a file whole only
     to understand it whole, and never twice.
   - UI: a text page read is ~3KB, a screenshot ~487KB — **500x**, and images never
     leave the context. Screenshot only when a human needs to look.
   - Big output goes to a file; keep the path plus a 3-line summary.
   - Subagents return paths, not evidence.

3. **Message length.** A message lives in the recipient's context forever and is
   re-billed on every one of their later requests. Routine messages <= 400 chars,
   task assignments <= 800. Anything longer goes to a file, referenced by absolute
   path. Never paste review reports, full evidence, or large code into a message.

4. **Handoff notes, updated continuously** — not written at shutdown. The target is
   that any agent can take over at any moment. This is what makes long runs safe:
   notes that are always current are why compaction losing detail does not hurt.
   Must contain: files/functions changed, work remaining, verification evidence
   (build and check commands with exit codes), and the traps a fresh instance would
   otherwise re-hit.

## Wrapping up

- **Do not rotate just because a task finished.** One instance doing several related
  tasks is efficient — it already has the context, and a new one re-pays for
  understanding. Watermark is the only reason to rotate.
- Close out before a long break: the bigger the context, the more expensive the
  cache rebuild when it expires.
- **Prefer slowing growth over rotating.** Rule 2 done well multiplies how much one
  instance can get through.
- Compaction is normal operation, not failure. The platform summarises and
  continues; with rule 4 in place, losing detail does not stop the work.
