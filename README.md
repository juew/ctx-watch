# ctx-watch

Watches how much context your sessions carry, and tells the agent to throttle or hand
off before the burn gets out of hand.

**Two editions — install one:**

| Your agent | Install | Notes |
|---|---|---|
| **Claude Code** | this directory | Rules auto-injected at session start |
| **Codex** | [`codex/`](codex/) | Uses Codex's own window and plan-usage numbers |

They share no files. The rest of this page describes the Claude Code edition; the
Codex edition has [its own README](codex/README.md).

*[中文说明在下方](#中文)*

---

## The problem

One tool call = one API request = **one full re-read of the context**. Token burn is
`requests x context size`, and it does not scale with how much the model writes.

A session sitting at 850k tokens spends 850k tokens to answer `ls`. The same call in
a fresh 100k session costs an eighth of that. Nothing warns you, because nothing
looks wrong — the session just gets quietly more expensive and slower with every
turn.

Measured on one machine across a few weeks of real work:

```
5,321 requests burned 1.7B input tokens (avg 322,813 per call).
280.9M of that (16%) was context above the throttle line —
re-reads that earlier handoffs would have avoided.
```

Latency tracks the same curve. Holding output length constant, seconds per 1k output
tokens roughly **doubled** between a 100k and an 850k context, and median response
time went from 7.0s to 18.8s. **Saving tokens and going faster are the same action.**

## What it does

- **`ctx-audit`** — a report of every session and subagent: current watermark, peak,
  total burned, and `next100` (what the next 100 tool calls will cost at the current
  size). Run it when you want to look.
- **`ctx-probe`** — a ~45ms tail read wired to `PostToolUse`. When the current session
  crosses a line it injects one instruction into the agent's context telling it what
  to do. Debounced, so each level is announced once.
- **`RULES.md`** — four budget rules injected at session start, so the agent has them
  resident when it makes the decision.

Thresholds calibrate themselves: the context window is inferred from the largest
request ever recorded, then throttle at 40% and handoff at 75%. A 1M window gives
400k/750k; a 200k window gives 80k/150k. No configuration needed.

Two tiers, deliberately:

| Watermark | Response |
|---|---|
| **>= 40%** | **Throttle, do not hand off.** Narrow big tool calls, stop re-reading whole files, write output to disk |
| **>= 75%** | Hand off at the next clean boundary |

Handing off early is not free — a new instance re-pays for understanding. Slowing the
growth usually beats rotating.

## Install

```
/plugin marketplace add juew/ctx-watch
/plugin install ctx-watch@ctx-watch-marketplace
```

Requires Node.js. No other dependencies.

## Usage

Mostly you do nothing — the hook fires on its own. To look at the whole picture:

```bash
node <plugin>/scripts/ctx-audit.mjs          # this project
node <plugin>/scripts/ctx-audit.mjs --all    # every project
node <plugin>/scripts/ctx-audit.mjs --cost   # add a dollar estimate
```

The exact path is printed into the session at startup. Or ask the agent: *"check the
context watermark"* — the bundled skill covers it.

## Configuration

| Variable | Effect |
|---|---|
| `CTX_WINDOW` | Override the inferred context window |
| `CTX_THROTTLE` | Override the throttle line (tokens) |
| `CTX_ROTATE` | Override the handoff line (tokens) |

**Costs are opt-in and off by default.** `--cost` prices usage per model from the
transcript. Models it has no price for are counted in tokens but excluded from the
dollar sum — a wrong number is worse than no number, and gateways rewrite model ids.
Add your own in `~/.claude/ctx-watch-pricing.json`:

```json
{ "glm-5": { "in": 0.6, "cacheWrite": 0.75, "cacheRead": 0.06, "out": 2.2 } }
```

The bundled prices are Anthropic list prices as of 2026-08. **Verify them.**

**Don't want the rules injected?** Delete the `SessionStart` block from
`hooks/hooks.json`. It costs 3.8KB (~1k tokens) per session, measured not estimated,
stated plainly because a plugin about saving tokens should be honest about the tokens
it spends. The rules do nothing if they are not resident when the decision gets made.

## Two things this gets right that are easy to get wrong

**Deduplicate by `requestId`.** The same assistant message is flushed to the
transcript 1-2 extra times with identical `usage`. Not deduplicating inflates every
total by nearly 2x.

**Judge on current context, not peak.** A session that compacted keeps its high peak
forever, so peak-based judging marks healthy sessions red permanently. Compaction is
normal operation, not failure.

## License

MIT

---

<a name="中文"></a>

# ctx-watch(中文)

监控会话的上下文水位,在 token 流失失控之前让 agent 自己节流或收口。

**两个版本,装一个就行:**

| 你用的 agent | 装哪个 | 说明 |
|---|---|---|
| **Claude Code** | 本目录 | 规则在会话启动时自动注入 |
| **Codex** | [`codex/`](codex/) | 直接用 Codex 自报的窗口和套餐使用率 |

两版不共用文件。下文讲的是 Claude Code 版,Codex 版有[自己的 README](codex/README.md)。

## 要解决什么

一次工具调用 = 一次 API 请求 = **一次全上下文重读**。消耗量 = 请求次数 × 当时上下文大小,**与模型输出多少无关**。

一个 85 万 tokens 的会话,回答一句 `ls` 也要吃掉 85 万。同样这次调用,放在 10 万的新会话里只要八分之一。而且没有任何东西会提醒你——会话看起来一切正常,只是每一轮都更贵、更慢。

某台机器几周真实开发的实测:

```
5,321 次请求烧掉 1.7B input tokens(平均每次调用 322,813)。
其中 280.9M(16%)是超出节流线的上下文——
早点收口本可以避免的重复重读。
```

延迟走同一条曲线。控制输出长度后,每千输出 token 耗时从 10 万上下文到 85 万**翻了一倍**,响应中位数从 7.0s 涨到 18.8s。**省 token 和提速是同一件事。**

## 它做什么

- **`ctx-audit`** —— 列出所有会话与子 agent 的报表:当前水位、峰值、累计消耗,以及 `next100`(按当前水位,接下来 100 次工具调用要烧多少)。你想看时手动跑。
- **`ctx-probe`** —— 约 45ms 的尾部读取,挂在 `PostToolUse` 上。当前会话越线时,往 agent 上下文里注入一条指令告诉它该干什么。带防抖,每个档位只提示一次。
- **`RULES.md`** —— 四条预算规则,会话启动时注入,保证 agent 做决策时规则是常驻的。

阈值自校准:从历史最大请求推断上下文窗口,节流线取 40%、收口线取 75%。1M 窗口得到 40万/75万,200K 窗口得到 8万/15万,不用配置。

**刻意分两档:**

| 水位 | 处置 |
|---|---|
| **≥ 40%** | **节流,不换人。** 收窄大的工具调用、停止整篇重读、产出落文件 |
| **≥ 75%** | 在下一个干净边界收口 |

换人不是免费的——新实例要重新付一次理解成本。多数时候降低增速比换人划算。

## 安装

```
/plugin marketplace add juew/ctx-watch
/plugin install ctx-watch@ctx-watch-marketplace
```

需要 Node.js,无其他依赖。

## 用法

大多数时候什么都不用做,hook 自己会触发。想看全局:

```bash
node <plugin>/scripts/ctx-audit.mjs          # 当前项目
node <plugin>/scripts/ctx-audit.mjs --all    # 全部项目
node <plugin>/scripts/ctx-audit.mjs --cost   # 附带成本估算
```

确切路径会在会话启动时注入。或者直接跟 agent 说:**「看一下上下文水位」**,附带的 skill 覆盖了这个场景。

## 配置

| 变量 | 作用 |
|---|---|
| `CTX_WINDOW` | 覆盖推断出的上下文窗口 |
| `CTX_THROTTLE` | 覆盖节流线(tokens) |
| `CTX_ROTATE` | 覆盖收口线(tokens) |

**成本估算默认关闭,要加 `--cost`。** 它按 transcript 里的 model 字段分模型计价,匹配不到价格的模型只统计 token、不计入金额——错的数字比没有数字更糟,何况网关经常改写 model id。自定义价格写 `~/.claude/ctx-watch-pricing.json`:

```json
{ "glm-5": { "in": 0.6, "cacheWrite": 0.75, "cacheRead": 0.06, "out": 2.2 } }
```

内置价格是 2026-08 的 Anthropic 标价,**请自行核实**。

**不想让规则被注入?** 删掉 `hooks/hooks.json` 里的 `SessionStart` 段。它每个会话固定占 3.8KB(约 1k tokens,实测非估算)——这里明说,因为一个讲省 token 的插件应当对自己花掉的 token 诚实。但规则不常驻就等于没有:决策发生的那一刻它得在场。

## 两个容易做错的细节

**按 `requestId` 去重。** 同一条 assistant 消息会被重复落盘 1~2 次,`usage` 完全相同。不去重会让所有统计虚高近 2 倍。

**用当前水位判定,不用历史峰值。** compact 过的会话峰值永远很高,用峰值判会把已经健康的会话永久标红。compact 是常规操作,不是失败信号。

## 许可

MIT
