/**
 * 角色卡 + 世界书演示（纯本地，不调 API）：
 * 1. 解析 SillyTavern v2 角色卡（含内嵌世界书）；
 * 2. 用关键词激活世界书条目（匹配/不匹配两种上下文对比）；
 * 3. 组装完整 system prompt 并打印。
 *
 * 用法：node scripts/card-demo.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCard } from "../src/roleplay/character-card.ts";
import { parseLorebook, activateLore, buildLoreText } from "../src/roleplay/lorebook.ts";
import { buildSystemPrompt } from "../src/roleplay/assemble.ts";

const root = process.cwd();
const cardJson = JSON.parse(readFileSync(resolve(root, "assets/cards/libai.json"), "utf8"));
const card = parseCard(cardJson);
if (!card) {
  console.error("角色卡解析失败");
  process.exit(1);
}
console.log("【角色卡解析】");
console.log(`  name: ${card.name} | 标签: ${card.tags?.join(", ")} | 内嵌世界书: ${card.characterBook?.length ?? 0} 条`);
console.log(`  first_mes: ${card.firstMes.slice(0, 50)}...`);
console.log(`  mes_example: ${card.mesExample.split("<START>").length - 1} 段示例`);

// 独立世界书
const loreJson = JSON.parse(readFileSync(resolve(root, "assets/lorebooks/jianghu.json"), "utf8"));
const loreEntries = parseLorebook(loreJson);
console.log(`\n【独立世界书】${loreEntries.length} 条`);

// 关键词激活对比
const ctxMatch = "我拔出了青莲剑，回身望向蜀道尽头的雾岭，那圣女月儿的身影又出现了。";
const ctxNoMatch = "今天天气不错，我们去喝碗豆花吧。";
const active = activateLore([...(card.characterBook ?? []), ...loreEntries], ctxMatch);
const activeNone = activateLore([...(card.characterBook ?? []), ...loreEntries], ctxNoMatch);
console.log("\n【关键词激活】");
console.log(`  上下文含"青莲剑/蜀道/雾岭/月儿" → 激活 ${active.length} 条`);
for (const e of active) console.log(`   - ${e.constant ? "(常驻) " : ""}${e.content.slice(0, 40)}...`);
console.log(`  无关上下文 → 激活 ${activeNone.length} 条（应只有常驻）`);

// 组装 system prompt
const system = buildSystemPrompt({
  card,
  lore: active,
  ledgerSnapshot: "- [人物] 小林（打工人，刚觉醒灵根）\n- [人物] 玄一（剑仙残魂，寄居古玉）\n- [伏笔] 便利店老板娘身上有妖气，与王总同源",
  extraRules: "回应不超过 200 字。",
});
console.log("\n【组装后的 system prompt】");
console.log("=".repeat(60));
console.log(system);
console.log("=".repeat(60));

// 校验断言
const checks: [string, boolean][] = [
  ["包含角色名", system.includes("玄一")],
  ["包含人物设定", system.includes("【人物设定】")],
  ["包含世界书常驻", active.some((e) => e.constant)],
  ["关键词激活了便利店设定", active.some((e) => e.content.includes("便利店"))],
  ["无关上下文不激活关键词条目", activeNone.every((e) => e.constant)],
];
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed++;
}
console.log(failed ? `\n${failed} 项未通过` : "\n全部通过 ✓");
