import type { CharacterCard } from "./character-card.ts";
import { buildLoreText, type LorebookEntry } from "./lorebook.ts";

export interface SystemParts {
  card: CharacterCard;
  /** 已激活的世界书条目 */
  lore?: LorebookEntry[];
  /** 账本快照文本（memory-ledger.snapshotText 的输出） */
  ledgerSnapshot?: string;
  /** 额外规则（如"回应不超过200字"） */
  extraRules?: string;
}

/**
 * 组装 system prompt：角色人设 + 世界书 + 世界状态账本。
 * 顺序固定（人设 → 设定 → 状态），每段缺则跳过。
 */
export function buildSystemPrompt(parts: SystemParts): string {
  const { card } = parts;
  const blocks: string[] = [];
  blocks.push(`你是「${card.name}」。请始终以该角色的视角、用第一人称回应，保持人设与说话风格。`);
  if (card.description) blocks.push(`【人物设定】\n${card.description}`);
  if (card.personality) blocks.push(`【性格】\n${card.personality}`);
  if (card.scenario) blocks.push(`【背景】\n${card.scenario}`);
  if (card.mesExample) blocks.push(`【对话示例】\n${card.mesExample}`);
  if (card.systemPrompt) blocks.push(`【作者系统指令】\n${card.systemPrompt}`);
  if (parts.lore?.length) {
    const loreText = buildLoreText(parts.lore);
    if (loreText) blocks.push(loreText);
  }
  if (parts.ledgerSnapshot) blocks.push(`【当前世界状态（账本快照）】\n${parts.ledgerSnapshot}`);
  if (parts.extraRules) blocks.push(parts.extraRules);
  if (card.postHistoryInstructions) blocks.push(`【回合后指令】\n${card.postHistoryInstructions}`);
  return blocks.join("\n\n");
}
