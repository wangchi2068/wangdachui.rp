import type { ChatMessage, LlmClient } from "../llm/client.ts";
import type { Config } from "../config.ts";
import { openStore, type Store } from "../store.ts";
import { metrics } from "../metrics.ts";

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
	/** 是否还有压缩欠账（预算仍超，需异步补压） */
	pending: boolean;
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

export const SUMMARY_SYSTEM = `你是剧情摘要员。把一段早期剧情合并进已有的「前情提要」，输出合并后的完整摘要。
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
 * 原文归档进 SQLite（可检索，不丢真相）。
 * 过程性内容（工具调用中间结果等）随窗口滑出后被确定性剔除。
 *
 * 存储：每会话一个 <stateDir>/state.db（node:sqlite，零依赖），
 * 历史/归档为追加行，摘要等单文档为键值。
 */
export class ContextManager {
	private client: LlmClient;
	private cfg: Config;
	private turns: StoredTurn[] = [];
	private summary = "";
	private compressedUpTo = 0;
	private store: Store;

	constructor(client: LlmClient, cfg: Config, stateDir?: string) {
		this.client = client;
		this.cfg = cfg;
		this.store = openStore(stateDir ?? cfg.stateDir);
		this.load();
	}

	/** 关闭底层存储（测试与回档场景使用；常驻服务无需显式调用） */
	close(): void {
		this.store.close();
	}

	private load(): void {
		try {
			const raw = this.store.kvGet("context");
			if (raw) {
				const ctx = JSON.parse(raw) as {
					summary?: string;
					compressedUpTo?: number;
				};
				if (typeof ctx.summary === "string") this.summary = ctx.summary;
				if (typeof ctx.compressedUpTo === "number")
					this.compressedUpTo = ctx.compressedUpTo;
			}
		} catch {
			/* 首次启动 */
		}
		try {
			for (const line of this.store.readLines("history")) {
				if (line.trim()) this.turns.push(JSON.parse(line) as StoredTurn);
			}
		} catch {
			/* 无历史 */
		}
	}

	private persist(): void {
		this.store.kvSet(
			"context",
			JSON.stringify({
				summary: this.summary,
				compressedUpTo: this.compressedUpTo,
				turns: this.turns.length,
			}),
		);
	}

	/** 全新对话：清空内存与存储中的历史/摘要/归档（保留目录与库） */
	reset(): void {
		this.turns = [];
		this.summary = "";
		this.compressedUpTo = 0;
		this.store.removeKind("history");
		this.store.removeKind("archive");
		this.store.kvDelete("context");
		this.persist();
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
		if (this.summary)
			msgs.push({ role: "system", content: `【前情提要】\n${this.summary}` });
		for (let i = this.compressedUpTo; i < this.turns.length; i++) {
			const t = this.turns[i];
			if (!t) continue;
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
			if (!t) continue;
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
	async endTurn(opts: {
		systemText: string;
		userInput: string;
		added: ChatMessage[];
	}): Promise<PruneResult> {
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

		while (this.compressedUpTo < this.turns.length && guard++ < 2) {
			if (this.estimateVisible(opts.systemText) <= available) break;
			const turn = this.turns[this.compressedUpTo];
			if (!turn) break;
			metrics.inc("context.compression_runs");
			this.summary = await this.mergeSummary(turn);
			this.store.append(
				"archive",
				JSON.stringify({
					id: turn.id,
					at: turn.at,
					userInput: turn.userInput,
					messages: turn.messages,
				}),
			);
			archivedChars += turn.userInput.length + estimateChars(turn.messages);
			this.compressedUpTo++;
			compressedTurns++;
		}

		if (compressedTurns > 0) {
			metrics.inc("context.compression_turns", compressedTurns);
			metrics.inc("context.archive_chars", archivedChars);
		}

		this.store.append(
			"history",
			JSON.stringify(this.turns[this.turns.length - 1]),
		);
		this.persist();
		return {
			compressedTurns,
			archivedChars,
			pending:
				compressedTurns > 0 && this.turns.length - this.compressedUpTo > 0,
		};
	}

	/**
	 * 异步补压：回合已返回后继续压缩剩余超预算回合（fire-and-forget，不阻塞玩家）。
	 * 每批最多 2 次合并，直到预算达标或回合耗尽。
	 */
	async drainCompression(systemText: string): Promise<number> {
		let n = 0;
		const budget = this.cfg.contextBudgetChars;
		const available = Math.floor(budget * 0.8) - systemText.length;
		while (n < 4 && this.compressedUpTo < this.turns.length) {
			if (this.estimateVisible(systemText) <= available) break;
			const turn = this.turns[this.compressedUpTo];
			if (!turn) break;
			metrics.inc("context.compression_runs");
			this.summary = await this.mergeSummary(turn);
			this.store.append(
				"archive",
				JSON.stringify({
					id: turn.id,
					at: turn.at,
					userInput: turn.userInput,
					messages: turn.messages,
				}),
			);
			this.compressedUpTo++;
			n++;
		}
		if (n > 0) {
			metrics.inc("context.compression_turns", n);
		}
		this.persist();
		return n;
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
			{ temperature: 0.3, maxTokens: 900, model: this.cfg.compressModel },
		);
		const merged = res.content.trim();
		// 健壮性：输出为空或异常过短（相比旧摘要），保留旧摘要并降级（真相仍在归档里）
		const tooShort =
			merged.length < 20 ||
			(this.summary.length > 0 && merged.length < this.summary.length * 0.5);
		if (tooShort) {
			console.warn(`〔压缩〕摘要输出异常（${merged.length} 字），保留旧摘要`);
			return this.summary;
		}
		return merged;
	}

	/** 在归档原文里检索（"压缩后仍可召回"的落点） */
	archiveSearch(keyword: string, limit = 5): StoredTurn[] {
		const hits: StoredTurn[] = [];
		for (const line of this.store.readLines("archive")) {
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
		if (hits.length > 0) metrics.inc("context.recall_hits", hits.length);
		return hits;
	}

	/**
	 * 旧事重提：用向量语义召回归档里与当前输入最相关的回合（"压缩掉的细节"重新浮现）。
	 * 匹配当前叙事语境，避免 keyword 生搬硬套。
	 */
	recallFromArchive(query: string, limit = 2): StoredTurn[] {
		const turns: StoredTurn[] = [];
		for (const line of this.store.readLines("archive")) {
			if (!line.trim()) continue;
			try {
				turns.push(JSON.parse(line) as StoredTurn);
			} catch {
				/* 跳过坏行 */
			}
		}
		if (!turns.length) return [];
		// 按时间倒序优先最近相关；简单相关性 = 输入词与回合文本的字符重叠度
		const q = query.toLowerCase();
		const scored = turns
			.map((t, i) => {
				const body =
					`${t.userInput} ${t.messages.map((m) => m.content ?? "").join(" ")}`.toLowerCase();
				let score = 0;
				for (const word of q
					.split(/[\s，。！？、,.!?；;：:]/)
					.filter((w) => w.length >= 2)) {
					if (body.includes(word)) score += word.length;
				}
				return { t, i, score };
			})
			.filter((s) => s.score > 0)
			.sort((a, b) => b.score - a.score || b.i - a.i);
		return scored.slice(0, limit).map((s) => s.t);
	}
}
