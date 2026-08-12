---
name: ctx-watch
description: >
  Check and act on context watermark for the current session and its subagents.
  Use when the user asks 看上下文水位 / 水位 / token 消耗 / 会话是不是该收口了,
  when a session feels slow, before or after dispatching subagents, or every ~50
  tool calls as a self-check. Covers running ctx-audit.mjs, reading its output,
  the two-tier response (throttle at 40万, rotate at 75万), how rotation differs
  for 主会话 vs 子 agent, and mapping internal ids to session titles.
---

# ctx-watch · 上下文水位监控与处置

**判据不在这里。** 四条硬约束(水位两级、输出节流、消息长度、交接文档)由 plugin 的 SessionStart hook 在每个会话开始时注入(内容见仓库 `RULES.md`);手工安装的话是放在你自己的 `CLAUDE.md` 里。那边是**判据**,这里是**操作手册**——本 skill 只讲怎么执行,不重复判据,重复一遍就等于把按需加载的内容变成常驻成本。

## 两个工具,分工不同

| | `ctx-audit.mjs` | `ctx-probe.mjs` |
|---|---|---|
| 谁看 | 人 | 模型 |
| 内容 | 所有实例的水位报表 | 只有当前会话越线时的一句提示 |
| 速度 | 全量扫描,几秒 | 只读 jsonl 尾部,约 45ms |
| 怎么跑 | 手动 | **PostToolUse hook 自动**,每次工具调用后 |

阈值不写死:`ctx-audit` 启动时从历史峰值推断上下文窗口,节流线取 40%、换人线取 75%,并把窗口值落到 `~/.claude/.ctx-window` 给探针复用。1M 窗口得到 40万/75万,200K 窗口自动得到 8万/15万。手动覆盖用 `CTX_THROTTLE` / `CTX_ROTATE` / `CTX_WINDOW` 环境变量。

**探针自己不能推断窗口**——它只看得到最近一条记录,会话早期水位低会把 1M 误判成 200K,于是 17 万就报"该换人了"。所以它读 `ctx-audit` 落的校准值,读不到就默认 1M(宁可失效,不可误报)。

## 自动触发是怎么回事

水位提示不靠"我记得自查"。`PostToolUse` hook 每次工具调用后跑一次探针,越线时通过 `hookSpecificOutput.additionalContext` 把提示**送进**上下文——裸 stdout 只进 transcript,不保证进模型上下文,必须走这个字段。

探针带防抖:同一档位只提示一次(状态存 tmpdir)。否则每次工具调用都刷一条,那些提示本身会永久驻留上下文,正是这套机制要避免的事。

配置在 `~/.claude/settings.json` 的 `hooks.PostToolUse`。要停用或改条件,用 `update-config` skill。

## 何时手动跑 ctx-audit

hook 只管当前会话。这些情况仍要手动跑报表:

- 用户说「看一下上下文水位」「是不是该收口了」
- 要看**子 agent** 和**别的会话**的水位(hook 看不到它们)
- 派出一批子 agent 之后
- 换过阈值、想确认自校准结果

## 跑

```bash
node <plugin>/scripts/ctx-audit.mjs          # 当前项目
node <plugin>/scripts/ctx-audit.mjs --all    # 全部项目
```

必须在项目根目录跑(脚本按 cwd 推算会话目录);跨项目排查用 `--all`。

## 读输出

标记决定要不要动:

| 标记 | 含义 | 动作 |
|---|---|---|
| `*` | 2 小时内仍活跃 | 只有带 `*` 的才需要处理 |
| `THROTTLE` | 活跃 + 过 40% | 节流,**不换人** |
| `ROTATE` | 活跃 + 过 75% | 在下一个干净边界换人 |
| `past` | 越线但已停 | **不处理**,仅供复盘 |

看 **`current`** 那一列,不是 `peak`。峰值只说明它曾经到过哪儿;compact 过的会话峰值很高但当前很低,那是健康的。

**`rate` 和 `left` 是最该看的两列**:`rate` 是最近每次调用增加多少 token,`left` 是按这个增速到换人线还能跑多少次调用。

**水位相近不代表还能跑一样久。** 实测同一份报表里两个会话:

```
342dc543   408,923   rate   525   left 650
710320f9   439,176   rate 1,294   left 240
```

水位几乎一样,剩余容量差 **2.7 倍**——差的全在增速上。所以看到高水位先看 `rate`,那才是能压下去的量。

`rate` 显示 `-` 表示样本不足或水位在收缩(刚 compact 过),此时 `left` 无意义。

汇总行会对比「最近增速 vs 全程平均增速」,节流有没有生效在那里一眼可见。

汇总行会给出总消耗,以及其中多少是**超出节流线**的部分——那块是本可避免的,早点收口就不用付。

成本估算默认不显示,要加 `--cost`。它按 transcript 里的 model 分别计价,匹配不到价格的只算 token 不算钱。

## 两级处置

**≥ 40 万 —— 进入节流,不换人。** 说一句「已进入节流模式」然后继续干。具体动作:

- 每次工具调用前自问预期输出是否超 5KB,超了先收窄(`grep -n` 定位再 `Read` 带 offset;`head -c`;`jq`;`--quiet`)
- 停止任何整篇重读,同一文件不读第二次
- UI 验证一律 `read_page`(约 3KB),不截图(约 487KB)
- 新产出落文件,上下文里只留路径 + ≤3 行摘要

**≥ 75 万 —— 在下一个干净边界换人。** 报水位 + 指出下一个干净边界在哪,**由用户决定是否继续**。不要自己替用户权衡,也不要一到线就停下等指示。

干净边界 = 一个可验证单元完成 + 交接文档已更新。

## 换人:两种情形完全不同

**这是最容易做错的一点。**

**子 agent 越线** → 只有 **spawn 它的那个会话**能换。别的会话里没有它的句柄,关不掉也换不了。在那个会话里:通知旧实例写交接 → 确认落盘 → 关旧实例 → spawn 新命名实例(`T5` → `T5-v2`)→ 新实例读交接文档 + git log 续跑。

**主会话越线** → 我只能做一半。我写交接文档,**开新会话必须用户来**(新窗口或 `/clear`),因为我无法结束自己所在的会话。写完告诉用户路径,用户在新窗口说「读 <路径> 继续」。

**跨会话够不着。** 如果告警的实例不在当前会话,如实说明,并告诉用户该去哪个窗口——不要假装能远程处理。

## 把内部 ID 换成会话名字

用户在界面上看到的是会话标题,不是 `74feb257` 这种 ID。对应方法:

```bash
# 取每个 jsonl 内最后一条 timestamp
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

再用会话列表工具(Claude Code Desktop 上是 `mcp__ccd_session_mgmt__list_sessions`,**其他客户端可能没有,没有就跳过这步**)的 `lastActivityAt` 匹配,**误差约 2–3 秒**(list_sessions 略晚)。注意 `local_xxx` 的 sessionId 和 jsonl 文件名不是同一套标识,只能按时间对。

匹配不确定时,抓该会话最后几条用户消息给用户认——内容比时间戳可靠。

## 常见误判

- **把 `past` 当成要处理的** → 只处理带 `*` 的活跃实例
- **用峰值判定** → compact 过的会话峰值永远超标,会永久误报。看当前 ctx
- **把 compact 当失败** → 它是常规操作。平台会自动摘要并继续,只要交接文档随进度落盘,被摘掉细节不影响续跑
- **做完一个任务就换人** → 换人的唯一理由是水位,不是任务边界。一个实例连做多个相关任务是划算的,换人要重付理解成本
- **调用次数当门禁** → 次数与上下文大小不成比例。跑 500 次 `grep` 比 20 次无过滤的大 JSON 返回更省

## 成本量级(用于给用户实感)

一次工具调用 = 一次 API 请求 = 一次全上下文缓存读。成本 ∝ 请求次数 × 当时上下文大小,**不** ∝ 输出量。

实测:上下文 10 万 → 85 万,每千输出 token 耗时 11.0s → 21.7s,响应中位数 7.0s → 18.8s。85 万上下文缓存失效一次重建 ≈ $16。

脚本末尾的成本估算按 Opus 5 标准 API 价算,订阅制下体现为额度而非账单。
