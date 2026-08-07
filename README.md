# RP-Harness · 角色扮演 Agent

基于 LLM 的**角色扮演 Agent Harness**：在模型与用户之间加一层确定性运行时——上下文工程（每轮裁剪、摘要压缩）、结构化记忆账本（旁侧模型自动记账）、工具调用循环、决策卡交互。

**零运行时依赖**：Node 内置 fetch / WebSocket 客户端 + 手写 RFC6455 服务端协议层。

## 功能

| 模块 | 说明 |
|---|---|
| **上下文工程** | 模型每轮只看到三层：system（人设+世界书+账本）→ 前情提要（早期剧情的旁侧模型压缩产物）→ 滑动窗口（近期原文）。超预算时最旧原文回合被压成"剧情化摘要"，原文归档到 `archive.jsonl` 可检索 |
| **记忆账本** | 回合结束后旁侧模型产出结构化增量（人物/物品/关系/伏笔/备注），按 key 合并去重写入 `ledger.json`，下轮注入 system；记账失败降级，不阻断剧情 |
| **Agent 循环** | 思考→工具→验证→再思考；循环上限防死循环；工具错误回填给模型自我修正 |
| **决策卡** | 模型通过 `decide` 工具请求用户拍板重大转折；harness 暂停循环推卡片，选择注入后续写，`decisions.jsonl` 留痕 |
| **角色卡/世界书** | SillyTavern v1/v2 JSON 角色卡解析；世界书常驻 + 关键词激活 |
| **Web 界面** | 聊天流式输出、决策卡渲染、账本/上下文统计面板、角色卡上传（手写 WebSocket + Node http，零依赖） |

## 快速开始

前置：Node.js ≥ 22（原生支持 TypeScript 与 fetch）。

```bash
cp .env.example .env   # 填入 LIYUAN_API_KEY 等（.env 已被 gitignore）
npm install            # 仅 devDependencies（typescript 等，运行时零依赖）
npm run web            # 打开 http://127.0.0.1:7620
```

演示脚本（各验证一个能力）：

```bash
npm run smoke                 # LLM 客户端 + 思维链剥离
node scripts/card-demo.ts     # 角色卡/世界书解析与激活（纯本地）
node scripts/ledger-demo.ts   # 旁侧模型自动记账（双轮）
node scripts/context-demo.ts  # 上下文压缩 + 原文归档检索（小预算压测）
node scripts/decision-demo.ts # 决策卡交互（--choice N 自动选择）
node scripts/ws-test.mjs      # WebSocket 协议测试（需服务已启动）
```

测试与类型检查：

```bash
npm test              # 19 个单元测试（mock LLM，不费 token）
npx tsc --noEmit      # 严格模式类型检查
```

## 架构

```
用户（CLI / Web）
  │
  ▼
┌────────────────────────── Harness ──────────────────────────┐
│ context.ts（组装/裁剪/压缩） → harness.ts（agent 循环）        │
│ memory-ledger.ts（旁侧记账）     decision-card.ts（决策卡）    │
│ tools/registry.ts（工具调度）    llm/client.ts（零依赖封装）   │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
                    OpenAI 兼容 API（如 DeepSeek）
```

关键设计原则：**确定性代码管记忆，模型只管写剧情**。模型输出永不改写，harness 只做输入侧加工、结构化记账与元信息标注。

数据目录 `state/`（纯 JSON，可备份迁移）：`ledger.json` 账本 · `history.jsonl` 会话 · `archive.jsonl` 压缩归档 · `decisions.jsonl` 决策留痕 · `context.json` 摘要与压缩水位 · `card.json` 当前角色卡。

## 目录

```
src/
  config.ts                 # .env 配置加载
  llm/client.ts             # OpenAI 兼容：chat/stream/tool_calls/思维链剥离
  harness/harness.ts        # Agent 主循环（思考→工具→验证→再思考）
  harness/context.ts        # 上下文工程（滑动窗口 + 摘要压缩 + 归档）
  harness/memory-ledger.ts  # 旁侧模型结构化记账（多写者按 key 合并）
  harness/decision-card.ts  # decide 工具 + 决策卡留痕
  roleplay/                 # 角色卡 v1/v2 解析、世界书激活、system 组装
  tools/                    # 工具注册表 + 内置账本工具
  server.ts                 # Web 服务：手写 WebSocket + http + REST
web/index.html              # 原生 JS 前端（零构建）
scripts/*.ts                # 各能力演示
test/*.test.ts              # node --test 单元测试
assets/                     # 示例角色卡与世界书（都市修仙设定）
```

## 许可

MIT。
