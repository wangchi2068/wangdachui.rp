import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChatMessage, LlmClient } from "../llm/client.ts";
import type { Config } from "../config.ts";

export interface StoredTurn {
  id: string;
  at: string;
  userInput: string;
  /** 本回合 assistant/tool 消息（不含 user，userInput 单独存） */
  messages: ChatMessage[];
}

export interface PruneResult {
  compressedTurns: number;
  archivedChars: number;
}

/** 字符估算（中文为主的剧情，约 3 字符 ≈ 1 token，偏保守） */
export function estimateChars(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += (m.content ?? "").length;
  return n;
}

export function charsToTokens(chars: number): number {
  return Math.ceil(chars / 3);
}

const SUMMARY_SYSTEM = `你是剧情摘要员。把一段早期剧情合并进已有的「前情提要」，输出合并后的完整摘要。
要求：
- 按时间顺序保留关键事件、人物关系变化、重要物品、未回收的伏笔；
- 保留具体专有名词（人名、地名、物品名），不概括成"某人""某地"；
- 省略日常寒暄与过程性内容；
- 直接输出摘要正文，不要解释，不要序号，不超过 600 字。`;

/**
 * 上下文管理器——"每轮裁剪上下文"的落地实现。
 *
 * 模型看到的永远只有三层：
 *   system（人设+世界书+账本） → 前情提要（早期剧情的压缩产物） → 滑动窗口（近期原文）
 *
 * 回合结束后检查预算：超了就把最旧的原文回合交给旁侧模型并入前情提要，
 * 原文按 JSONL 归档到 archive.jsonl（可检索，不丢真相）。
 * 过程性内容（工具调用中间结果等）随窗口滑出后被确定性剔除。
 */
export class ContextManager {
  private client: LlmClient;
  private cfg: Config;
  private turns: StoredTurn[] = [];
  private summary = "";
  private compressedUpTo = 0;
  private dir: string;

  constructor(client: LlmClient, cfg: Config) {
    this.client = client;
    this.cfg = cfg;
    this.dir = cfg.stateDir;
    this.load();
  }

  private historyPath(): string {
    return resolve(this.dir, "history.jsonl");
  }
  private archivePath(): string {
    return resolve(this.dir, "archive.jsonl");
  }
  private contextPath(): string {
    return resolve(this.dir, "context.json");
  }

  private load(): void {
    try {
      const ctx = JSON.parse(readFileSync(this.contextPath(), "utf8")) as {
        summary?: string;
        compressedUpTo?: number;
      };
      if (typeof ctx.summary === "string") this.summary = ctx.summary;
      if (typeof ctx.compressedUpTo === "number") this.compressedUpTo = ctx.compressedUpTo;
    } catch {
      /* 首次启动 */
    }
    try {
      const text = readFileSync(this.historyPath(), "utf8");
      for (const line of text.split("\n")) {
        if (line.trim()) this.turns.push(JSON.parse(line) as StoredTurn);
      }
    } catch {
      /* 无历史 */
    }
  }

  private persist(): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(
      this.contextPath(),
      JSON.stringify({ summary: this.summary, compressedUpTo: this.compressedUpTo, turns: this.turns.length }, null, 2),
      "utf8",
    );
  }

  get summaryText(): string {
    return this.summary;
  }
  /** 滑动窗口内的回合数 */
  get windowSize(): number {
    return this.turns.length - this.compressedUpTo;
  }
  get totalTurns(): number {
    return this.turns.length;
  }
  /** 全部回合（UI 初始化渲染用） */
  get allTurns(): StoredTurn[] {
    return this.turns;
  }

  /** 组装模型可见消息：system → 前情提要 → 滑动窗口 → 当前用户输入 */
  visibleMessages(systemText: string, userInput: string): ChatMessage[] {
    const msgs: ChatMessage[] = [{ role: "system", content: systemText }];
    if (this.summary) msgs.push({ role: "system", content: `【前情提要】\n${this.summary}` });
    for (let i = this.compressedUpTo; i < this.turns.length; i++) {
      const t = this.turns[i];
      if (t.userInput) msgs.push({ role: "user", content: t.userInput });
      msgs.push(...t.messages);
    }
    msgs.push({ role: "user", content: userInput });
    return msgs;
  }

  private estimateVisible(systemText: string): number {
    let n = systemText.length;
    if (this.summary) n += this.summary.length;
    for (let i = this.compressedUpTo; i < this.turns.length; i++) {
      const t = this.turns[i];
      n += t.userInput.length + estimateChars(t.messages);
    }
    return n;
  }

  /** 当前模型可见消息的总字符数（调试/展示用） */
  visibleChars(systemText: string): number {
    return this.estimateVisible(systemText);
  }

  /**
   * 回合结束：落盘新回合 → 预算检查 → 超了就把最旧原文回合压进前情提要并归档。
   * 失败降级：摘要压缩失败仍归档原文并推进（真相不丢），只损失压缩机会。
   */
  async endTurn(opts: { systemText: string; userInput: string; added: ChatMessage[] }): Promise<PruneResult> {
    this.turns.push({
      id: `t${this.turns.length + 1}`,
      at: new Date().toISOString(),
      userInput: opts.userInput,
      messages: opts.added,
    });

    const budget = this.cfg.contextBudgetChars;
    // 预留 20% 给模型回复，另扣掉 system 本身
    const available = Math.floor(budget * 0.8) - opts.systemText.length;
    let compressedTurns = 0;
    let archivedChars = 0;
    let guard = 0;

    while (this.compressedUpTo < this.turns.length && guard++ < 30) {
      if (this.estimateVisible(opts.systemText) <= available) break;
      const turn = this.turns[this.compressedUpTo];
      this.summary = await this.mergeSummary(turn);
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(
        this.archivePath(),
        JSON.stringify({ id: turn.id, at: turn.at, userInput: turn.userInput, messages: turn.messages }) + "\n",
        "utf8",
      );
      archivedChars += turn.userInput.length + estimateChars(turn.messages);
      this.compressedUpTo++;
      compressedTurns++;
    }

    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.historyPath(), JSON.stringify(this.turns[this.turns.length - 1]) + "\n", "utf8");
    this.persist();
    return { compressedTurns, archivedChars };
  }

  /** 旁侧模型：把最旧回合并入前情提要（输出合并后的完整摘要，非增量） */
  private async mergeSummary(turn: StoredTurn): Promise<string> {
    const narrative = turn.messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.content ?? "")
      .join("\n");
    const res = await this.client.chat(
      [
        { role: "system", content: SUMMARY_SYSTEM },
        {
          role: "user",
          content: `【已有前情提要】\n${this.summary || "（无）"}\n\n【新剧情·用户】\n${turn.userInput}\n【新剧情·正文】\n${narrative}\n\n请输出合并后的完整前情提要。`,
        },
      ],
      { temperature: 0.3, maxTokens: 900 },
    );
    return res.content.trim() || this.summary;
  }

  /** 在归档原文里检索（"压缩后仍可召回"的落点） */
  archiveSearch(keyword: string, limit = 5): StoredTurn[] {
    try {
      const text = readFileSync(this.archivePath(), "utf8");
      const hits: StoredTurn[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const t = JSON.parse(line) as StoredTurn;
          if (JSON.stringify(t).includes(keyword)) {
            hits.push(t);
            if (hits.length >= limit) break;
          }
        } catch {
          /* 跳过坏行 */
        }
      }
      return hits;
    } catch {
      return [];
    }
  }
}
