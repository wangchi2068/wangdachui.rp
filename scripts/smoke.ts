/**
 * CLI 冒烟测试：验证配置加载 + LLM 客户端单轮对话。
 * 用法：node scripts/smoke.ts "你的问题"
 */
import { loadConfig } from "../src/config.ts";
import { LlmClient } from "../src/llm/client.ts";

const prompt = process.argv.slice(2).join(" ") || "用一句话介绍你自己";

const cfg = loadConfig();
if (!cfg.apiKey) {
  console.error("缺少 WANGDACHUI_API_KEY：请检查 .env 文件");
  process.exit(1);
}

const client = new LlmClient(cfg);
const result = await client.chat([{ role: "user", content: prompt }], { temperature: 0.7 });

console.log("【模型】", cfg.model);
console.log("【回复】", result.content);
if (result.reasoning) console.log("【思维链(内部, 不展示)】", result.reasoning.slice(0, 100), "...");
if (result.usage) console.log("【用量】prompt:", result.usage.prompt, "completion:", result.usage.completion);
