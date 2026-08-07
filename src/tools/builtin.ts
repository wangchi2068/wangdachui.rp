import { ToolRegistry } from "./registry.ts";
import { loadLedger, saveLedger, mergeLedger, snapshotText, type LedgerSection } from "../harness/memory-ledger.ts";

export interface ToolEnv {
  stateDir: string;
}

/**
 * 内置工具（真实实现）：
 * - ledger_read：读当前账本（快照文本），开场/关键决策前用；
 * - ledger_write：agent 主动记录事实（旁侧模型记账之外的显式写入口）。
 * 多写者共用 mergeLedger，按 key 去重合并。
 */
export function registerBuiltinTools(registry: ToolRegistry, env: ToolEnv): void {
  registry.register({
    name: "ledger_read",
    description: "读取当前世界状态账本（人物/物品/关系/伏笔的结构化快照）。开场与关键决策前先读账本再动笔。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => snapshotText(loadLedger(env.stateDir)),
  });

  registry.register({
    name: "ledger_write",
    description:
      "向世界状态账本写入条目。分区：characters(人物)/items(物品)/relations(关系)/plots(伏笔)/notes(备注)。条目带 key 字段则同名覆盖，否则追加。",
    parameters: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["characters", "items", "relations", "plots", "notes"],
          description: "账本分区",
        },
        entry: { type: "object", description: "条目对象，建议带 key 字段用于去重" },
      },
      required: ["section", "entry"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const section = String(args.section ?? "notes") as LedgerSection;
      const entry = (args.entry ?? {}) as Record<string, unknown>;
      if (!entry.key) entry.key = JSON.stringify(entry).slice(0, 60);
      const ledger = loadLedger(env.stateDir);
      const merged = mergeLedger(ledger, { [section]: [entry] } as Record<string, unknown>);
      saveLedger(env.stateDir, merged);
      return `已写入 ${section} 分区，该分区现有 ${merged[section].length} 条`;
    },
  });
}
