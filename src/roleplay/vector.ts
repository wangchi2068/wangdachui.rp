/**
 * 零依赖本地向量检索引擎。
 *
 * 思路：对文本做字符级 n-gram 切分（中文无空格，字符 bigram 是廉价且有效的
 * 子词表征），统计每个 token 在语料中的 TF-IDF 权重得到稀疏向量，再用余弦
 * 相似度度量文本语义相关度。纯 Node 内置 API，无第三方依赖，离线可跑。
 *
 * 该引擎用于世界书语义回收：即使剧情里没出现角色关键词（例如剧情只说"便利
 * 店老板娘"而未提"苏涟漪"），也能按字符分布相似度把对应世界书条目召回来。
 */

/** 归一化：转小写，剔除空白/标点/emoji，保留中文字符、数字、拉丁字母 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{N}\p{L}]/gu, "");
}

/** 字符 n-gram 切分："都市修仙", n=2 -> ["都市","市修","修仙"] */
export function ngram(text: string, n = 2): string[] {
  const s = normalize(text);
  const k = n <= 0 ? 1 : n;
  if (s.length < k) return s.length ? [s] : [];
  const out: string[] = [];
  for (let i = 0; i + k <= s.length; i++) out.push(s.slice(i, i + k));
  return out;
}

/** 词频统计：token -> 出现次数 */
export function termFreq(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export interface VectorTerm {
  term: string;
  /** TF-IDF 权重 */
  weight: number;
}

/** 文档频率：统计每个 term 出现在多少篇语料中 */
export function buildDf(texts: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const t of texts) {
    for (const term of new Set(ngram(t, 2))) df.set(term, (df.get(term) ?? 0) + 1);
  }
  return df;
}

/**
 * 由文本 + 全局文档频率表构建 TF-IDF 稀疏向量。
 * idf(term) = ln(1 + N / (1 + df(term)))，N 为语料文档数。
 */
export function tfidfVector(
  text: string,
  df: Map<string, number>,
  docCount: number,
): VectorTerm[] {
  const tokens = ngram(text, 2);
  const tf = termFreq(tokens);
  const total = tokens.length || 1;
  const out: VectorTerm[] = [];
  for (const [term, count] of tf) {
    const idf = Math.log(1 + docCount / (1 + (df.get(term) ?? 0)));
    out.push({ term, weight: (count / total) * idf });
  }
  return out;
}

/** 两个 TF-IDF 稀疏向量的余弦相似度（0..1）。任一为空返回 0。 */
export function cosine(vecA: VectorTerm[], vecB: VectorTerm[]): number {
  const b = new Map<string, number>();
  for (const v of vecB) b.set(v.term, v.weight);
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (const v of vecA) {
    aNorm += v.weight * v.weight;
    const other = b.get(v.term);
    if (other !== undefined) dot += v.weight * other;
  }
  for (const v of vecB) bNorm += v.weight * v.weight;
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

export interface Scored {
  /** 语料索引下标 */
  index: number;
  score: number;
}

/**
 * 轻量向量索引：构造时接收文档集，构建 DF 并预计算各文档向量；
 * 查询时对每篇文档算余弦、降序返回 topK 个 {index, score}。
 * 世界书条目数十篇量级，全量线性扫描开销可忽略，无需持久化。
 */
export class VectorIndex {
  private docs: { text: string; vec: VectorTerm[] }[] = [];
  private df = new Map<string, number>();
  private docCount = 0;

  constructor(docTexts: string[]) {
    this.df = buildDf(docTexts);
    this.docCount = docTexts.length;
    for (const t of docTexts) {
      this.docs.push({ text: t, vec: tfidfVector(t, this.df, this.docCount) });
    }
  }

  /** 语料条数 */
  get size(): number {
    return this.docCount;
  }

  /** 查询：返回按相似度降序的 topK 结果 */
  query(queryText: string, topK = 5): Scored[] {
    const qvec = tfidfVector(queryText, this.df, this.docCount);
    const scored = this.docs.map((d, i) => ({ index: i, score: cosine(qvec, d.vec) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}