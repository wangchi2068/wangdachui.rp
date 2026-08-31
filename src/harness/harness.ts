import type { ChatMessage, LlmClient, ToolDef } from "../llm/client.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Config } from "../config.ts";
import {
  DECIDE_TOOL_NAME,
  parseDecisionCard,
  recordDecision,
  type DecisionCard,
  type DecisionRecord,
} from "./decision-card.ts";
import {
  ROLL_TOOL_NAME,
  parseRollCard,
  type RollCard,
  type RollOutcome,
} from "./roll-card.ts";

export interface ToolExecution {
  name: string;
  args: string;
  output: string;
  ok: boolean;
}

/**
 * 出口闸门：剥掉正文里的内联思考块。
 * 有的模型不走 reasoning_content 字段，而是把 <think>…</think> 直接混进 content
 * （流式增量与非流式皆可发生）。裸思考上屏会打破沉浸，还会随历史再进上下文，
 * 被模型当成"正文的一种格式"模仿下去——必须在出口处确定性剔除，不靠提示词。
 * 未闭合的 <think>（截断场景）剥到结尾；成对标签剥中间，前后正文保留。
 */
export function stripInlineThinking(text: string): string {
  if (!text.includes("<think>")) return text;
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
    .trim();
}

export interface TurnResult {
  /** 最终正文（给用户看的剧情/回复） */
  content: string;
  /** 累计思维链（内部，不展示） */
  reasoning: string;
  /** 本回合实际执行的工具调用 */
  tools: ToolExecution[];
  /** 本回合的决策卡交互记录 */
  decisions: DecisionRecord[];
  /** 本回合新增消息（assistant + tool 回填），调用方追加到会话历史 */
  added: ChatMessage[];
  /** 实际调用模型的次数 */
  modelCalls: number;
  /** 累计 token 用量（各次模型调用之和，护栏/成本统计用） */
  usageTotal: number;
  /** 最后一次模型调用的 finish_reason（用于识别截断） */
  lastFinishReason: string;
  stoppedBy: "done" | "max-turns";
}

export interface HarnessOptions {
  /** 正文流式回调（最终剧情增量实时给 UI） */
  onNarrativeDelta?: (delta: string) => void;
  /** 决策卡回调：模型调用 decide 时暂停循环，把卡片交给调用方（CLI/Web），返回用户的选择 */
  onDecisionRequested?: (card: DecisionCard) => Promise<string>;
  /** 掷骰回调：模型调用 roll 时暂停循环，把检定卡交给调用方，返回玩家的真随机投掷结果 */
  onRollRequested?: (card: RollCard) => Promise<RollOutcome>;
  /** 会话级 stateDir：决策留痕写会话目录而非全局（多会话隔离） */
  stateDir?: string;
  /** 覆盖工具列表（测试注入用） */
  tools?: ToolDef[];
  temperature?: number;
}

/**
 * Agent 主循环：思考 → 工具 → 验证 → 再思考。
 *
 * 每一轮：
 *  1. 调模型（流式，思维链只在内部累计）；
 *  2. 若模型请求工具 → 执行 → 以 role=tool 回填 → 带着结果再调；
 *  3. 直到模型自然结束（无 tool_calls）。
 *
 * 三个确定性保障：
 *  - maxLoopTurns 上限：模型循环调同一个工具也必停；
 *  - 中间轮的"思考正文"不外泄，只有最终剧情流式给用户（过程性内容剔除）；
 *  - 工具执行错误也回填给模型修正，不中断剧情。
 */
export class Harness {
  private client: LlmClient;
  private registry: ToolRegistry;
  private cfg: Config;

  constructor(client: LlmClient, registry: ToolRegistry, cfg: Config) {
    this.client = client;
    this.registry = registry;
    this.cfg = cfg;
  }

  async runTurn(history: ChatMessage[], opts: HarnessOptions = {}): Promise<TurnResult> {
    const messages = [...history];
    let reasoning = "";
    const tools: ToolExecution[] = [];
    const decisions: DecisionRecord[] = [];
    let modelCalls = 0;
    let usageTotal = 0;
    let lastFinishReason = "";
    // 本轮正文增量先缓冲：只有确定是最终剧情时才流式外发；
    // 若因循环上限终止，也把最后一次调用的内容外发，避免用户什么都看不到。
    let lastContent = "";
    const toolDefs = opts.tools ?? this.registry.defs();
    const temperature = opts.temperature ?? 0.8;

    for (let i = 0; i < this.cfg.maxLoopTurns; i++) {
      modelCalls++;
      const callBuffer: string[] = [];
      const result = await this.client.stream(messages, {
        tools: toolDefs,
        temperature,
        maxTokens: 4096,
        onDelta: (d) => callBuffer.push(d),
      });
      reasoning += result.reasoning;
      lastFinishReason = result.finishReason;
      lastContent = result.content;
      usageTotal += result.usage?.total ?? 0;

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: result.content || null,
      };
      if (result.toolCalls.length) assistantMsg.tool_calls = result.toolCalls;
      messages.push(assistantMsg);

      if (!result.toolCalls.length) {
        // 自然结束：这是用户看到的正文。出口闸门先剥内联思考块再外发/入历史，
        // 且把 assistant 消息改写为剥净后的正文（裸思考不进上下文，防止被模仿）。
        const clean = stripInlineThinking(result.content);
        assistantMsg.content = clean || null;
        if (clean !== result.content) {
          // 有剥离发生：把缓冲的原始增量整体替换为剥净正文后一次性外发
          callBuffer.length = 0;
          if (clean) callBuffer.push(clean);
        }
        for (const d of callBuffer) opts.onNarrativeDelta?.(d);
        return {
          content: clean,
          reasoning,
          tools,
          decisions,
          added: messages.slice(history.length),
          modelCalls,
          usageTotal,
          lastFinishReason,
          stoppedBy: "done",
        };
      }

      // 执行工具并回填；decide 由 harness 拦截做用户交互
      for (const tc of result.toolCalls) {
        const name = tc.function?.name ?? "";
        const args = tc.function?.arguments ?? "";
        let output: string;
        let ok = true;
        if (name === DECIDE_TOOL_NAME) {
          const card = parseDecisionCard(args);
          if (card) {
            const choice = opts.onDecisionRequested ? await opts.onDecisionRequested(card) : (card.options[0] ?? "");
            recordDecision(opts.stateDir ?? this.cfg.stateDir, card, choice);
            decisions.push({ ...card, at: new Date().toISOString(), choice });
            output = `用户已选择：${choice}。请严格按用户的这个选择继续剧情，不要推翻用户的决定。`;
          } else {
            ok = false;
            output = "decide 参数解析失败：question 必须为非空字符串，options 必须为非空字符串数组。请重新构造调用。";
          }
        } else if (name === ROLL_TOOL_NAME) {
          const rcard = parseRollCard(args);
          if (rcard) {
            const outcome = opts.onRollRequested
              ? await opts.onRollRequested(rcard)
              : { die: 10, total: 10 + rcard.mod, mod: rcard.mod, dc: rcard.dc, success: 10 + rcard.mod >= rcard.dc };
            output = `玩家掷骰结果：D20(${outcome.die})${outcome.mod >= 0 ? `+${outcome.mod}` : outcome.mod} = ${outcome.total} vs DC${outcome.dc} → ${outcome.success ? "成功" : "失败"}。请严格按这个真随机结果书写剧情后果，不要擅自更改点数。`;
          } else {
            ok = false;
            output = "roll 参数解析失败：label 必须为非空字符串，mod/dc 必须为数字。请重新构造调用。";
          }
        } else {
          const exec = await this.registry.run(name, args);
          ok = exec.ok;
          output = exec.output;
        }
        tools.push({ name, args, output, ok });
        messages.push({ role: "tool", tool_call_id: tc.id, content: output });
      }
    }

    // 达到上限：把最后一次调用已缓冲的正文剥净后外发（部分正文总比空白好），供诊断
    const cleanLast = stripInlineThinking(lastContent);
    for (const d of [cleanLast]) if (d) opts.onNarrativeDelta?.(d);
    return {
      content: cleanLast,
      reasoning,
      tools,
      decisions,
      added: messages.slice(history.length),
      modelCalls,
      usageTotal,
      lastFinishReason,
      stoppedBy: "max-turns",
    };
  }
}
