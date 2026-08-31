# ADR-0001：零依赖运行时

- 状态：已接受（2026-08）
- 决策者：项目所有者
- 关联模块：`src/llm/client.ts`、`src/server.ts`、`src/roleplay/png-card.ts`、`src/roleplay/vector.ts`

## 背景

LLM 应用项目普遍重度依赖 SDK（openai / anthropic / langchain）与框架。这带来三个问题：SDK 升级破坏兼容、流式解析与错误分类被库隐藏、部署体积大。

## 决策

运行时零第三方依赖：Node 内置 `fetch` / `WebSocket` 客户端完成 LLM 与 Web 通信，手写 RFC6455 服务端协议层、SSE 流式解析、PNG chunk 解析（读内嵌角色卡）、n-gram TF-IDF 向量检索。`ws` 库仅作为可替换的 WebSocket 传输实现保留；`typescript` 等仅 devDependencies。

## 后果

- 正面：协议层完全可控——流式增量拼接、`reasoning_content` 剥离、工具调用按 index 增量合并均为自研；`/chat/completions` 的错误分类（401/403/404 触发换 provider、400/422 不触发）是显式策略而非 SDK 默认行为；部署无需 node_modules（Node 22 原生类型剥离）。
- 代价：需要自行处理协议边界（超时、空闲流、body 克隆、中文 GBK 终端输出）。
- 约束：Node >= 22（内置 fetch / WebSocket / TS 类型剥离）。
