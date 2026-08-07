/**
 * 上下文工程演示：小预算强制触发"压缩 → 归档"，验证：
 *  1. 早期回合被旁侧模型压进前情提要，窗口保持预算内；
 *  2. 原文按 JSONL 归档到 archive.jsonl，可检索召回；
 *  3. 模型每轮看到的正文只保留近期原文 + 摘要。
 *
 * 用法：node scripts/context-demo.ts
 */
process.env.WANGDACHUI_CONTEXT_BUDGET_CHARS = "1500"; // 调小预算，强制触发压缩

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import { LlmClient } from "../src/llm/client.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerBuiltinTools } from "../src/tools/builtin.ts";
import { Harness } from "../src/harness/harness.ts";
import { ContextManager, estimateChars, charsToTokens } from "../src/harness/context.ts";
import { parseCard } from "../src/roleplay/character-card.ts";
import { activateLore } from "../src/roleplay/lorebook.ts";
import { buildSystemPrompt } from "../src/roleplay/assemble.ts";

const root = process.cwd();
const cfg = loadConfig();
if (!cfg.apiKey) {
  console.error("缺少 WANGDACHUI_API_KEY：请检查 .env 文件");
  process.exit(1);
}

// system prompt：角色卡 + 激活世界书 + 空账本快照
const card = parseCard(JSON.parse(readFileSync(resolve(root, "assets/cards/xiuxian.json"), "utf8")))!;
const lore = activateLore(card.characterBook ?? [], "便利店 王总 妖狐 玉佩");
const systemText = buildSystemPrompt({ card, lore, extraRules: "回应不超过 120 字。" });

console.log(`【上下文预算】${cfg.contextBudgetChars} 字符 ≈ ${charsToTokens(cfg.contextBudgetChars)} token`);
console.log(`【system 长度】${systemText.length} 字符`);

const client = new LlmClient(cfg);
const registry = new ToolRegistry({ stateDir: cfg.stateDir });
registerBuiltinTools(registry, { stateDir: cfg.stateDir });
const harness = new Harness(client, registry, cfg);
const ctx = new ContextManager(client, cfg);

const plot = [
  "我深夜加班到十一点，刚被王总叫去办公室骂了一顿，说我绩效垫底、再不努力就滚蛋。回出租屋的路上，我在垃圾堆旁边捡到一枚温润的玉佩，里面传来一个苍老的声音：小子，你印堂发黑，但灵根居然不错——捡到本座，算你走了八辈子运。",
  "第二天上班，公司楼下新开了一家灵气便利店，24 小时亮着幽蓝的灯。老板娘是个看不清脸的女人，递给我一杯符水美式，说：加班的人，喝这个，续命。玄一在我识海里冷笑：这妖气，比你的工资还浓。",
  "夜里我加班到崩溃，玉佩忽然发热。玄一说：外面那只妖狐蹲你窗台半天了，再不走本座就替你收了她。我拉开窗，一只雪白的狐狸叼着一份外卖盒蹲在窗沿，盒子上印着妖狐同城，下面还有一行小字：新用户首单免配送费，支持功德点支付。",
];

for (let i = 0; i < plot.length; i++) {
  const input = plot[i] ?? "";
  console.log(`\n──────── 回合 ${i + 1} ────────`);
  const visible = ctx.visibleMessages(systemText, input);
  const before = estimateChars(visible);
  console.log(`可见上下文 ${before} 字符（${charsToTokens(before)} token），窗口内回合 ${ctx.windowSize}`);
  const result = await harness.runTurn(visible, { onNarrativeDelta: (d) => process.stdout.write(d) });
  console.log();
  const prune = await ctx.endTurn({ systemText, userInput: input, added: result.added });
  const after = ctx.visibleChars(systemText);
  console.log(
    `压缩 ${prune.compressedTurns} 个旧回合，归档 ${prune.archivedChars} 字符 | 压缩后可见 ${after} 字符 | 窗口 ${ctx.windowSize}/${ctx.totalTurns}`,
  );
  if (ctx.summaryText) console.log(`前情提要（${ctx.summaryText.length} 字符）：${ctx.summaryText.slice(0, 100)}...`);
}

console.log("\n════════ 最终前情提要 ════════");
console.log(ctx.summaryText || "（无——窗口未溢出）");

console.log("\n════════ 归档检索：关键词「妖狐」 ════════");
const hits = ctx.archiveSearch("妖狐");
if (!hits.length) console.log("（无命中）");
for (const h of hits) console.log(`[${h.id}] ${h.userInput.slice(0, 60)}...`);

console.log("\n════════ 完整性校验 ════════");
const checks: [string, boolean][] = [
  ["前情提要保留专有名词", /王总|老板娘|妖狐|符水/.test(ctx.summaryText)],
  ["档案可检索到妖狐线索", hits.length > 0],
  ["窗口未超预算(80%)", ctx.visibleChars(systemText) <= Math.floor(cfg.contextBudgetChars * 0.8)],
];
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed++;
}
console.log(failed ? `\n${failed} 项未通过` : "\n全部通过 ✓");
