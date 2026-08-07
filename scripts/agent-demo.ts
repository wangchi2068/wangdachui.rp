/**
 * Agent 循环演示：验证 思考→工具→验证→再思考 闭环。
 * 用法：node scripts/agent-demo.ts "你的指令"
 * 默认指令会迫使模型依次调用 ledger_read / ledger_write 再回复，方便看到工具轨迹。
 */
import { loadConfig } from "../src/config.ts";
import { LlmClient } from "../src/llm/client.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerBuiltinTools } from "../src/tools/builtin.ts";
import { Harness } from "../src/harness/harness.ts";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const userInput = process.argv.slice(2).join(" ") || "请先读取世界状态账本，然后把一条'好感度+5'写入账本，最后用一句话汇报结果。";

const cfg = loadConfig();
if (!cfg.apiKey) {
  console.error("缺少 LIYUAN_API_KEY：请检查 .env 文件");
  process.exit(1);
}

const client = new LlmClient(cfg);
const registry = new ToolRegistry({ stateDir: cfg.stateDir });
registerBuiltinTools(registry, { stateDir: cfg.stateDir });
const harness = new Harness(client, registry, cfg);

console.log("【用户】", userInput);
console.log("【可用工具】", registry.names().join(", "));
console.log("--- 剧情流式输出 ---");

let narrative = "";
console.error("〔调试〕开始 agent 循环...");
const t0 = Date.now();
const result = await harness.runTurn([{ role: "user", content: userInput }], {
  onNarrativeDelta: (d) => {
    narrative += d;
    process.stdout.write(d);
  },
});
console.error(`〔调试〕循环结束，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("\n--- 工具轨迹 ---");
if (!result.tools.length) console.log("（本轮没有调用工具）");
for (const t of result.tools) {
  console.log(`  [${t.ok ? "OK" : "ERR"}] ${t.name}(${t.args.slice(0, 120)}) → ${t.output.slice(0, 120)}`);
}
console.log("--- 统计 ---");
console.log(`模型调用 ${result.modelCalls} 次 | 结束原因 ${result.stoppedBy} | 正文 ${narrative.length} 字符`);

// 展示账本落盘结果
const ledgerPath = resolve(cfg.stateDir, "ledger.json");
if (existsSync(ledgerPath)) {
  console.log("--- 账本文件 ---");
  console.log(readFileSync(ledgerPath, "utf8"));
}
