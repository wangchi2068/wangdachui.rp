import { parseLorebook, type LorebookEntry } from "./lorebook.ts";

export interface CharacterCard {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  systemPrompt?: string;
  postHistoryInstructions?: string;
  alternateGreetings?: string[];
  creator?: string;
  tags?: string[];
  /** 卡内嵌世界书（角色卡 v2 的 character_book） */
  characterBook?: LorebookEntry[];
}

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const strArray = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length ? out : undefined;
};

/**
 * 解析 SillyTavern 角色卡。
 * 兼容三种外层结构：
 *  - v2：{ spec:"chara_card_v2", data:{...} }
 *  - v1：{ character:{...} }
 *  - 裸扁平：{ name, description, ... }
 * 容错：缺字段给空串/默认，不因缺字段失败。
 */
export function parseCard(raw: unknown): CharacterCard | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const data =
    o.data && typeof o.data === "object"
      ? (o.data as Record<string, unknown>)
      : o.character && typeof o.character === "object"
        ? (o.character as Record<string, unknown>)
        : o;

  const card: CharacterCard = {
    name: s(data.name) || "未命名角色",
    description: s(data.description),
    personality: s(data.personality),
    scenario: s(data.scenario),
    firstMes: s(data.first_mes),
    mesExample: s(data.mes_example),
    systemPrompt: data.system_prompt !== undefined ? s(data.system_prompt) : undefined,
    postHistoryInstructions: s(data.post_history_instructions) || undefined,
    alternateGreetings: strArray(data.alternate_greetings),
    creator: s(data.creator) || undefined,
    tags: strArray(data.tags),
  };

  if (data.character_book && typeof data.character_book === "object") {
    card.characterBook = parseLorebook(data.character_book);
  }
  return card;
}
