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
 * 关键词激活：常驻条目全量进入；非常驻条目只要任一 key 出现在上下文文本中即激活。
 * 激活的非常驻条目按 insertion_order 升序取前 max 条（防注入爆炸）。
 */
export function activateLore(entries: LorebookEntry[], contextText: string, max = 8): LorebookEntry[] {
  const enabled = entries.filter((e) => e.enabled);
  const constant = enabled.filter((e) => e.constant);
  const ctx = contextText.toLowerCase();
  const keyword = enabled
    .filter((e) => !e.constant && e.keys.some((k) => k && ctx.includes(k)))
    .sort((a, b) => a.insertionOrder - b.insertionOrder)
    .slice(0, max);
  return [...constant, ...keyword];
}

/** 渲染已激活的世界书为 prompt 段落（空则不输出） */
export function buildLoreText(entries: LorebookEntry[]): string {
  if (!entries.length) return "";
  const lines = entries.map((e) => `- ${e.constant ? "(常驻) " : ""}${e.content.replace(/\n+/g, " ")}`);
  return `【世界设定（世界书）】\n${lines.join("\n")}`;
}
