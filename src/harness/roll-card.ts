import type { ToolRegistry } from "../tools/registry.ts";

export interface RollCard {
  /** 检定名称，如「潜行」「交涉」 */
  label: string;
  /** 修正值（属性修正 + 情境），可为负 */
  mod: number;
  /** 目标值 DC */
  dc: number;
}

export interface RollOutcome {
  die: number;
  total: number;
  mod: number;
  dc: number;
  success: boolean;
}

export const ROLL_TOOL_NAME = "roll";

const ROLL_TOOL_SCHEMA = {
  description:
    "行动成败不确定时调用：让玩家亲自投掷 D20（BG3 式交互检定）。传入检定名称、修正值与 DC，前端会渲染骰子卡让玩家点击投掷，服务端返回真随机结果后由你根据结果继续剧情。只在成败有意义的时刻使用，不要滥用。",
  parameters: {
    type: "object",
    properties: {
      label: { type: "string", description: "检定名称，如「潜行」「交涉」「体魄」" },
      mod: { type: "number", description: "修正值（属性修正 + 情境加成，可为负），默认 0" },
      dc: { type: "number", description: "目标值（DC），简单8/常规12/困难16/极难20，默认 12" },
    },
    required: ["label"],
    additionalProperties: false,
  },
} as const;

/** 注册 roll 工具：真正的交互由 harness 拦截处理，这里只占位保证模型能看到工具 */
export function registerRollTool(registry: ToolRegistry): void {
  registry.register({
    name: ROLL_TOOL_NAME,
    description: ROLL_TOOL_SCHEMA.description,
    parameters: ROLL_TOOL_SCHEMA.parameters,
    execute: async () => "roll 由 harness 交互处理，此结果不应出现",
  });
}

/** 解析模型传入的检定参数；参数不合法返回 null */
export function parseRollCard(argsJson: string): RollCard | null {
  try {
    const a = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    const label = typeof a.label === "string" ? a.label.trim() : "";
    if (!label) return null;
    const mod = typeof a.mod === "number" && Number.isFinite(a.mod) ? Math.round(a.mod) : 0;
    const dc = typeof a.dc === "number" && Number.isFinite(a.dc) ? Math.round(a.dc) : 12;
    return { label, mod, dc };
  } catch {
    return null;
  }
}

/** 服务端真随机掷 D20（1-20），返回完整结果 */
export function rollD20(card: RollCard): RollOutcome {
  const die = Math.floor(Math.random() * 20) + 1;
  const total = die + card.mod;
  return { die, total, mod: card.mod, dc: card.dc, success: total >= card.dc };
}
