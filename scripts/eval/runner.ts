/**
 * 评测运行器（eval runner）。
 *
 * 用法：
 *   node scripts/eval/runner.ts                # mock 模式（不耗 token，CI 友好，验证管线）
 *   node scripts/eval/runner.ts --live         # 真实模型全量评测（耗 token）
 *   node scripts/eval/runner.ts --live --cases 4   # 真实模型，每类前 4 个场景
 *   node scripts/eval/runner.ts --only memory-3    # 只跑指定场景
 *
 * 指标：
 *  - 记忆保持率（memory）：小预算强制触发上下文压缩，探询压缩后的模型可见上下文，
 *    统计关键事实 keyword 命中比例（关键词级判定，保守口径）；
 *  - 压缩 token 节省（compression）：长剧情原文 vs 旁侧模型压缩摘要的字符/token 对比；
 *  - 延迟与成本：每轮/每次探询耗时与 usage token。
 *
 * 输出：stdout 汇总 + reports/EVALUATION.md 完整报告。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../../src/config.ts";
import { LlmClient } from "../../src/llm/client.ts";
import {
	ContextManager,
	charsToTokens,
	SUMMARY_SYSTEM,
} from "../../src/harness/context.ts";
import { MockLlmClient } from "./mock.ts";
import {
	allScenarios,
	type CompressionScenario,
	type MemoryScenario,
} from "./scenarios.ts";

interface Args {
	live: boolean;
	cases: number;
	/** 逗号分隔的场景 id 白名单（如 "memory-8,memory-9,compression-3"） */
	onlyIds?: string[];
}

function parseArgs(argv: string[]): Args {
	const args: Args = { live: false, cases: Infinity };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--live") args.live = true;
		else if (a === "--cases") {
			const n = Number(argv[i + 1]);
			if (Number.isFinite(n) && n > 0) args.cases = n;
			i++;
		} else if (a === "--only") {
			args.onlyIds = (argv[i + 1] ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			i++;
		}
	}
	return args;
}

/** 评测用短 system（剧情引擎提示词） */
const EVAL_SYSTEM = "你是剧情引擎，只陈述剧情中明确出现过的事实。";

interface MemoryReport {
	id: string;
	hits: number;
	total: number;
	summaryChars: number;
	compressedTurns: number;
	turnCount: number;
	turnsMs: number[];
	probeMs: number;
	probeUsage: number;
}

interface CompressionReport {
	id: string;
	rawChars: number;
	rawTokens: number;
	compChars: number;
	compTokens: number;
	savePct: number;
	keepHits: number;
	keepTotal: number;
	ms: number;
	usage: number;
}

async function evalMemory(
	sc: MemoryScenario,
	client: LlmClient | MockLlmClient,
	cfg: ReturnType<typeof loadConfig>,
	tmpDir: string,
): Promise<MemoryReport> {
	// 小预算（300 字符）强制多轮内触发压缩，测"压缩后记忆保持"
	const evalCfg = { ...cfg, contextBudgetChars: 300 };
	const ctx = new ContextManager(client as LlmClient, evalCfg, tmpDir);
	const turnsMs: number[] = [];

	for (const turn of sc.turns) {
		const t0 = performance.now();
		// 剧情正文 = 用户输入原样入档（确定性语料，压缩与探询对象一致）
		await ctx.endTurn({
			systemText: EVAL_SYSTEM,
			userInput: turn,
			added: [{ role: "assistant", content: turn }],
		});
		turnsMs.push(performance.now() - t0);
	}

	// 探询前把剩余超预算回合全部压进摘要（充分压缩口径）
	await ctx.drainCompression(EVAL_SYSTEM);

	const t1 = performance.now();
	const probeRes = await client.chat(
		ctx.visibleMessages(EVAL_SYSTEM, sc.probe),
		{
			temperature: 0.2,
			maxTokens: 600,
		},
	);
	const probeMs = performance.now() - t1;
	const hits = sc.facts.filter((f) =>
		probeRes.content.includes(f.keyword),
	).length;

	return {
		id: sc.id,
		hits,
		total: sc.facts.length,
		summaryChars: ctx.summaryText.length,
		compressedTurns: ctx.totalTurns - ctx.windowSize,
		turnCount: sc.turns.length,
		turnsMs,
		probeMs,
		probeUsage: probeRes.usage?.total ?? 0,
	};
}

async function evalCompression(
	sc: CompressionScenario,
	client: LlmClient | MockLlmClient,
	cfg: ReturnType<typeof loadConfig>,
): Promise<CompressionReport> {
	const rawChars = sc.narrative.length;
	const rawTokens = charsToTokens(rawChars);
	const t0 = performance.now();
	const res = await client.chat(
		[
			{ role: "system", content: SUMMARY_SYSTEM },
			{
				role: "user",
				content: `【已有前情提要】\n（无）\n\n【新剧情·用户】\n（评测场景）\n【新剧情·正文】\n${sc.narrative}\n\n请输出合并后的完整前情提要。`,
			},
		],
		{ temperature: 0.3, maxTokens: 900, model: cfg.compressModel },
	);
	const ms = performance.now() - t0;
	const comp = res.content.trim();
	const compChars = comp.length;
	const compTokens = charsToTokens(compChars);
	const keepHits = sc.mustKeep.filter((k) => comp.includes(k)).length;

	return {
		id: sc.id,
		rawChars,
		rawTokens,
		compChars,
		compTokens,
		savePct: rawTokens > 0 ? 1 - compTokens / rawTokens : 0,
		keepHits,
		keepTotal: sc.mustKeep.length,
		ms,
		usage: res.usage?.total ?? 0,
	};
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const cfg = loadConfig();
	if (args.live && !cfg.apiKey) {
		console.error("--live 需要 WANGDACHUI_API_KEY（检查 .env）");
		process.exit(1);
	}
	const client: LlmClient | MockLlmClient = args.live
		? new LlmClient(cfg)
		: new MockLlmClient();
	const scenarios = allScenarios();
	const memScenarios = args.onlyIds
		? scenarios.memory.filter((s) => args.onlyIds?.includes(s.id))
		: scenarios.memory.slice(0, args.cases);
	const compScenarios = args.onlyIds
		? scenarios.compression.filter((s) => args.onlyIds?.includes(s.id))
		: scenarios.compression.slice(0, args.cases);

	const mode = args.live
		? `live（模型 ${cfg.model}）`
		: "mock（不耗 token，仅验证管线）";
	console.log(`评测模式：${mode}\n`);

	// memory 评测
	const memReports: MemoryReport[] = [];
	for (const sc of memScenarios) {
		if (!args.live) (client as MockLlmClient).setFacts(sc.facts);
		const tmpDir = mkdtempSync(resolve(tmpdir(), "eval-memory-"));
		try {
			const rep = await evalMemory(sc, client, cfg, tmpDir);
			memReports.push(rep);
			console.log(
				`[memory] ${sc.id.padEnd(10)} ${rep.hits}/${rep.total} 事实保持 | 摘要 ${rep.summaryChars} 字符 | 压缩 ${rep.compressedTurns}/${rep.turnCount} 轮 | 探询 ${rep.probeMs.toFixed(0)}ms`,
			);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}

	// compression 评测
	const compReports: CompressionReport[] = [];
	for (const sc of compScenarios) {
		const rep = await evalCompression(sc, client, cfg);
		compReports.push(rep);
		console.log(
			`[compression] ${sc.id.padEnd(10)} ${rep.rawTokens}→${rep.compTokens} token（节省 ${pct(rep.savePct)}）| 关键点 ${rep.keepHits}/${rep.keepTotal} | ${rep.ms.toFixed(0)}ms`,
		);
	}

	// 汇总
	const memTotal = memReports.reduce((n, r) => n + r.total, 0);
	const memHits = memReports.reduce((n, r) => n + r.hits, 0);
	const memoryRate = memTotal > 0 ? memHits / memTotal : 0;
	const compTotal = compReports.reduce((n, r) => n + r.keepTotal, 0);
	const compKeep = compReports.reduce((n, r) => n + r.keepHits, 0);
	const avgSave = compReports.length
		? compReports.reduce((n, r) => n + r.savePct, 0) / compReports.length
		: 0;
	const avgProbeMs = memReports.length
		? memReports.reduce((n, r) => n + r.probeMs, 0) / memReports.length
		: 0;

	console.log("\n── 汇总 ──");
	console.log(
		`记忆保持率：${memHits}/${memTotal} = ${pct(memoryRate)}（${memReports.length} 个 memory 场景）`,
	);
	console.log(
		`压缩 token 节省：平均 ${pct(avgSave)}（${compReports.length} 个 compression 场景）`,
	);
	console.log(
		`压缩后关键点保持：${compKeep}/${compTotal} = ${pct(compTotal ? compKeep / compTotal : 0)}`,
	);
	console.log(`平均探询延迟：${avgProbeMs.toFixed(0)}ms`);

	// 写报告
	const lines: string[] = [
		`# 评测报告（Evaluation Report）`,
		``,
		`- 模式：${mode}`,
		`- 时间：${new Date().toISOString()}`,
		`- 指标口径：记忆保持 = 探询回复中命中事实 keyword 的比例（关键词级，保守）；压缩节省 = 1 - 压缩后 token / 原文 token（字符估算 chars/3）`,
		``,
		`## 记忆保持率（压缩后）`,
		``,
		`| 场景 | 保持 | 摘要字符 | 压缩轮数 | 总轮数 | 探询延迟 |`,
		`|---|---|---|---|---|---|`,
		...memReports.map(
			(r) =>
				`| ${r.id} | ${r.hits}/${r.total} | ${r.summaryChars} | ${r.compressedTurns} | ${r.turnCount} | ${r.probeMs.toFixed(0)}ms |`,
		),
		``,
		`**小计**：${memHits}/${memTotal} = **${pct(memoryRate)}**`,
		``,
		`## 压缩 token 节省`,
		``,
		`| 场景 | 原文 token | 压缩后 token | 节省 | 关键点保持 | 耗时 |`,
		`|---|---|---|---|---|---|`,
		...compReports.map(
			(r) =>
				`| ${r.id} | ${r.rawTokens} | ${r.compTokens} | ${pct(r.savePct)} | ${r.keepHits}/${r.keepTotal} | ${r.ms.toFixed(0)}ms |`,
		),
		``,
		`**平均节省**：**${pct(avgSave)}**（关键点保持 ${compKeep}/${compTotal} = ${pct(compTotal ? compKeep / compTotal : 0)}）`,
		``,
		`## 方法`,
		``,
		`- memory：小预算（500 字符）强制触发 ContextManager 压缩，探询前 drainCompression 全量压缩，模型只见「前情提要 + 窗口」；事实命中为关键词级判定，未计同义改写，属于保守估计。`,
		`- compression：旁侧模型（compressModel）压缩长剧情，字符估算 token（3 字符 ≈ 1 token）。`,
		`- mock 模式数字仅验证管线，不代表模型水平。`,
	];
	const outPath = resolve("reports/EVALUATION.md");
	mkdirSync(resolve("reports"), { recursive: true });
	writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
	console.log(`\n报告已写入 ${outPath}`);
}

await main();
