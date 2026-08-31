import { openStore } from "../store.ts";
import { MAIN_ARC, type Phase } from "./arc.ts";

export interface DirectorState {
	/** 当前阶段在 arc 中的下标 */
	phaseIndex: number;
	/** 已推进过的阶段 id（留痕） */
	unlocked: string[];
	/** 推进时间 */
	advancedAt?: string;
	/** 最近一次推进时的回合数（防连跳：间隔不足不再推进） */
	lastAdvanceTurn?: number;
}

const defaultState = (arc: Phase[]): DirectorState => ({
	phaseIndex: 0,
	unlocked: [arc[0]!.id],
});

/**
 * 主线导演：以规则驱动三幕大纲的推进。
 * - 回合后调用 advance()：把最近剧情文本与当前阶段的解锁关键词比对，
 *   命中且回合数达标 → 推进到下一阶段；
 * - buildDirective() 生成注入 system 的【主线】段：模型每轮都能看到当前目标，
 *   但只有刚推进时注入一次 eventHint（事件钩子），避免变成"任务清单刷屏"。
 * 状态持久化 state.db 的 kv:director（随世界线快照一起回档）。
 */
export class Director {
	private stateDir: string;
	private arc: Phase[];
	private state: DirectorState;
	/** 刚推进到新阶段、事件钩子待注入的标志（由调用方消费一次） */
	private pendingEvent = false;

	constructor(stateDir: string, arc: Phase[] = MAIN_ARC) {
		this.stateDir = stateDir;
		this.arc = arc;
		this.state = this.load();
	}

	private load(): DirectorState {
		try {
			const store = openStore(this.stateDir);
			try {
				const raw = store.kvGet("director");
				if (!raw) return defaultState(this.arc);
				const parsed = JSON.parse(raw) as Partial<DirectorState>;
				const base = defaultState(this.arc);
				return {
					phaseIndex:
						typeof parsed.phaseIndex === "number" &&
						parsed.phaseIndex >= 0 &&
						parsed.phaseIndex < this.arc.length
							? parsed.phaseIndex
							: 0,
					unlocked: Array.isArray(parsed.unlocked)
						? parsed.unlocked
						: base.unlocked,
					advancedAt:
						typeof parsed.advancedAt === "string"
							? parsed.advancedAt
							: undefined,
					lastAdvanceTurn:
						typeof parsed.lastAdvanceTurn === "number"
							? parsed.lastAdvanceTurn
							: undefined,
				};
			} finally {
				store.close();
			}
		} catch {
			return defaultState(this.arc);
		}
	}

	private persist(): void {
		const store = openStore(this.stateDir);
		try {
			store.kvSet("director", JSON.stringify(this.state));
		} finally {
			store.close();
		}
	}

	/** 重置主线（换卡/新会话时调用）：清空进度并落盘 */
	reset(): void {
		this.state = defaultState(this.arc);
		this.pendingEvent = false;
		this.persist();
	}

	currentPhase(): Phase {
		return this.arc[this.state.phaseIndex]!;
	}

	/** 检查事件钩子是否待注入，并消费该标志 */
	consumePendingEvent(): boolean {
		const pending = this.pendingEvent;
		this.pendingEvent = false;
		return pending;
	}

	/**
	 * 回合后推进：当前阶段目标达到（任一关键词命中）且回合数达标 → 下一阶段。
	 * 返回是否推进（供调用方决定是否注入事件钩子/通知前端）。
	 */
	advance(
		contextText: string,
		turnCount: number,
	): { advanced: boolean; from?: Phase; to?: Phase } {
		const idx = this.state.phaseIndex;
		if (idx >= this.arc.length - 1) return { advanced: false }; // 已是终局
		const phase = this.arc[idx]!;
		if (turnCount < phase.minTurns) return { advanced: false };
		// 防连跳：距上次推进不足 2 回合不推进（关键词连续命中时也按节奏走）
		if (
			this.state.lastAdvanceTurn !== undefined &&
			turnCount - this.state.lastAdvanceTurn < 2
		) {
			return { advanced: false };
		}
		const ctx = contextText.toLowerCase();
		const hit = phase.unlockKeywords.some((k) => ctx.includes(k.toLowerCase()));
		if (!hit) return { advanced: false };

		const next = this.arc[idx + 1]!;
		this.state.phaseIndex = idx + 1;
		this.state.unlocked.push(next.id);
		this.state.advancedAt = new Date().toISOString();
		this.state.lastAdvanceTurn = turnCount;
		this.pendingEvent = true;
		this.persist();
		return { advanced: true, from: phase, to: next };
	}

	/** 生成注入 system 的【主线】段 */
	buildDirective(): string {
		const phase = this.currentPhase();
		const lines: string[] = [];
		lines.push(`【主线·${phase.title}】`);
		lines.push(`当前目标：${phase.objectives.join("；")}`);
		if (phase.summary) lines.push(`剧情方向：${phase.summary}`);
		if (phase.mood || phase.tension) {
			lines.push(
				`【本幕基调】情绪：${phase.mood ?? "—"}；张力：${phase.tension ?? 5}/10`,
			);
		}
		if (phase.beats?.length) {
			lines.push(`【本幕节奏】${phase.beats.join(" → ")}`);
		}
		if (phase.mustEvents?.length) {
			lines.push(
				`【本幕必发生】${phase.mustEvents.join("；")}（按序推进，玩家选择可改细节但不改事件本身）`,
			);
		}
		// 事件钩子常驻：当前幕的主线事件每回合可见（模型以此为锚，不随自由发挥漂移）；
		// 推进到新幕后自动换成新幕的钩子。
		if (phase.eventHint) {
			lines.push(`【主线事件·进行中】${phase.eventHint}`);
		}
		this.consumePendingEvent(); // 消费标志（兼容旧逻辑，钩子已常驻不再依赖一次性注入）
		return lines.join("\n");
	}

	/** 供 UI 展示的进度摘要 */
	summary(): {
		phaseId: string;
		title: string;
		act: number;
		objectives: string[];
		unlocked: string[];
	} {
		const phase = this.currentPhase();
		return {
			phaseId: phase.id,
			title: phase.title,
			act: phase.act,
			objectives: phase.objectives,
			unlocked: this.state.unlocked,
		};
	}
}
