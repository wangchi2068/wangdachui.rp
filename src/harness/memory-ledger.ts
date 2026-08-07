import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LlmClient } from "../llm/client.ts";

/** 账本分区（与内置工具共用同一套语义） */
export const LEDGER_SECTIONS = ["characters", "items", "relations", "plots", "notes"] as const;
export type LedgerSection = (typeof LEDGER_SECTIONS)[number];

export interface Ledger {
  version: number;
  updatedAt: string;
  characters: Record<string, unknown>[];
  items: Record<string, unknown>[];
  relations: Record<string, unknown>[];
  plots: Record<string, unknown>[];
  notes: Record<string, unknown>[];
}

export function emptyLedger(): Ledger {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    characters: [],
    items: [],
    relations: [],
    plots: [],
    notes: [],
  };
}

export function loadLedger(stateDir: string): Ledger {
  try {
    const raw = JSON.parse(readFileSync(resolve(stateDir, "ledger.json"), "utf8"));
    const base = emptyLedger();
    for (const s of LEDGER_SECTIONS) {
      if (Array.isArray(raw[s])) base[s] = raw[s] as Record<string, unknown>[];
    }
    return base;
  } catch {
    return emptyLedger();
  }
}

export function saveLedger(stateDir: string, ledger: Ledger): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(resolve(stateDir, "ledger.json"), JSON.stringify(ledger, null, 2), "utf8");
}

/**
 * 从模型输出中稳健地提取 JSON：
 * 直接解析 → 剥 ```json 围栏 → 截取首尾大括号。
 * 记账/压缩/摘要都靠它兜底，宁可失败也不让坏文本进账本。
 */
export function extractJson(text: string): unknown | null {
  const t = text.trim();
  if (t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch {
      /* fall through */
    }
  }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try {
      return JSON.parse(t.slice(s, e + 1));
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** 条目的去重键：优先用条目自带 key 字段，否则用整条 JSON 字符串 */
function entryKey(entry: unknown): string {
  if (typeof entry === "object" && entry !== null) {
    const k = (entry as Record<string, unknown>).key;
    if (typeof k === "string" && k) return k;
  }
  return JSON.stringify(entry);
}

/**
 * 合并增量账本到现有账本：按分区追加，同名 key 去重（同名更新、不重复堆积）。
 * 多写者（agent 工具 + 旁侧记账）共用这一个合并入口。
 */
export function mergeLedger(current: Ledger, delta: Record<string, unknown>): Ledger {
  const next = emptyLedger();
  for (const s of LEDGER_SECTIONS) next[s] = [...current[s]];
  next.version = current.version;
  next.updatedAt = current.updatedAt;

  for (const s of LEDGER_SECTIONS) {
    const entries = delta[s];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const key = entryKey(entry);
      const idx = next[s].findIndex((x) => entryKey(x) === key);
      if (idx >= 0) next[s][idx] = entry; // 同名更新
      else next[s].push(entry);
    }
  }
  return next;
}

/** 把账本渲染成给剧情模型的紧凑快照文本（注入 system prompt 的"当前世界状态"段） */
export function snapshotText(ledger: Ledger): string {
  const lines: string[] = [];
  for (const s of LEDGER_SECTIONS) {
    if (!ledger[s].length) continue;
    const label = { characters: "人物", items: "物品", relations: "关系", plots: "伏笔", notes: "备注" }[s];
    for (const entry of ledger[s]) {
      const { key, ...rest } = entry as Record<string, unknown>;
      const desc = Object.entries(rest)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${k}:${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join("，");
      lines.push(`- [${label}] ${desc}`);
    }
  }
  return lines.length ? lines.join("\n") : "（账本为空）";
}

const SCRIBE_SYSTEM = `你是剧情记账员。根据最新一轮剧情，把确定发生的事实与仍在进行的线索写入世界状态账本。
只记录事实，不写推测。对账本已有条目，同名 key 只更新不新增。
输出严格的 JSON 对象（不要 markdown 代码块，不要任何多余文字）：
{
  "characters": [{"key":"唯一名","name":"姓名","desc":"身份/外貌","status":"存活/受伤/失踪/死亡"}],
  "items": [{"key":"唯一名","name":"物品名","owner":"归属","status":"状态"}],
  "relations": [{"key":"A-B","who":"A","target":"B","type":"关系类型","level":0}],
  "plots": [{"key":"唯一名","desc":"伏笔/线索内容","status":"未回收"}],
  "notes": [{"key":"唯一名","content":"备注"}]
}
没有变化的分区输出空数组 []。`;

function buildScribePrompt(opts: {
  characterName: string;
  userInput: string;
  narrative: string;
  current: Ledger;
}): string {
  return `【角色】${opts.characterName}
【本轮用户输入】${opts.userInput}
【本轮剧情正文】${opts.narrative}
【当前账本】${JSON.stringify(opts.current)}
请输出更新后的增量账本 JSON。`;
}

export interface LedgerUpdate {
  ok: boolean;
  error?: string;
  /** 新增/更新的条目数（按分区计） */
  touched?: number;
}

/**
 * 旁侧模型记账：每轮剧情后独立调用一次模型，产出结构化增量并合并入库。
 * 原则：记账失败绝不阻断剧情——任何异常都降级为"保留旧账本 + 返回错误信息"。
 */
export class LedgerService {
  private client: LlmClient;
  private stateDir: string;

  constructor(client: LlmClient, stateDir: string) {
    this.client = client;
    this.stateDir = stateDir;
  }

  load(): Ledger {
    return loadLedger(this.stateDir);
  }

  async updateAfterTurn(opts: { characterName: string; userInput: string; narrative: string }): Promise<LedgerUpdate> {
    if (!opts.narrative.trim()) return { ok: false, error: "本轮无正文，跳过记账" };
    const current = this.load();
    try {
      const res = await this.client.chat(
        [
          { role: "system", content: SCRIBE_SYSTEM },
          { role: "user", content: buildScribePrompt({ ...opts, current }) },
        ],
        { temperature: 0.2, maxTokens: 2000 },
      );
      const delta = extractJson(res.content) as Record<string, unknown> | null;
      if (!delta) return { ok: false, error: `记账输出非 JSON：${res.content.slice(0, 200)}` };
      const merged = mergeLedger(current, delta);
      merged.updatedAt = new Date().toISOString();
      saveLedger(this.stateDir, merged);
      const touched = LEDGER_SECTIONS.reduce((n, s) => n + (Array.isArray(delta[s]) ? (delta[s] as unknown[]).length : 0), 0);
      return { ok: true, touched };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
