# ctx-watch — Codex edition

The same idea as the Claude Code edition in the repository root, rebuilt against
Codex's rollout format. Pick one; they do not share files.

*[中文说明在下方](#中文)*

## Why a separate edition

The two harnesses record usage differently, and Codex records it better:

| | Claude Code | Codex |
|---|---|---|
| Transcripts | `~/.claude/projects/<slug>/*.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Usage record | `message.usage` per assistant message | `token_count` events, **already cumulative** |
| Context window | must be inferred from observed peaks | **`model_context_window`, stated outright** |
| Plan usage | not available | **`rate_limits.used_percent`, from the provider** |
| Session identity | directory name derived from cwd | `session_meta.payload.cwd` + UUIDv7 id |
| Hook path variable | `${CLAUDE_PLUGIN_ROOT}` | `${PLUGIN_ROOT}` |

Because Codex's counts are cumulative, this edition reads only the **head** (for
cwd) and **tail** (for the latest counts) of each rollout. Measured on a 5.1GB
session store: **0.46s** for a full `--all` scan.

## Install

Codex has a plugin CLI. Use it — copying files into `~/.codex/plugins/` by hand does
**not** register anything and the hooks silently never fire (verified the hard way).

```bash
codex plugin marketplace add juew/ctx-watch
codex plugin add ctx-watch@ctx-watch
```

Or from a local checkout:

```bash
codex plugin marketplace add /path/to/ctx-watch
codex plugin add ctx-watch@ctx-watch
```

**Skill only, no automation:** copy `plugins/ctx-watch/skills/ctx-watch/` to
`~/.codex/skills/ctx-watch/` and run `ctx-audit` by hand.

Requires Node.js.

### Marketplace layout

Codex expects a specific shape, which is why this lives in its own subtree:

```
<repo root>/
├── .agents/plugins/marketplace.json     <- the marketplace manifest (must be at
│                                            the root; --sparse does not move it)
└── codex/plugins/ctx-watch/
    ├── .codex-plugin/plugin.json        <- the plugin manifest
    ├── hooks/hooks.json
    ├── scripts/
    └── skills/ctx-watch/SKILL.md
```

Without `.agents/plugins/marketplace.json` the CLI refuses the source with
"marketplace root does not contain a supported manifest".

## The rules

Codex reads `AGENTS.md`. Paste [`../RULES.md`](../RULES.md) into your `~/.codex/AGENTS.md`
(or a project one) so the budget rules are resident when the agent makes decisions.

The Claude Code edition injects them via a `SessionStart` hook. **This edition does
not** — no `SessionStart` hook is used, because there is no verified example of one
in Codex. `AGENTS.md` is the documented, reliable path.

## Verified behaviour

`hookSpecificOutput.additionalContext` **is** fed back into the model on Codex. Tested
by installing this plugin, replacing the probe output with a hook that injected a
unique token, and confirming the agent reproduced that token in its reply. The
`PostToolUse` event fires with `matcher: "*"`.

Note that asking the agent "what were you just told?" is not a valid test — it treats
injected context as a system instruction and declines to disclose it. Observe its
behaviour instead.

`ctx-probe` still emits `systemMessage` alongside `additionalContext`, so the warning
is visible to you as well as actionable by the agent.

Hook input keys are read with fallbacks (`rollout_path`, `transcript_path`,
`session_file`, `thread_path`, then session ids) and, failing all of them, the probe
finds the newest rollout whose `cwd` matches.

## Configuration

| Variable | Effect |
|---|---|
| `CTX_WINDOW` | Override the window (default: what Codex reports) |
| `CTX_THROTTLE` | Override the throttle line (tokens) |
| `CTX_ROTATE` | Override the handoff line (tokens) |

No pricing table here. Codex reports `rate_limits.used_percent` directly — the
provider's own accounting beats any list-price guess.

---

<a name="中文"></a>

# ctx-watch — Codex 版

和仓库根目录的 Claude Code 版是同一套思路,按 Codex 的 rollout 格式重写。**两版不共用文件,装其中一个即可。**

## 为什么要单独一版

两个 harness 记录用量的方式不同,而且 Codex 记得更好:

| | Claude Code | Codex |
|---|---|---|
| 会话记录 | `~/.claude/projects/<slug>/*.jsonl` | `~/.codex/sessions/年/月/日/rollout-*.jsonl` |
| 用量字段 | 每条 assistant 消息的 `message.usage` | `token_count` 事件,**已经是累计值** |
| 上下文窗口 | 要从历史峰值推断 | **`model_context_window` 直接给出** |
| 套餐使用率 | 拿不到 | **`rate_limits.used_percent`,来自服务方** |
| 会话归属 | 目录名由 cwd 派生 | `session_meta.payload.cwd` + UUIDv7 id |
| Hook 路径变量 | `${CLAUDE_PLUGIN_ROOT}` | `${PLUGIN_ROOT}` |

因为 Codex 的计数本身是累计的,这一版只读每个 rollout 的**头部**(取 cwd)和**尾部**(取最新计数)。实测 5.1GB 会话库,`--all` 全量扫描 **0.46 秒**。

## 安装

Codex 自带 plugin CLI,**必须用它**——手动把文件复制进 `~/.codex/plugins/` 不会注册任何东西,hook 会静默地永不触发(这是实测踩出来的)。

```bash
codex plugin marketplace add juew/ctx-watch
codex plugin add ctx-watch@ctx-watch
```

或从本地检出安装:

```bash
codex plugin marketplace add /path/to/ctx-watch
codex plugin add ctx-watch@ctx-watch
```

**只要 skill、不要自动触发:** 把 `plugins/ctx-watch/skills/ctx-watch/` 复制到 `~/.codex/skills/ctx-watch/`,手动跑 `ctx-audit`。

需要 Node.js。

### Marketplace 目录结构

Codex 要求特定结构,这也是它单独占一棵子树的原因:

```
<仓库根>/
├── .agents/plugins/marketplace.json     <- marketplace 清单（必须在仓库根；
│                                            --sparse 不会改变 marketplace root）
└── codex/plugins/ctx-watch/
    ├── .codex-plugin/plugin.json        <- plugin 清单
    ├── hooks/hooks.json
    ├── scripts/
    └── skills/ctx-watch/SKILL.md
```

缺了 `.agents/plugins/marketplace.json`,CLI 会直接拒绝:「marketplace root does not contain a supported manifest」。

## 规则怎么装

Codex 读 `AGENTS.md`。把 [`../RULES.md`](../RULES.md) 粘进你的 `~/.codex/AGENTS.md`(或项目级的),让预算规则在 agent 做决策时是常驻的。

Claude Code 版是用 `SessionStart` hook 注入的。**这一版没有这么做**——因为在 Codex 里找不到 `SessionStart` hook 的已验证先例,`AGENTS.md` 才是有文档、可靠的路径。

## 已验证的行为

`hookSpecificOutput.additionalContext` 在 Codex 上**确实会**被喂回模型。验证方式:装上这个 plugin,把探针输出换成注入一个唯一标记的 hook,确认 agent 在回复里复现了那个标记。`PostToolUse` 事件配 `matcher: "*"` 可以正常触发。

注意:问 agent「你刚才收到了什么」**不是**有效的测试——它会把注入内容当作系统指令而拒绝披露。要看它的行为,不要问它。

`ctx-probe` 仍会同时输出 `systemMessage`,这样警告对你可见、对 agent 可执行。

Hook 输入的键名做了多重兜底(`rollout_path`、`transcript_path`、`session_file`、`thread_path`,再退到各种 session id),全都拿不到时按 `cwd` 匹配找最新的 rollout。

## 配置

| 变量 | 作用 |
|---|---|
| `CTX_WINDOW` | 覆盖窗口(默认用 Codex 报的值) |
| `CTX_THROTTLE` | 覆盖节流线(tokens) |
| `CTX_ROTATE` | 覆盖收口线(tokens) |

这一版没有价格表。Codex 直接给 `rate_limits.used_percent`——服务方自己的账,比任何标价推算都准。
