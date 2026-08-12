# ctx-watch

**Agent 会话跑得越久,越慢也越贵。这个工具告诉你什么时候、以及贵多少。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-d97757)](#安装)
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

看前两行:水位几乎一样,**剩余容量差 2.7 倍**——差别全在增速上,一个每次调用涨 525,另一个涨 1,295。

---

## 问题

一次工具调用 = 一次 API 请求 = 一次全上下文重读。

所以会话成本 = `请求次数 × 当时上下文大小`,**与模型输出多少无关**。一个停在 85 万 token 的会话,回答一句 `ls` 也要花 85 万。同样的命令在一个 10 万的新会话里只花八分之一。

延迟走同一条曲线。在真实 transcript 上测了约 2000 次请求:

| 上下文 | 每千输出 token 耗时 | 响应中位数 |
|---:|---:|---:|
| 0–10 万 | 11.0s | 7.0s |
| 30–40 万 | 14.5s | 13.6s |
| 50–60 万 | 18.5s | 20.6s |
| 80–90 万 | **21.7s** | **18.8s** |

**省 token 和提速是同一件事。** 而两个 harness 都不会告诉你现在处在这条曲线的哪个位置——直到你已经感觉到卡。

## 它做什么

两个部件:

- **`ctx-audit`** —— 给人看的报表。列出每个会话与子 agent 的水位、增速,以及按当前增速还能跑多少次调用。
- **`ctx-probe`** —— 给 agent 用的 hook。每次工具调用后触发,约 45ms,直接告诉 agent **它自己**该节流还是该收口。不越线就不说话,而且每档只说一次。

阈值**不写死**。窗口自动探测,节流线取 40%、收口线取 75%。1M 窗口的机器得到 40万/75万;200K 窗口的自动得到 8万/15万。

### 两档,而且第一档不是叫停

| 档位 | 含义 | agent 会做什么 |
|---|---|---|
| **40%** | 节流 | **继续干活。** 收窄工具输出、不再整篇重读文件、产出落盘只留路径 |
| **75%** | 收口 | 报出水位、确认交接文档已更新,然后**让你决定** |

跨过节流线继续工作是正常的,它不是停止信号,而是"把增速降下来"的请求。这个区别比听起来重要:

容量由增速决定,不由阈值决定。增速减半,会话到收口线的时间大约翻倍——这正是第一档要求"少输出"而不是"收口"的原因。

**节流到底省多少?未知——这个项目不会为此编一个数字。** 要测它需要在可比任务上做 A/B;单个会话什么都证明不了,尤其当观察它的人就是作者时。这里被真正测量的是**水位和增速**,两者都直接读自 transcript。本项目主张的是"这两个数值得被看见",而不是"本工具有一个已证明的百分比"。

## 安装

**Claude Code**

```bash
/plugin marketplace add juew/ctx-watch
/plugin install ctx-watch@ctx-watch-marketplace
```

**Codex** —— 见 [`codex/`](codex/),它按 Codex 的 rollout 格式重写,并直接读取 Codex 自报的套餐使用率。

```bash
codex plugin marketplace add juew/ctx-watch
codex plugin add ctx-watch@ctx-watch
```

需要 Node.js。无依赖、无网络请求、无遥测——它只读你磁盘上已有的 transcript 文件。

## 使用

大多数时候你不用管它。hook 自己跑,不越线就不出声。

想看全貌时:

```bash
node <plugin>/scripts/ctx-audit.mjs           # 当前项目的会话
node <plugin>/scripts/ctx-audit.mjs --all     # 本机全部项目
node <plugin>/scripts/ctx-audit.mjs --cost    # 附带成本估算
```

怎么读这份报表:

- **`*`** —— 2 小时内活跃。**只有这些需要处理**,`past` 行只供复盘。
- **看 `current` 不看 `peak`** —— compact 过的会话峰值会永远很高。按峰值判定会把已经健康的会话永久标红。
- **`rate`** —— 唯一你能真正控制的量。显示 `-` 表示样本不足或水位在收缩。
- **`left`** —— 按当前增速还剩多少次调用。增速减半,这个数翻倍。

## 配置

| 变量 | 作用 |
|---|---|
| `CTX_WINDOW` | 覆盖自动探测的窗口 |
| `CTX_THROTTLE` | 覆盖节流线(tokens) |
| `CTX_ROTATE` | 覆盖收口线(tokens) |

`--cost` 会按 transcript 里的 model 分别计价,价格表可用 `~/.claude/ctx-watch-pricing.json` 覆盖。**匹配不到价格的模型只统计 token、不计入金额**——网关经常改写 model id,而一个自信的错误数字比没有数字更糟。

## 几个容易做错、这里做对了的点

- **按 `requestId` 去重。** 同一条 assistant 消息会被重复落盘 1~2 次且 usage 相同。不去重会让所有统计虚高近 2 倍。
- **增速取最后四分之一,不取全程平均。** 会话换阶段时(先大量探索、再执行),近期斜率会被全程平均掩盖,而只有近期的那个能预测剩余容量。报表把两者都打出来,让差异可见而不是靠猜。
- **保持安静。** 探针每档只提示一次。每次工具调用都刷一条的话,那些提示本身会永久驻留上下文——正是这个工具要防的事。
- **只读文件尾部。** 一个每次工具调用都跑的 hook,不能变成拖慢每一步的东西。
- **把 compact 当常规操作。** 它不是失败信号。真正要紧的是交接文档是否随时可接手。

## 已验证

这里的每条声明都在真机上测过,不是假设:

| | 状态 |
|---|---|
| 从 GitHub 安装(两个 harness) | 端到端验证通过 |
| hook 内容能进模型上下文(`additionalContext`) | 已验证——agent 照做了注入的指令 |
| 规则在会话启动时送达模型 | 已验证——新会话复现了只存在于 `RULES.md` 的数值 |
| 探针在真实 hook 环境下 | 已验证——能定位 transcript 并输出合法 JSON |
| 5.1GB 会话库的扫描耗时 | 0.46 秒(Codex 版,只读头尾) |

## 许可

MIT
