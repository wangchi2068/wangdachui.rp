import type {
	ChatMessage,
	ChatOptions,
	ChatResult,
} from "../../src/llm/client.ts";
import type { Fact } from "./scenarios.ts";

/**
 * Mock LLM 客户端（评测管线验证用，不消耗 token）。
 *
 * 行为契约（与 runner 配合）：
 *  - 剧情轮次：回显本轮 user 输入中出现的全部 fact keyword（模拟"模型叙述中提到事实"）；
 *  - 压缩请求：识别「剧情摘要员」system → 原样返回新剧情正文（不压缩，保证摘要长度达标）；
 *  - 探询请求：回显评测集全部 fact keyword（100% 命中，验证的是评测管线本身而非模型）。
 *
 * mock 数字仅供 CI/流程验证，不代表真实模型水平——真实数字用 --live 模式跑。
 */
export class MockLlmClient {
	private facts: Fact[] = [];

	constructor(facts: Fact[] = []) {
		this.facts = facts;
	}

	/** 每场景探询前注入事实集（mock 回显用） */
	setFacts(facts: Fact[]): void {
		this.facts = facts;
	}

	async chat(
		messages: ChatMessage[],
		_opts?: ChatOptions,
	): Promise<ChatResult> {
		const sys = messages[0]?.content ?? "";
		const last = messages[messages.length - 1];
		const text = last?.content ?? "";
		let content: string;

		if (sys.includes("剧情摘要员")) {
			// 压缩：直接透传新剧情正文，长度必然达标（runner 只验证流程不验证压缩效果）
			content = text.includes("【新剧情·正文】")
				? (text.split("【新剧情·正文】")[1] ?? text)
				: text;
		} else if (isProbe(text)) {
			// 探询：回显所有 fact keyword
			content = `回顾：${this.facts.map((f) => f.keyword).join("、")}。`;
		} else {
			// 剧情轮次：回显本轮出现的 fact keyword
			const hit = this.facts
				.filter((f) => text.includes(f.keyword))
				.map((f) => f.keyword);
			content = hit.length
				? `（剧情推进：涉及 ${hit.join("、")}）`
				: "（剧情推进，无新事实）";
		}

		return {
			content,
			reasoning: "",
			toolCalls: [],
			finishReason: "stop",
			usage: { prompt: 10, completion: 10, total: 20 },
		};
	}

	async stream(
		messages: ChatMessage[],
		opts?: ChatOptions & { onDelta?: (d: string) => void },
	): Promise<ChatResult> {
		const res = await this.chat(messages, opts);
		opts?.onDelta?.(res.content);
		return res;
	}
}

/** 探询句式判定：长文本且以问号结尾（剧情轮次为陈述句，不误判） */
function isProbe(text: string): boolean {
	return text.trim().length >= 12 && /[？?]$/.test(text.trim());
}
