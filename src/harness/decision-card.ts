import { openStore } from "../store.ts";
import type { ToolRegistry } from "../tools/registry.ts";

export interface DecisionCard {
	question: string;
	reason?: string;
	options: string[];
	allowFreeInput: boolean;
}

export interface DecisionRecord extends DecisionCard {
	at: string;
	/** 用户的最终选择（选项之一或自由输入） */
	choice: string;
}

export const DECIDE_TOOL_NAME = "decide";

const DECIDE_TOOL_SCHEMA = {
	description:
		"遇到影响剧情走向的关键决策时调用：把候选方向做成卡片询问用户。只在重大转折使用（关键选择、关系质变、难以回头的事），不要滥用。",
	parameters: {
		type: "object",
		properties: {
			question: { type: "string", description: "需要用户拍板的问题（一句话）" },
			reason: { type: "string", description: "为什么这是难回头的决策（可选）" },
			options: {
				type: "array",
				items: { type: "string" },
				description: "2-4 个候选方向，每个是具体可行的剧情走向",
			},
			allow_free_input: {
				type: "boolean",
				description: "是否允许用户自由输入自定义走向，默认 true",
			},
		},
		required: ["question", "options"],
		additionalProperties: false,
	},
} as const;

/** 注册 decide 工具：真正的交互由 harness 拦截处理，这里只占位保证模型能看到工具 */
export function registerDecisionTool(registry: ToolRegistry): void {
	registry.register({
		name: DECIDE_TOOL_NAME,
		description: DECIDE_TOOL_SCHEMA.description,
		parameters: DECIDE_TOOL_SCHEMA.parameters,
		execute: async () => "decide 由 harness 交互处理，此结果不应出现",
	});
}

/** 解析模型传入的卡片参数；参数不合法返回 null（harness 会回填错误让模型修正） */
export function parseDecisionCard(argsJson: string): DecisionCard | null {
	try {
		const a = JSON.parse(argsJson || "{}") as Record<string, unknown>;
		if (typeof a.question !== "string" || !a.question.trim()) return null;
		if (
			!Array.isArray(a.options) ||
			a.options.length === 0 ||
			a.options.some((o) => typeof o !== "string")
		)
			return null;
		return {
			question: a.question,
			reason: typeof a.reason === "string" ? a.reason : undefined,
			options: a.options as string[],
			allowFreeInput: a.allow_free_input !== false,
		};
	} catch {
		return null;
	}
}

/** 决策留痕：state.db 的 decisions 追加行，日后可回看每个岔路口 */
export function recordDecision(
	stateDir: string,
	card: DecisionCard,
	choice: string,
): void {
	const record: DecisionRecord = {
		...card,
		at: new Date().toISOString(),
		choice,
	};
	const store = openStore(stateDir);
	try {
		store.append("decisions", JSON.stringify(record));
	} finally {
		store.close();
	}
}
