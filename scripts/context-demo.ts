/**
 * 上下文工程演示：小预算强制触发"压缩 → 归档"，验证：
 *  1. 早期回合被旁侧模型压进前情提要，窗口保持预算内；
 *  2. 原文按 JSONL 归档到 archive.jsonl，可检索召回；
 *  3. 模型每轮看到的正文只保留近期原文 + 摘要。
 *
 * 用法：node scripts/context-demo.ts
 */
process.env.LIYUAN_CONTEXT_BUDGET_CHARS = "1500"; // 调小预算，强制触发压缩

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
  console.error("缺少 LIYUAN_API_KEY：请检查 .env 文件");
  process.exit(1);
}

// system prompt：角色卡 + 激活世界书 + 空账本快照
const card = parseCard(JSON.parse(readFileSync(resolve(root, "assets/cards/libai.json"), "utf8")))!;
const lore = activateLore(card.characterBook ?? [], "蜀道 青莲剑 魔教 雾岭");
const systemText = buildSystemPrompt({ card, lore, extraRules: "回应不超过 120 字。" });

console.log(`【上下文预算】${cfg.contextBudgetChars} 字符 ≈ ${charsToTokens(cfg.contextBudgetChars)} token`);
console.log(`【system 长度】${systemText.length} 字符`);

const client = new LlmClient(cfg);
const registry = new ToolRegistry({ stateDir: cfg.stateDir });
registerBuiltinTools(registry, { stateDir: cfg.stateDir });
const harness = new Harness(client, registry, cfg);
const ctx = new ContextManager(client, cfg);

const plot = [
  "我们沿蜀道而行，迎面撞上山贼头目赵铁柱带人拦路。李白拔剑，三招将他的刀震飞。赵铁柱跪地求饶，说魔教在雾岭深处有一条密道，直通长安皇城。",
  "夜宿山脚客栈，掌柜王婆偷偷塞给你一张纸条，上面写着：雾岭密道入口在一棵千年老槐树下。李白抚着青莲剑说，这剑靠近雾岭时微微发热，像是认得那条路。",
  "次日你们找到那棵老槐树，树下果然有块活动的青石板。掀开一看，一条幽深的石阶通向地下，壁上刻着莲花纹——与青莲剑上的纹路一模一样。",
];

for (let i = 0; i < plot.length; i++) {
  console.log(`\n──────── 回合 ${i + 1} ────────`);
  const visible = ctx.visibleMessages(systemText, plot[i]);
  const before = estimateChars(visible);
  console.log(`可见上下文 ${before} 字符（${charsToTokens(before)} token），窗口内回合 ${ctx.windowSize}`);
  const result = await harness.runTurn(visible, { onNarrativeDelta: (d) => process.stdout.write(d) });
  console.log();
  const prune = await ctx.endTurn({ systemText, userInput: plot[i], added: result.added });
  const after = ctx.visibleChars(systemText);
  console.log(
    `压缩 ${prune.compressedTurns} 个旧回合，归档 ${prune.archivedChars} 字符 | 压缩后可见 ${after} 字符 | 窗口 ${ctx.windowSize}/${ctx.totalTurns}`,
  );
  if (ctx.summaryText) console.log(`前情提要（${ctx.summaryText.length} 字符）：${ctx.summaryText.slice(0, 100)}...`);
}

console.log("\n════════ 最终前情提要 ════════");
console.log(ctx.summaryText || "（无——窗口未溢出）");

console.log("\n════════ 归档检索：关键词「密道」 ════════");
const hits = ctx.archiveSearch("密道");
if (!hits.length) console.log("（无命中）");
for (const h of hits) console.log(`[${h.id}] ${h.userInput.slice(0, 60)}...`);

console.log("\n════════ 完整性校验 ════════");
const checks: [string, boolean][] = [
  ["前情提要保留专有名词", /赵铁柱|王婆|青莲剑/.test(ctx.summaryText)],
  ["档案可检索到密道线索", hits.length > 0],
  ["窗口未超预算(80%)", ctx.visibleChars(systemText) <= Math.floor(cfg.contextBudgetChars * 0.8)],
];
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed++;
}
console.log(failed ? `\n${failed} 项未通过` : "\n全部通过 ✓");
