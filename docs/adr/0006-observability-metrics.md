# ADR-0006：可观测性（/metrics + 结构化日志）

- 状态：已接受（2026-08）
- 关联模块：`src/metrics.ts`、`src/logger.ts`、`src/server.ts`

## 背景

LLM 应用的成本、延迟与故障是运行时黑盒：token 烧在哪、兜底切了几次、压缩触发几次，无观测无法回答。

## 决策

- **结构化日志**（logger）：JSON 行日志（`{time, level, event, ...}`），事件含 `turn_start/turn_done/llm 兜底切换/压缩异常`，可 grep 可采集。
- **运行时指标**（metrics）：模块级单例，计数器 + 延迟直方图（固定桶近似分位数），Prometheus 文本格式：
  - LLM：请求/重试/provider 切换/延迟/token 用量（prompt/completion/total）；
  - 上下文：压缩批次/压缩轮数/归档字符/召回命中；
  - 业务：记账成功/失败、turn 完成数/延迟、HTTP/WS 计数。
- 暴露：`GET /metrics`（Prometheus 文本，可直接被采集器抓取）与 `GET /api/healthz`。

## 后果

- 正面：成本结构、故障转移行为、压缩收益全部可量化——评测报告与运维都依赖这套数据。
- 代价：计数器仅进程内（重启清零）；如需跨实例聚合需接 Prometheus 抓取（配置已兼容）。
- 指标键以 `wangdachui_` 前缀命名，避免与采集器其他目标冲突。
