# ADR-0007：SQLite 持久化（node:sqlite）

- 状态：已接受（2026-08）
- 关联模块：`src/store.ts`、`src/harness/context.ts`、`src/harness/memory-ledger.ts`、`src/harness/worldline.ts`、`src/director/director.ts`、`src/server.ts`

## 背景

原实现把会话状态散落在 6 个 JSON/JSONL 文件（ledger/context/card/director 为 JSON，history/archive/decisions 为追加 JSONL）。问题：追加式 JSONL 无随机读、无事务、目录膨胀后备份/回档笨重；"快照 = 复制 N 个文件"的语义在文件增长后开销线性上升。

## 决策

引入 `src/store.ts`：**每会话一个 `<stateDir>/state.db`**，Node ≥ 22 内置 `node:sqlite`（保持零依赖）。两张表承载全部状态：

- `kv(key, value)`：单文档状态（ledger / context / card / director）；
- `lines(kind, seq, value)`：追加式记录（history / archive / decisions），`seq` 保序。

公开接口（`loadLedger/saveLedger/recordDecision/ContextManager/Director/worldline`）签名不变，内部实现切换。启动时若 `state.db` 不存在而旧 JSON 存在，**自动迁移并删除旧文件**（幂等）。快照语义保留：`state/snapshots/*.json` 仍为文件，bundle 内容改为 `store.exportAll()/importAll()`。

## 后果

- 正面：追加保序、随机读写、单文件备份/回档（快照 = 一次导出）；事务性写入（WAL 模式）降低中断损坏风险；迁移路径平滑（旧数据自动导入）；
- 代价：`node:sqlite` 在 Node 22 为实验特性（有 ExperimentalWarning，API 稳定）；Windows 下未关闭的句柄会阻止目录删除（测试已显式 `close()`）；
- 指标：每会话一个 db 文件，`state/` 目录结构简化（`state.db` + `sessions/<sid>/state.db` + `snapshots/`）。
