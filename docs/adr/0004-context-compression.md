# ADR-0004：上下文压缩策略（三层可见 + 归档）

- 状态：已接受（2026-08）
- 关联模块：`src/harness/context.ts`

## 背景

长会话下上下文窗口是硬约束。朴素方案是直接截断——早期剧情细节永久丢失。目标是"预算可控且信息损失可量化"。

## 决策

模型每轮只看到三层：`system（人设+世界书+账本+主线）→ 前情提要（早期剧情压缩产物）→ 滑动窗口（近期原文）`。

- 预算：`contextBudgetChars`（默认 24000 字符 ≈ 8k token），预留 20% 给回复，另扣 system 本身。
- 触发：每轮 `endTurn` 检查估算可见字符，超预算即把最旧原文回合交给旁侧模型并入前情提要，原文按 JSONL 归档。
- 摘要健壮性：输出过短（<20 字或 <旧摘要 50%）时保留旧摘要并降级——真相始终在归档里。
- 补压：回合返回后 `drainCompression` 异步继续压缩剩余超预算回合（fire-and-forget）。
- 召回：`archiveSearch`（关键词）+ `recallFromArchive`（语义近似）让"压缩掉的细节"重新浮现。

## 后果

- 正面：成本与信息保持可量化（`reports/EVALUATION.md`：300 字符极端预算下压缩后记忆保持率 85.4%，正常输出口径压缩节省 12.9% token、关键信息保持 97.1%）。
- 代价：摘要质量依赖旁侧模型；压缩触发是估算（字符/3 ≈ token）非精确 tokenizer，预算留有 20% 余量对冲。
- 指标：`context.compression_runs/turns`、`context.archive_chars`、`context.recall_hits` 全部可观测。
