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

export interface ToolExecution {
  name: string;
  args: string;
  output: string;
  ok: boolean;
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
  stoppedBy: "done" | "max-turns";
}

export interface HarnessOptions {
  /** 正文流式回调（最终剧情增量实时给 UI） */
  onNarrativeDelta?: (delta: string) => void;
  /** 决策卡回调：模型调用 decide 时暂停循环，把卡片交给调用方（CLI/Web），返回用户的选择 */
  onDecisionRequested?: (card: DecisionCard) => Promise<string>;
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
    const toolDefs = opts.tools ?? this.registry.defs();
    const temperature = opts.temperature ?? 0.8;

    for (let i = 0; i < this.cfg.maxLoopTurns; i++) {
      modelCalls++;
      // 本轮的正文增量先缓冲：只有确定是最终剧情时才流式外发
      const callBuffer: string[] = [];
      const result = await this.client.stream(messages, {
        tools: toolDefs,
        temperature,
        onDelta: (d) => callBuffer.push(d),
      });
      reasoning += result.reasoning;

      const assistantMsg: ChatMessage = { role: "assistant", content: result.content || null };
      if (result.toolCalls.length) assistantMsg.tool_calls = result.toolCalls;
      messages.push(assistantMsg);

      if (!result.toolCalls.length) {
        // 自然结束：这是用户看到的正文
        for (const d of callBuffer) opts.onNarrativeDelta?.(d);
        return {
          content: result.content,
          reasoning,
          tools,
          decisions,
          added: messages.slice(history.length),
          modelCalls,
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
            recordDecision(this.cfg.stateDir, card, choice);
            decisions.push({ ...card, at: new Date().toISOString(), choice });
            output = `用户已选择：${choice}。请严格按用户的这个选择继续剧情，不要推翻用户的决定。`;
          } else {
            ok = false;
            output = "decide 参数解析失败：question 必须为非空字符串，options 必须为非空字符串数组。请重新构造调用。";
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

    // 达到上限：放弃本轮正文，保留工具轨迹供诊断
    return {
      content: "",
      reasoning,
      tools,
      decisions,
      added: messages.slice(history.length),
      modelCalls,
      stoppedBy: "max-turns",
    };
  }
}
