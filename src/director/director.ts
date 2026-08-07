import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAIN_ARC, type Phase } from "./arc.ts";

export interface DirectorState {
  /** 当前阶段在 MAIN_ARC 中的下标 */
  phaseIndex: number;
  /** 已推进过的阶段 id（留痕） */
  unlocked: string[];
  /** 推进时间 */
  advancedAt?: string;
}

const defaultState = (): DirectorState => ({ phaseIndex: 0, unlocked: [MAIN_ARC[0]!.id] });

/**
 * 主线导演：以规则驱动三幕大纲的推进。
 * - 回合后调用 advance()：把最近剧情文本与当前阶段的解锁关键词比对，
 *   命中且回合数达标 → 推进到下一阶段；
 * - buildDirective() 生成注入 system 的【主线】段：模型每轮都能看到当前目标，
 *   但只有刚推进时注入一次 eventHint（事件钩子），避免变成"任务清单刷屏"。
 * 状态持久化 state/director.json（随世界线快照一起回档）。
 */
export class Director {
  private stateDir: string;
  private state: DirectorState;
  /** 刚推进到新阶段、事件钩子待注入的标志（由调用方消费一次） */
  private pendingEvent = false;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.state = this.load();
  }

  private load(): DirectorState {
    try {
      const raw = JSON.parse(readFileSync(resolve(this.stateDir, "director.json"), "utf8")) as Partial<DirectorState>;
      const base = defaultState();
      return {
        phaseIndex: typeof raw.phaseIndex === "number" && raw.phaseIndex >= 0 && raw.phaseIndex < MAIN_ARC.length ? raw.phaseIndex : 0,
        unlocked: Array.isArray(raw.unlocked) ? raw.unlocked : base.unlocked,
        advancedAt: typeof raw.advancedAt === "string" ? raw.advancedAt : undefined,
      };
    } catch {
      return defaultState();
    }
  }

  private persist(): void {
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(resolve(this.stateDir, "director.json"), JSON.stringify(this.state, null, 2), "utf8");
  }

  /** 重置主线（换卡/新会话时调用）：清空进度并落盘 */
  reset(): void {
    this.state = defaultState();
    this.pendingEvent = false;
    this.persist();
  }

  currentPhase(): Phase {
    return MAIN_ARC[this.state.phaseIndex]!;
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
  advance(contextText: string, turnCount: number): { advanced: boolean; from?: Phase; to?: Phase } {
    const idx = this.state.phaseIndex;
    if (idx >= MAIN_ARC.length - 1) return { advanced: false }; // 已是终局
    const phase = MAIN_ARC[idx]!;
    if (turnCount < phase.minTurns) return { advanced: false };
    const ctx = contextText.toLowerCase();
    const hit = phase.unlockKeywords.some((k) => ctx.includes(k.toLowerCase()));
    if (!hit) return { advanced: false };

    const next = MAIN_ARC[idx + 1]!;
    this.state.phaseIndex = idx + 1;
    this.state.unlocked.push(next.id);
    this.state.advancedAt = new Date().toISOString();
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
    if (this.consumePendingEvent() && phase.eventHint) {
      lines.push(`【主线事件】${phase.eventHint}`);
    }
    return lines.join("\n");
  }

  /** 供 UI 展示的进度摘要 */
  summary(): { phaseId: string; title: string; act: number; objectives: string[]; unlocked: string[] } {
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
