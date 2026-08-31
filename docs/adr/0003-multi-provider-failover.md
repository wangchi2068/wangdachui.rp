# ADR-0003：多 provider 故障转移与错误分类

- 状态：已接受（2026-08）
- 关联模块：`src/llm/client.ts`、`src/config.ts`

## 背景

单一 LLM 网关是单点：限流、5xx、key 失效都会让服务不可用。多网关轮换的前提是"换一家大概率能修好"，但并非所有错误换 provider 都有意义。

## 决策

- provider 链 = 主 provider + 兜底列表（`WANGDACHUI_FALLBACK_API_BASE/_KEY/_MODEL` 或 `WANGDACHUI_FALLBACKS_JSON`）。
- 触发换 provider 的错误：**网络不可达 / 5xx（本 provider 内退避重试 3 次）/ 401·403·404**（鉴权或模型命名差异，换一家很可能就好）。
- 不触发换 provider 的错误：**400 / 422**（payload 错误，换 provider 也没用，直接抛给调用方）。
- **429** 限流：优先在本 provider 内重试（兜底可能同样限流），重试耗尽才切换。
- 每个 provider 独立 90s 超时 + 指数退避；流式空闲 45s 无推流则降级为非流式重试。

## 后果

- 正面：主网关故障不中断服务（评测中真实触发：主 provider 连续 3 次失败自动切兜底成功）；`/metrics` 可观测切换次数与重试。
- 代价：错误语义分层需要客户端与网关约定一致；兜底 key 需与主 key 分属不同配额池才有效。
- 调试：`WANGDACHUI_DISABLE_FALLBACK=1` 强制只走主 provider 复现故障。
