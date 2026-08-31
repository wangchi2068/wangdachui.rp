# wangdachui.pi · Stateful Multi-Turn LLM Agent Runtime

**状态化多轮 LLM Agent 运行时**：在模型与用户之间加一层确定性运行时——上下文工程（滑动窗口 + 压缩摘要 + 原文归档）、结构化记忆账本（旁侧模型自动记账）、工具调用循环、多 provider 故障转移、用户决策卡。**零第三方运行时依赖**（Node 22 原生运行 TypeScript，手写 RFC6455 / SSE / PNG chunk / 本地向量检索）。

> 角色扮演（《诡秘之主》战役）只是这套运行时的一个示例应用；核心是"确定性代码管记忆与状态，模型只管生成"的通用 Agent 架构。

## 量化数据（live 评测，deepseek-v4-flash-0731）

| 指标 | 结果 | 说明 |
| --- | --- | --- |
| 压缩后记忆保持率 | **85.4%**（41/48） | 12 个多轮场景 × 4 事实，300 字符极端预算强制压缩后探询，关键词级保守口径 |
| 压缩 token 节省 | **12.9%**（正常输出口径） | 长剧情经旁侧模型压缩，8 场景平均 |
| 压缩后关键信息保持 | **97.1%**（34/35） | 同上，正常输出口径 |
| 多 provider 兜底 | 实测通过 | 主网关连续 3 次失败自动切换，服务不中断 |
| 单次探询端到端延迟 | ~13s | flash 档模型，流式渲染下感知更低 |

完整方法、逐场景明细与失败样本分析见 [`reports/EVALUATION.md`](reports/EVALUATION.md)。评测框架可复跑：`node scripts/eval/runner.ts --live`（mock 模式不耗 token）。

## 核心能力（工程视角）

| 模块 | 说明 |
| --- | --- |
| **上下文工程** | 模型每轮只见 `system → 前情提要 → 滑动窗口` 三层；超预算时最旧原文回合被旁侧模型压成"剧情化摘要"，原文归档 `archive.jsonl` 可关键词/语义召回——压缩是"细节落点可控"而非"永久丢失"（[ADR-0004](docs/adr/0004-context-compression.md)） |
| **记忆账本** | 旁侧模型每轮产出结构化增量（人物/物品/关系/伏笔/备注），按 key 去重合并写 `ledger.json`；记账失败降级不阻断剧情（[ADR-0002](docs/adr/0002-side-model-memory.md)） |
| **Agent 循环** | 思考→工具→验证→再思考；循环上限防死循环；工具错误回填模型自修正；中间轮"思考正文"不外泄（[ADR-0005](docs/adr/0005-agent-loop-and-decision-card.md)） |
| **多 provider 兜底** | 主网关不可达/5xx/401·403·404 自动切兜底（OpenAI 兼容）；429 先本 provider 重试；400/422 不触发切换（[ADR-0003](docs/adr/0003-multi-provider-failover.md)） |
| **模型分级** | 记账/压缩走便宜模型（`WANGDACHUI_SCRIBE_MODEL` / `WANGDACHUI_COMPRESS_MODEL`），主剧情走主模型 |
| **决策卡 & 掷骰** | 重大转折由 `decide` 工具请求用户拍板（120s 超时默认选一，`decisions.jsonl` 留痕）；检定由 `roll` 交用户真随机，模型不得擅改 |
| **角色卡/世界书** | SillyTavern v1/v2 JSON 与 **PNG 内嵌卡**（手写 chunk 解析）、世界书混合激活（关键词精确命中 + 本地 n-gram TF-IDF 语义召回，零依赖离线） |
| **世界线存档** | 六状态文件全量快照（含主线进度/角色卡），回档即整体替换；每 N 回合自动存档 |
| **可观测性** | 结构化 JSON 日志 + `GET /metrics`（Prometheus 文本：token 用量、延迟分位、兜底切换、压缩触发、记账成败）（[ADR-0006](docs/adr/0006-observability-metrics.md)） |
| **Web 界面** | 聊天流式输出、决策卡、账本/主线/上下文统计面板、角色卡上传（手写 WebSocket + Node http，零依赖） |

## 架构

```
用户（CLI / Web）
  │
  ▼
┌────────────────────────── Harness（确定性层） ──────────────────────────┐
│ context.ts（裁剪/压缩/归档） → harness.ts（agent 循环）                    │
│ memory-ledger.ts（旁侧记账）  decision-card.ts（决策卡）  roll-card.ts     │
│ tools/registry.ts（工具调度） director/（主线导演）                        │
│ metrics.ts（计数器/延迟直方图）→ GET /metrics                              │
└──────────────────────────────┬───────────────────────────────────────────┘
                               ▼
        OpenAI 兼容 API（主 provider + 兜底链，多模型分级）
```

关键设计原则：**确定性代码管记忆，模型只管写剧情**。模型输出永不改写，harness 只做输入侧加工、结构化记账与元信息标注。

## 快速开始

前置：Node.js ≥ 22（原生支持 TypeScript 与 fetch）。

```bash
cp .env.example .env   # 填入 WANGDACHUI_API_KEY 等（.env 已被 gitignore）
npm install            # 仅 devDependencies（typescript 等，运行时零依赖）
npm run web            # 打开 http://127.0.0.1:7620
```

演示脚本（各验证一个能力）：

```bash
npm run smoke                 # LLM 客户端 + 思维链剥离（真实调用）
node scripts/card-demo.ts     # 角色卡/世界书解析与激活（纯本地）
node scripts/ledger-demo.ts   # 旁侧模型自动记账（双轮）
node scripts/context-demo.ts  # 上下文压缩 + 原文归档检索（小预算压测）
node scripts/decision-demo.ts # 决策卡交互（--choice N 自动选择）
node scripts/ws-test.mjs      # WebSocket 协议测试（需服务已启动）
node scripts/eval/runner.ts   # 评测框架（--live 真实模型 / 默认 mock 不耗 token）
```

Web 端斜杠命令：`/state` 看账本 · `/snap [名字]` 存档 · `/back [N]` 列档/回档 · `/new` 新会话 · `/lore 词` 查世界书 · `/phase` 主线进度。

测试与类型检查：

```bash
npm test              # 61 个单元测试（mock LLM，不费 token）
npx tsc --noEmit      # 严格模式类型检查
```

## 数据目录

`state/`（每会话一个 SQLite 库，可备份迁移）：`state.db` 账本/历史/归档/决策/摘要/角色卡/主线进度（node:sqlite，零依赖；旧 JSON 版本自动迁移）· `sessions/<sid>/state.db` 各访客会话 · `snapshots/*.json` 世界线快照（store 全量导出，回档即整体替换）。见 [ADR-0007](docs/adr/0007-sqlite-persistence.md)。

部署（Docker / Vercel / 内网穿透 / Prometheus 采集）见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 目录

```
src/
  config.ts                 # .env 配置加载（主 provider + 兜底链 + 模型分级 + 预算）
  llm/client.ts             # 零依赖 OpenAI 兼容：chat/stream/tool_calls/思维链剥离/多 provider 兜底
  metrics.ts                # 运行时指标（计数器 + 延迟直方图，Prometheus 文本）
  harness/                  # context（上下文工程）/ harness（agent 循环）/ memory-ledger（旁侧记账）/
                            # decision-card / roll-card / worldline（存档）
  director/                 # 主线导演层（三幕六阶段，关键词+回合门槛推进）
  roleplay/                 # 角色卡 v1/v2 / PNG 内嵌卡 / 世界书激活 / system 组装 / 本地向量
  tools/                    # 工具注册表 + 内置账本工具
  server.ts                 # Web 服务：手写 WebSocket + http + REST + /metrics
web/index.html              # 原生 JS 前端（零构建）
scripts/                    # 各能力演示 + eval/ 评测框架
docs/
  adr/                      # 架构决策记录（7 条，见 docs/adr/README.md）
  DESIGN.md                 # 原始设计说明
  DEPLOYMENT.md             # 部署指南（Docker/Vercel/cpolar/Prometheus）
  PLAN-cpolar-deploy.md     # 内网穿透部署方案
test/*.test.ts              # node --test 单元测试（mock LLM）
assets/                     # 战役包（assets/campaigns/lotm）与示例卡（cards/libai.json）
reports/EVALUATION.md       # 量化评测报告（记忆保持/压缩节省/兜底实测）
```

## 许可

MIT。
