# RP-Harness 设计文档

> 简历叙事主线：**设计并实现了一个基于 LLM 的"角色扮演 Agent Harness"**——
> 在模型与用户之间加了一层确定性运行时：上下文工程（每轮裁剪、摘要压缩）、
> 结构化记忆账本（旁侧模型自动记账）、工具调用循环、决策卡交互。

---

## 1. 问题：为什么角色扮演需要 harness？

普通 LLM 聊天是"对话即上下文"：聊多少，窗口里就堆多少。对角色扮演（RP）这是灾难：

- 窗口被过程性内容（工具调用中间结果、思考链、状态栏垃圾）塞满，有效剧情容量骤降；
- 越聊越"失忆"——模型记不住 50 轮前埋下的伏笔和物品；
- 用户对剧情走向没有掌控力，只能反复重 roll 赌模型发挥。

Harness 的思路：**在模型外面加一层确定性运行时**，替模型管理记忆、裁剪窗口、
执行工具、与用户交互。模型只做它擅长的事——写剧情。

## 2. 架构总览

```
┌─────────────────────────────────────────────────────┐
│                   用户（CLI / Web）                  │
└──────────────────────┬──────────────────────────────┘
                       │ 输入 / 决策卡选择
┌──────────────────────▼──────────────────────────────┐
│                 Harness（本项目的核心）               │
│  ┌─────────────┐   ┌──────────────┐   ┌───────────┐  │
│  │ context.ts  │   │ harness.ts   │   │ memory-   │  │
│  │ 上下文工程    │──▶│ agent 循环    │◀──│ ledger.ts │  │
│  │ 组装/裁剪/压缩│   │ 思考→工具→    │   │ 记忆账本   │  │
│  └─────────────┘   │ 验证→再思考    │   └───────────┘  │
│                    └──────┬───▲───┘                  │
│  ┌─────────────┐   ┌──────▼───┴────────┐             │
│  │ decision-   │   │ tools/registry.ts │             │
│  │ card.ts     │   │ 工具注册与调度      │             │
│  │ 决策卡交互    │   └──────┬───────────┘             │
│  └─────────────┘          │ 调用                      │
└───────────────────────────┼──────────────────────────┘
                            ▼
                 ┌──────────────────────┐
                 │   OpenAI 兼容 API     │
                 │  (deepseek-v4-flash) │
                 └──────────────────────┘
        （剧情模型 = 旁侧模型，记账/压缩共用同一端点）
```

**关键原则：确定性代码管记忆，模型只管写剧情。**
模型输出永不改写（不补写、不润色），harness 只做输入侧加工与元信息标注。

## 3. 模块职责

| 模块 | 文件 | 职责 |
|---|---|---|
| LLM 客户端 | `src/llm/client.ts` | 零依赖 OpenAI 兼容封装：chat、streaming、tool_calls；剥离 `reasoning_content`（思维链只用于内部，不给用户看） |
| 配置 | `src/config.ts` | 读 `.env`：base_url / api_key / model / 预算 |
| Agent 循环 | `src/harness/harness.ts` | 组装消息 → 调模型 → 有 tool_calls 就执行回填 → 再调，直到模型自然结束；上限防死循环 |
| 上下文工程 | `src/harness/context.ts` | 每轮重新组装：system(角色+世界状态) + 滑动窗口近期原文 + 早期摘要；超预算时把最旧剧情交给旁侧模型压缩成"剧情化摘要" |
| 记忆账本 | `src/harness/memory-ledger.ts` | 回合结束后旁侧模型输出结构化 JSON（人物/物品/关系/时间/伏笔），合并写入 `state/ledger.json`，下轮注入 system；记账失败不影响剧情 |
| 决策卡 | `src/harness/decision-card.ts` | 模型通过内置 `decide` 工具请求用户决策；harness 暂停循环，展示卡片，用户选择后注入继续；留痕 `state/decisions.jsonl` |
| 角色卡 | `src/roleplay/character-card.ts` | 解析 SillyTavern v1/v2 JSON 角色卡（name/description/personality/scenario/first_mes/mes_example） |
| PNG 卡 | `src/roleplay/png-card.ts` | 手写 PNG chunk 解析，提取 tEXt 内嵌角色卡（chara/ccv3） |
| 世界书 | `src/roleplay/lorebook.ts` | 世界书 JSON：常驻条目 + 关键词激活条目，按当前上下文筛选注入 |
| 工具 | `src/tools/registry.ts` | 工具 schema 注册 + 调度执行 |
| 主线导演 | `src/director/` | 三幕大纲 + 规则推进（关键词+回合门槛）；每轮生成【主线】指引与事件钩子；状态 `state/director.json` |
| 世界线 | `src/harness/worldline.ts` | 六状态文件全量快照/回档，回档前自动留档 |
| 服务 | `src/server.ts` | Node http + WebSocket（手写 RFC6455），REST API（状态/角色卡/快照），斜杠命令 |

## 4. 一轮对话的完整旅程

```
用户输入
  │
  ▼
① 组装：system = 角色设定 + 世界状态(账本快照) + 激活的世界书 + 决策卡历史
          messages = 滑动窗口(近期 N 条原文) + 早期摘要(压缩产物)
  ▼
② Agent 循环：
   ┌─→ 调模型（streaming，思维链内部消化，正文流式给用户）
   │     │
   │     ├─ 需要工具？──▶ 执行（写账本/查设定/decide...）──▶ 回填 tool 消息 ─┐
   │     │                                                                  │
   │     └─ 自然结束 ◀───────────────────────────────────────────────────────┘
  ▼
③ 后处理：剥离思维链 → 正文落库
  ▼
④ 旁侧记账：调模型产出结构化账本 → 合并写 ledger.json（失败则保留旧账本）
  ▼
⑤ 预算检查：超了就把最旧剧情压成摘要，原文归档 state/archive.jsonl
```

## 5. 关键设计决策（面试高频）

1. **为什么记账/压缩用独立调用而不是塞进主循环？**
   主循环的上下文要保持纯净单一；记账是确定性产出，用旁侧模型独立完成，
   失败也不阻断剧情（容错优先）。

2. **思维链怎么处理？**
   `reasoning_content` 只做内部消费，绝不进给用户的正文——避免"想太多"污染叙事。
   这也压缩了展示层看到的冗余。

3. **"回档整个世界"为什么难？**
   正文、账本、面板、知识库必须一致地回到同一时间点——本项目用
   时间戳命名全量快照（`state/snapshots/<ts>.json`），回档即整体替换。

4. **为什么工具结果不能直接堆进上下文？**
   过程性内容占用窗口且拉低模型智商——工具结果回填后，在下轮组装时被
   滑动窗口/摘要机制确定性剔除，用户看到的始终只有叙事正文。

## 6. 目录结构

```
rp-harness/
  package.json        # type: module，零运行时依赖，node 直跑 .ts
  .env                # API 配置（gitignored）
  src/
    config.ts
    llm/client.ts
    harness/{harness,context,memory-ledger,decision-card}.ts
    roleplay/{character-card,lorebook}.ts
    tools/registry.ts
    server.ts
  web/index.html      # 原生 JS 前端，无构建
  scripts/smoke.ts    # CLI 冒烟
  test/*.test.ts      # node --test 单元测试（mock LLM）
  docs/{DESIGN,RESUME}.md
```

## 7. 数据目录（纯 JSON，可备份迁移）

```
state/
  ledger.json          # 记忆账本（当前世界状态）
  archive.jsonl        # 被压缩的原文（可检索）
  decisions.jsonl      # 决策卡留痕
  snapshots/           # 世界线快照（回档用）
  history.jsonl        # 全部对话原文
```

## 8. 与 Liyuan / pi 的关系（如实写）

本项目**独立实现**，未使用 Liyuan 或 pi 的代码。架构思路受以下启发：
- 上下文裁剪与"过程性内容确定性剔除"（参考 Liyuan 的记忆优化思路）；
- 结构化账本、决策卡、世界线快照（参考 Liyuan 的功能设计）；
- agent 循环与工具回填的通用模式（行业通用做法）。

简历叙事强调**独立设计实现 + 借鉴业界思路**，不做任何"搬运代码"的表述。
