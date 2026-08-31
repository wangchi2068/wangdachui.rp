# ADR-0002：确定性代码管记忆，模型只管生成

- 状态：已接受（2026-08）
- 关联模块：`src/harness/memory-ledger.ts`、`src/harness/context.ts`

## 背景

多轮 Agent 的记忆普遍靠"把历史全塞进上下文"或"让模型自觉记住"。前者随轮次线性膨胀、超预算；后者无结构、不可查询、不可合并，模型间迁移即丢失。

## 决策

记忆分两层，全部由确定性代码编排：

1. **结构化账本**（memory-ledger）：每轮结束后由旁侧模型产出增量 JSON（人物/物品/关系/伏笔/备注），按 `key` 去重合并写入 `ledger.json`，下轮注入 system prompt。记账失败降级为"保留旧账本"，绝不阻断剧情。
2. **前情提要**（context）：早期原文回合交给旁侧模型压缩并入摘要，原文归档到 `archive.jsonl` 可检索可召回——压缩是"丢失细节的落点可控"而非"永久丢失"。

## 后果

- 正面：记忆可查询（`/state`）、可回档、可跨模型迁移（纯 JSON）；模型输出永不改写，harness 只做输入侧加工；压缩损失可量化（见 `reports/EVALUATION.md`：小预算压缩后记忆保持率 85%+）。
- 代价：每回合多一次旁侧模型调用（成本约 +20% token，可用更便宜模型分级对冲）。
- 关键设计：旁侧模型（scribe/compress）与主模型分离配置（`WANGDACHUI_SCRIBE_MODEL` / `WANGDACHUI_COMPRESS_MODEL`）。
