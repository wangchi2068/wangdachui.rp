import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ChatResult, LlmClient } from "../src/llm/client.ts";
import type { Config } from "../src/config.ts";
import { ContextManager, estimateChars } from "../src/harness/context.ts";

/** 假 LLM：chat 用于摘要压缩，stream 用于主循环（这里只测上下文管理，用 chat） */
function makeMockClient(
	scriptedSummaries: string[],
): LlmClient & { calls: number } {
	let calls = 0;
	const fake = {
		calls: 0,
		async chat(): Promise<ChatResult> {
			calls++;
			fake.calls = calls;
			const content =
				scriptedSummaries[Math.min(calls - 1, scriptedSummaries.length - 1)] ??
				"";
			return { content, reasoning: "", toolCalls: [], finishReason: "stop" };
		},
		async stream(): Promise<ChatResult> {
			return {
				content: "",
				reasoning: "",
				toolCalls: [],
				finishReason: "stop",
			};
		},
	} as unknown as LlmClient & { calls: number };
	return fake;
}

function makeConfig(dir: string, budget: number, maxTurns = 5): Config {
	return {
		apiBase: "http://mock",
		apiKey: "test",
		model: "mock",
		contextBudgetChars: budget,
		maxLoopTurns: maxTurns,
		stateDir: dir,
		autoSnapshotEvery: 0,
		maxTokensPerDay: 0,
	};
}

function turn(
	user: string,
	narrative: string,
): { userInput: string; added: ChatMessage[] } {
	return {
		userInput: user,
		added: [{ role: "assistant", content: narrative }],
	};
}

/** 生成长文本：确保超出小预算触发压缩 */
function longText(seed: string, n = 260): string {
	return (seed + "。").repeat(Math.ceil(n / (seed.length + 1))).slice(0, n);
}

test("上下文：组装顺序 = system → 前情提要 → 窗口 → 用户输入", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rph-ctx-"));
	const ctx = new ContextManager(
		makeMockClient(["旧摘要"]),
		makeConfig(dir, 100_000),
	);
	try {
		await ctx.endTurn({
			systemText: "SYS",
			...turn("第一回合用户", "第一回合正文"),
		});
		const visible = ctx.visibleMessages("SYS", "第二回合用户");
		assert.equal(visible[0]!.role, "system");
		assert.equal(visible[0]!.content, "SYS");
		assert.equal(visible[1]!.content!.includes("第二回合用户"), false); // 尚未有摘要
		// 2 个 user（历史 + 当前）+ 1 个 assistant
		const roles = visible.map((m) => m.role);
		assert.deepEqual(roles, ["system", "user", "assistant", "user"]);
		assert.equal(visible[3]!.content, "第二回合用户");
	} finally {
		ctx.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("上下文：预算超限时压缩最旧回合，原文进归档", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rph-ctx-"));
	const client = makeMockClient(["压缩后的剧情摘要内容，包含王总与妖狐的伏笔"]);
	const ctx = new ContextManager(client, makeConfig(dir, 200));
	try {
		const t1 = turn("深夜加班被王总骂", longText("正文一的内容"));
		const prune = await ctx.endTurn({ systemText: "SYS", ...t1 });
		assert.equal(prune.compressedTurns, 1);
		assert.ok(ctx.summaryText.includes("王总"));
		assert.equal(ctx.windowSize, 0); // 该回合已滑出窗口
		assert.equal(ctx.totalTurns, 1);
		// 归档里有原文（经 store 可检索）
		const hits = ctx.archiveSearch("深夜加班被王总骂");
		assert.equal(hits.length, 1);
	} finally {
		ctx.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("上下文：摘要异常（过短）时保留旧摘要降级", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rph-ctx-"));
	const client = makeMockClient([
		"好的完整摘要第一版，包含王总与便利店老板娘的信息",
		"短",
	]);
	const ctx = new ContextManager(client, makeConfig(dir, 120));
	try {
		await ctx.endTurn({
			systemText: "SYS",
			...turn("剧情一", longText("正文一内容，需要被压缩成摘要以便后续合并")),
		});
		const first = ctx.summaryText;
		await ctx.endTurn({
			systemText: "SYS",
			...turn("剧情二", longText("正文二内容，同样要被压缩")),
		});
		assert.equal(ctx.summaryText, first); // 第二次压缩输出过短，保留旧摘要
	} finally {
		ctx.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("上下文：archiveSearch 可检索被压缩的原文", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rph-ctx-"));
	const ctx = new ContextManager(
		makeMockClient(["摘要摘要"]),
		makeConfig(dir, 200),
	);
	try {
		await ctx.endTurn({
			systemText: "SYS",
			...turn("我在便利店见到了妖狐老板娘", longText("正文……")),
		});
		const hits = ctx.archiveSearch("妖狐");
		assert.equal(hits.length, 1);
		assert.ok(hits[0]!.userInput.includes("妖狐"));
	} finally {
		ctx.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("上下文：estimateChars 与 charsToTokens", () => {
	assert.equal(estimateChars([{ role: "user", content: "12345" }]), 5);
});
