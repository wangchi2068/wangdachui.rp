/**
 * 记忆账本演示：旁侧模型自动记账 + 账本快照注入。
 *
 * 流程：
 *  第 1 轮：用户输入一段有信息量的剧情 → harness 生成正文 → 旁侧模型记账 → 展示账本；
 *  第 2 轮：新输入 → 组装 system（角色设定 + 账本快照注入）→ 生成正文 → 再记账 → 展示合并后的账本。
 *
 * 用法：node scripts/ledger-demo.ts
 */
import { loadConfig } from "../src/config.ts";
import { LlmClient, type ChatMessage } from "../src/llm/client.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerBuiltinTools } from "../src/tools/builtin.ts";
import { Harness } from "../src/harness/harness.ts";
import { LedgerService, snapshotText } from "../src/harness/memory-ledger.ts";

const CHARACTER_NAME = "李白";
const CHARACTER_SYSTEM = `你是「${CHARACTER_NAME}」，大唐剑客，诗酒风流，手持青莲剑。
你正与一位朋友（用户）在江湖中同行。用第一人称扮演，保持角色性格，回应不超过 200 字。`;

const cfg = loadConfig();
if (!cfg.apiKey) {
  console.error("缺少 LIYUAN_API_KEY：请检查 .env 文件");
  process.exit(1);
}

const client = new LlmClient(cfg);
const registry = new ToolRegistry({ stateDir: cfg.stateDir });
registerBuiltinTools(registry, { stateDir: cfg.stateDir });
const harness = new Harness(client, registry, cfg);
const ledger = new LedgerService(client, cfg.stateDir);

/** 组装一回合的完整消息：system(角色 + 账本快照) + 历史 + 用户输入 */
function assemble(history: ChatMessage[], userInput: string): ChatMessage[] {
  const system = `${CHARACTER_SYSTEM}\n\n【当前世界状态（账本快照）】\n${snapshotText(ledger.load())}`;
  return [{ role: "system", content: system }, ...history, { role: "user", content: userInput }];
}

async function playTurn(history: ChatMessage[], userInput: string): Promise<ChatMessage[]> {
  console.log(`\n══════ 用户：${userInput}`);
  const messages = assemble(history, userInput);
  const result = await harness.runTurn(messages, {
    onNarrativeDelta: (d) => process.stdout.write(d),
  });
  console.log();
  if (result.stoppedBy === "max-turns") console.warn("〔警告〕本轮达到循环上限");

  const update = await ledger.updateAfterTurn({
    characterName: CHARACTER_NAME,
    userInput,
    narrative: result.content,
  });
  console.log(
    update.ok
      ? `〔记账〕旁侧模型已更新账本（新增/更新 ${update.touched ?? 0} 条）`
      : `〔记账〕跳过：${update.error}`,
  );
  return result.added;
}

// 第 1 轮：建立人物、物品、关系
let history: ChatMessage[] = [];
history.push(...(await playTurn(history, "我是你的朋友小舟。今天你我在蜀道遇见魔教圣女月儿，你与她交手三回合后收剑，她对你露出莫名的微笑，说'后会无期'便隐入雾中。你似乎对她生出了兴趣。")));

// 展示第 1 轮后的账本
console.log("\n──────────────── 第 1 轮后的账本 ────────────────");
console.log(JSON.stringify(ledger.load(), null, 2).slice(0, 900));

// 第 2 轮：新增物品 + 关系发展，验证合并与去重
history.push(...(await playTurn(history, "第二天清晨，我在你枕边发现一朵带露的紫色花，花瓣上有月儿的气息。你拿起它端详良久，说：'是她。'然后小心地收进了衣襟。")));

console.log("\n──────────────── 第 2 轮后的账本（合并去重后） ────────────────");
console.log(JSON.stringify(ledger.load(), null, 2).slice(0, 1200));

console.log("\n──────────────── 下轮将注入的账本快照 ────────────────");
console.log(snapshotText(ledger.load()));
