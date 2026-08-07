import { VectorIndex } from "./vector.ts";

export interface LorebookEntry {
  /** 激活关键词（小写匹配） */
  keys: string[];
  content: string;
  /** 常驻条目：不依赖关键词，始终注入 */
  constant: boolean;
  enabled: boolean;
  /** 数字越小优先级越高 */
  insertionOrder: number;
  comment?: string;
}

/**
 * 解析世界书条目数组（Tavern 格式）。
 * 兼容字段缺失的容错：enabled 默认 true，insertion_order 默认 0。
 */
export function parseLoreEntries(raw: unknown): LorebookEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: LorebookEntry[] = [];
  for (const it of raw) {
    if (typeof it !== "object" || it === null) continue;
    const e = it as Record<string, unknown>;
    const content = typeof e.content === "string" ? e.content : "";
    if (!content) continue;
    entries.push({
      keys: Array.isArray(e.keys) ? e.keys.filter((k): k is string => typeof k === "string").map((k) => k.toLowerCase()) : [],
      content,
      constant: e.constant === true,
      enabled: e.enabled !== false,
      insertionOrder: typeof e.insertion_order === "number" ? e.insertion_order : 0,
      comment: typeof e.comment === "string" ? e.comment : undefined,
    });
  }
  return entries;
}

/**
 * 从世界书文件（独立 .json 或角色卡内嵌 book）解析条目。
 * 兼容两种外层结构：{entries:[...]} 与 {data:{entries:[...]}}。
 */
export function parseLorebook(raw: unknown): LorebookEntry[] {
  if (typeof raw !== "object" || raw === null) return [];
  const o = raw as Record<string, unknown>;
  const data = o.data && typeof o.data === "object" ? (o.data as Record<string, unknown>) : o;
  if (Array.isArray(data.entries)) return parseLoreEntries(data.entries);
  return parseLoreEntries(o.entries);
}

/**
 * 纯关键词激活（向后兼容的默认行为）：常驻条目全量进入；非常驻条目只要任一 key
 * 出现在上下文文本中即激活，按 insertion_order 升序取前 max 条。
 */
export function activateLore(entries: LorebookEntry[], contextText: string, max = 8): LorebookEntry[] {
  const enabled = entries.filter((e) => e.enabled);
  const constant = enabled.filter((e) => e.constant);
  const ctx = contextText.toLowerCase();
  const keyword = enabled
    .filter((e) => !e.constant && e.keys.some((k) => k && ctx.includes(k)))
    .sort((a, b) => a.insertionOrder - b.insertionOrder)
    .slice(0, Math.max(0, max - constant.length));
  return [...constant, ...keyword];
}

/**
 * 混合语义激活：关键词精确命中优先；空余名额由本地向量检索按字符分布相似度补齐。
 * 返回 { entries, source }，source 标注每条是 keyword（关键词命中）还是 vector（向量召回），
 * 便于前端 /lore 调试与单测断言。
 *
 * 分配规则（防注入爆炸总量封顶 max）：
 *  1. 常驻条目恒在；
 *  2. 关键词命中的非常驻条目（按 insertion_order 升序）；
 *  3. 剩余名额取向量 top-N（与已选中去重，按相似度降序），检索失败时静默降级为纯关键词。
 */
export function activateLoreHybrid(
  entries: LorebookEntry[],
  contextText: string,
  max = 8,
  vectorBudget = 4,
): { entries: LorebookEntry[]; rank: ("constant" | "keyword" | "vector")[] } {
  const enabled = entries.filter((e) => e.enabled);
  const constant = enabled.filter((e) => e.constant);
  const ctx = contextText.toLowerCase();
  const rest = enabled.filter((e) => !e.constant);

  // 1) 关键词命中（按 insertion_order 升序），先占满 main 名额
  const keywordCandidates = rest
    .filter((e) => e.keys.some((k) => k && ctx.includes(k)))
    .sort((a, b) => a.insertionOrder - b.insertionOrder);
  const constantQuota = Math.max(0, max - constant.length);
  const keyword = keywordCandidates.slice(0, constantQuota);

  // 2) 向量补充：在剩余名额里，为未命中条目召回最相关的 top-N
  const budget = Math.max(0, max - constant.length - keyword.length);
  const vector: LorebookEntry[] = [];
  const chosen = new Set(keyword);
  if (budget > 0) {
    const candidates = rest.filter((e) => !chosen.has(e));
    try {
      const index = new VectorIndex(candidates.map((e) => `${e.keys.join(" ")} ${e.content}`));
      for (const hit of index.query(contextText, Math.min(vectorBudget, budget))) {
        const e = candidates[hit.index];
        if (!e) continue;
        vector.push(e);
        chosen.add(e);
      }
    } catch {
      /* 向量检索不可用（如静默异常）时降级为纯关键词 */
    }
  }

  const rank: ("constant" | "keyword" | "vector")[] = [
    ...constant.map(() => "constant" as const),
    ...keyword.map(() => "keyword" as const),
    ...vector.map(() => "vector" as const),
  ];
  return { entries: [...constant, ...keyword, ...vector], rank };
}

/** 渲染已激活的世界书为 prompt 段落（空则不输出） */
export function buildLoreText(entries: LorebookEntry[]): string {
  if (!entries.length) return "";
  const lines = entries.map((e) => `- ${e.constant ? "(常驻) " : ""}${e.content.replace(/\n+/g, " ")}`);
  return `【世界设定（世界书）】\n${lines.join("\n")}`;
}
