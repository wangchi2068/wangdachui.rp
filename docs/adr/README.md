# Architecture Decision Records

本目录记录 wangdachui.pi（Stateful Multi-Turn LLM Agent Runtime）的关键架构决策。每条 ADR 描述一个背景 → 决策 → 后果的完整取舍，是理解代码为什么这样写的入口。

| # | 标题 | 决策要点 |
| --- | --- | --- |
| [0001](0001-zero-dependency-runtime.md) | 零依赖运行时 | 手写 RFC6455/SSE/PNG chunk/本地向量检索；Node 22 原生运行 TS |
| [0002](0002-side-model-memory.md) | 确定性代码管记忆 | 旁侧模型结构化账本 + 前情提要压缩；模型输出永不改写 |
| [0003](0003-multi-provider-failover.md) | 多 provider 故障转移 | 401/403/404/5xx/网络错误触发兜底；400/422 不触发；429 先本 provider 重试 |
| [0004](0004-context-compression.md) | 上下文压缩策略 | system→前情提要→滑动窗口三层；归档可召回；摘要过短降级 |
| [0005](0005-agent-loop-and-decision-card.md) | Agent 循环与决策卡 | 循环上限、过程性内容剔除、错误回填、用户决策卡与真随机掷骰 |
| [0006](0006-observability-metrics.md) | 可观测性 | 结构化 JSON 日志 + Prometheus 文本 /metrics + /api/healthz |
| [0007](0007-sqlite-persistence.md) | SQLite 持久化 | node:sqlite 每会话一个 state.db（kv + lines 两表）；旧 JSON 自动迁移；快照=store 导出 |

新增决策请遵循此格式：状态 / 背景 / 决策 / 后果（正面 + 代价）。
