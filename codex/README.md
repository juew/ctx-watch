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

Copy this directory into a Codex plugin location, e.g.:

```bash
mkdir -p ~/.codex/plugins/ctx-watch
cp -R codex/ ~/.codex/plugins/ctx-watch/
```

Then enable it in `~/.codex/config.toml` the way you enable your other plugins:

```toml
[plugins."ctx-watch@personal"]
```

**Skill only, no automation:** copy `codex/skills/ctx-watch/` to
`~/.codex/skills/ctx-watch/` and run `ctx-audit` by hand. Nothing else is required.

Requires Node.js.

## The rules

Codex reads `AGENTS.md`. Paste [`../RULES.md`](../RULES.md) into your `~/.codex/AGENTS.md`
(or a project one) so the budget rules are resident when the agent makes decisions.

The Claude Code edition injects them via a `SessionStart` hook. **This edition does
not** — no `SessionStart` hook is used, because there is no verified example of one
in Codex. `AGENTS.md` is the documented, reliable path.

## Known limitation, stated plainly

`hookSpecificOutput.additionalContext` is the Claude Code contract. Codex accepts the
same envelope and the bundled `subagent-orchestration` plugin uses
`hookSpecificOutput` for permission decisions — but **whether Codex feeds
`additionalContext` back into the model is not verified here.** Verifying it needs a
live Codex session, which cannot be done from the other harness.

So `ctx-probe` emits **both** `systemMessage` and `additionalContext`. If injection
works, the agent acts on it. If it does not, the warning is still visible to you as a
system message. Either way you are told; the difference is whether the agent reacts
on its own.

If you confirm the behaviour either way, please open an issue — that observation is
the one thing this edition cannot self-test.

Hook input keys are read with fallbacks (`rollout_path`, `transcript_path`,
`session_file`, `thread_path`, then session ids) and, failing all of them, the probe
finds the newest rollout whose `cwd` matches. So it works even if the payload shape
differs from what was assumed.

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

把这个目录放进 Codex 的 plugin 位置:

```bash
mkdir -p ~/.codex/plugins/ctx-watch
cp -R codex/ ~/.codex/plugins/ctx-watch/
```

再按你启用其他 plugin 的方式,在 `~/.codex/config.toml` 里加上:

```toml
[plugins."ctx-watch@personal"]
```

**只要 skill、不要自动触发:** 把 `codex/skills/ctx-watch/` 复制到 `~/.codex/skills/ctx-watch/`,手动跑 `ctx-audit` 就行,不需要别的。

需要 Node.js。

## 规则怎么装

Codex 读 `AGENTS.md`。把 [`../RULES.md`](../RULES.md) 粘进你的 `~/.codex/AGENTS.md`(或项目级的),让预算规则在 agent 做决策时是常驻的。

Claude Code 版是用 `SessionStart` hook 注入的。**这一版没有这么做**——因为在 Codex 里找不到 `SessionStart` hook 的已验证先例,`AGENTS.md` 才是有文档、可靠的路径。

## 一个已知限制,明说

`hookSpecificOutput.additionalContext` 是 Claude Code 的协议。Codex 接受同样的信封结构,自带的 `subagent-orchestration` 插件也用 `hookSpecificOutput` 做权限决策——**但 Codex 是否会把 `additionalContext` 真正喂回模型,这里没有验证过。** 验证它需要在 Codex 里跑一个实时会话,在另一个 harness 里做不到。

所以 `ctx-probe` **同时**输出 `systemMessage` 和 `additionalContext`。注入生效,agent 就会自己响应;不生效,警告至少还能以系统消息的形式让你看见。两种情况你都会收到通知,区别只是 agent 会不会自动反应。

如果你验证出了结果(不论哪种),欢迎提 issue——这是这一版唯一没法自测的地方。

Hook 输入的键名做了多重兜底(`rollout_path`、`transcript_path`、`session_file`、`thread_path`,再退到各种 session id),全都拿不到时,探针会按 `cwd` 匹配找最新的 rollout。所以即使 payload 结构和假设的不一样,它也能工作。

## 配置

| 变量 | 作用 |
|---|---|
| `CTX_WINDOW` | 覆盖窗口(默认用 Codex 报的值) |
| `CTX_THROTTLE` | 覆盖节流线(tokens) |
| `CTX_ROTATE` | 覆盖收口线(tokens) |

这一版没有价格表。Codex 直接给 `rate_limits.used_percent`——服务方自己的账,比任何标价推算都准。
