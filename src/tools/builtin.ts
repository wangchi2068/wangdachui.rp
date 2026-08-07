import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ToolRegistry } from "./registry.ts";

export interface ToolEnv {
  stateDir: string;
}

/**
 * 内置工具（任务 2 占位版）。
 * ledger_read / ledger_write 先提供可运行的简单实现，任务 3 换成
 * 旁侧模型自动记账 + 结构化合并。
 */
export function registerBuiltinTools(registry: ToolRegistry, env: ToolEnv): void {
  const ledgerPath = resolve(env.stateDir, "ledger.json");
  const readLedger = (): string => {
    try {
      return readFileSync(ledgerPath, "utf8");
    } catch {
      return "{}";
    }
  };

  registry.register({
    name: "ledger_read",
    description: "读取当前世界状态账本（结构化 JSON：人物、物品、关系、时间线、伏笔）。开场或关键决策前先读账本再动笔。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => readLedger(),
  });

  registry.register({
    name: "ledger_write",
    description:
      "向世界状态账本写入条目。分区：characters(人物状态)/items(物品)/relations(关系)/plots(伏笔与剧情线)/notes(备注)。写入会追加记录。",
    parameters: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["characters", "items", "relations", "plots", "notes"],
          description: "账本分区",
        },
        entry: { type: "object", description: "要写入的条目对象" },
      },
      required: ["section", "entry"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const section = String(args.section ?? "notes");
      const entry = (args.entry ?? {}) as Record<string, unknown>;
      mkdirSync(env.stateDir, { recursive: true });
      let ledger: Record<string, unknown[]> = {};
      try {
        ledger = JSON.parse(readLedger());
      } catch {
        ledger = {};
      }
      if (!Array.isArray(ledger[section])) ledger[section] = [];
      ledger[section].push({ at: new Date().toISOString(), ...entry });
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
      return `已写入 ${section}，该分区现有 ${ledger[section].length} 条记录`;
    },
  });
}
