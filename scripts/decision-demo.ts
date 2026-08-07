/**
 * 决策卡演示：模型在重大剧情转折时调用 decide 工具，harness 暂停循环，
 * 把卡片交给用户（CLI 用 readline 交互），选择注入后继续剧情，卡片留痕。
 *
 * 用法：
 *   交互式：node scripts/decision-demo.ts
 *   自动选第 2 项：node scripts/decision-demo.ts --choice 2
 */
import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import { LlmClient } from "../src/llm/client.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerBuiltinTools } from "../src/tools/builtin.ts";
import { registerDecisionTool, type DecisionCard } from "../src/harness/decision-card.ts";
import { Harness } from "../src/harness/harness.ts";
import { parseCard } from "../src/roleplay/character-card.ts";
import { activateLore } from "../src/roleplay/lorebook.ts";
import { buildSystemPrompt } from "../src/roleplay/assemble.ts";

const choiceOverride = (() => {
  const i = process.argv.indexOf("--choice");
  return i >= 0 ? Number(process.argv[i + 1]) : null;
})();

const cfg = loadConfig();
if (!cfg.apiKey) {
  console.error("缺少 LIYUAN_API_KEY：请检查 .env 文件");
  process.exit(1);
}

const card = parseCard(JSON.parse(readFileSync(resolve(process.cwd(), "assets/cards/libai.json"), "utf8")))!;
const lore = activateLore(card.characterBook ?? [], "魔教 雾岭 月儿");
const systemText = buildSystemPrompt({
  card,
  lore,
  extraRules: "当剧情出现重大转折、需要用户拍板时，用 decide 工具把候选方向做成卡片询问用户；不要滥用。",
});

const client = new LlmClient(cfg);
const registry = new ToolRegistry({ stateDir: cfg.stateDir });
registerBuiltinTools(registry, { stateDir: cfg.stateDir });
registerDecisionTool(registry);
const harness = new Harness(client, registry, cfg);

/** CLI 决策卡交互：打印卡片 → 读取用户选择（编号或自由输入） */
async function askUser(card: DecisionCard): Promise<string> {
  console.log("\n┌─ ✦ 决策卡 ─────────────────────────");
  console.log(`│ 问题：${card.question}`);
  if (card.reason) console.log(`│ 原因：${card.reason}`);
  card.options.forEach((o, i) => console.log(`│   ${i + 1}. ${o}`));
  if (card.allowFreeInput) console.log("│   0. 自己写走向");
  console.log("└────────────────────────────────────");
  if (choiceOverride !== null) {
    const pick = choiceOverride;
    if (pick === 0) return "（自由输入）向雾岭进发，但沿途留下记号，以防不测";
    return `${card.options[pick - 1] ?? card.options[0]}`;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question("你的选择（输入编号或直接写走向）：")).trim();
  rl.close();
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= card.options.length) return card.options[n - 1];
  return answer || card.options[0];
}

const userInput =
  "我们站在岔路口：左路平坦，通往长安；右路荆棘丛生，通向雾岭——魔教圣女月儿就在那里。李白，直觉告诉我，你这次入蜀，就是为了找她。这趟去了，可能就回不了头了。你，怎么选？";

console.log("【用户】", userInput);
console.log("【可用工具】", registry.names().join(", "));

const result = await harness.runTurn(
  [{ role: "system", content: systemText }, { role: "user", content: userInput }],
  { onDecisionRequested: askUser, onNarrativeDelta: (d) => process.stdout.write(d) },
);

console.log("\n\n【决策记录】");
for (const d of result.decisions) console.log(`  Q: ${d.question}\n  → 用户选择: ${d.choice}`);
console.log(`模型调用 ${result.modelCalls} 次 | 结束 ${result.stoppedBy}`);

// 展示留痕
const decisionsPath = resolve(cfg.stateDir, "decisions.jsonl");
if (existsSync(decisionsPath)) {
  console.log("【decisions.jsonl 留痕】");
  console.log(readFileSync(decisionsPath, "utf8").trim());
}
