import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ChatResult, LlmClient, ToolCall } from "../src/llm/client.ts";
import type { Config } from "../src/config.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerDecisionTool, DECIDE_TOOL_NAME } from "../src/harness/decision-card.ts";
import { Harness } from "../src/harness/harness.ts";

function makeConfig(dir: string, maxTurns = 5): Config {
  return {
    apiBase: "http://mock",
    apiKey: "test",
    model: "mock",
    contextBudgetChars: 100_000,
    maxLoopTurns: maxTurns,
    stateDir: dir,
    autoSnapshotEvery: 0,
  };
}

/** 假 LLM：按脚本序列返回 tool_calls 或正文 */
function makeScriptedClient(script: Array<{ content?: string; toolCalls?: ToolCall[] }>): LlmClient {
  let i = 0;
  return {
    async stream(messages: ChatMessage[], opts?: { onDelta?: (d: string) => void }): Promise<ChatResult> {
      const step = script[Math.min(i++, script.length - 1)]!;
      if (step.content && opts?.onDelta) opts.onDelta(step.content);
      return {
        content: step.content ?? "",
        reasoning: "",
        toolCalls: step.toolCalls ?? [],
        finishReason: step.toolCalls?.length ? "tool_calls" : "stop",
      };
    },
    async chat(): Promise<ChatResult> {
      return { content: "", reasoning: "", toolCalls: [], finishReason: "stop" };
    },
  } as unknown as LlmClient;
}

function registryWith(dir: string): ToolRegistry {
  const registry = new ToolRegistry({ stateDir: dir });
  registry.register({
    name: "echo",
    description: "回显参数",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    execute: async (args) => `回显：${String(args.text ?? "")}`,
  });
  registerDecisionTool(registry);
  return registry;
}

test("agent 循环：工具调用 → 回填 → 再思考 → 自然结束", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rph-harness-"));
  try {
    const client = makeScriptedClient([
      { toolCalls: [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"text":"你好"}' } }] },
      { content: "最终正文" },
    ]);
    const harness = new Harness(client, registryWith(dir), makeConfig(dir));
    const result = await harness.runTurn([{ role: "user", content: "测试" }]);
    assert.equal(result.content, "最终正文");
    assert.equal(result.modelCalls, 2);
    assert.equal(result.stoppedBy, "done");
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0]!.name, "echo");
    assert.ok(result.tools[0]!.output.includes("回显"));
    // added 消息 = assistant(工具) + tool 结果 + assistant(正文)
    assert.equal(result.added.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent 循环：循环上限保护（模型反复调工具也必停）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rph-harness-"));
  try {
    const client = makeScriptedClient([
      { toolCalls: [{ id: "c1", type: "function", function: { name: "echo", arguments: "{}" } }] },
    ]);
    const harness = new Harness(client, registryWith(dir), makeConfig(dir, 3));
    const result = await harness.runTurn([{ role: "user", content: "测试" }]);
    assert.equal(result.stoppedBy, "max-turns");
    assert.equal(result.modelCalls, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent 循环：工具执行错误回填给模型（不中断剧情）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rph-harness-"));
  try {
    const client = makeScriptedClient([
      { toolCalls: [{ id: "c1", type: "function", function: { name: "不存在的工具", arguments: "{}" } }] },
      { content: "模型看到错误后自我修正的正文" },
    ]);
    const harness = new Harness(client, registryWith(dir), makeConfig(dir));
    const result = await harness.runTurn([{ role: "user", content: "测试" }]);
    assert.equal(result.tools[0]!.ok, false);
    assert.ok(result.tools[0]!.output.includes("未知工具"));
    assert.equal(result.content, "模型看到错误后自我修正的正文");
    assert.equal(result.stoppedBy, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("决策卡：decide 被拦截 → 用户选择注入 → 剧情继续 + 留痕", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rph-harness-"));
  try {
    const decideArgs = JSON.stringify({
      question: "去还是不去？",
      reason: "去了可能回不了头",
      options: ["去", "不去"],
      allow_free_input: true,
    });
    const client = makeScriptedClient([
      { toolCalls: [{ id: "d1", type: "function", function: { name: DECIDE_TOOL_NAME, arguments: decideArgs } }] },
      { content: "好，我们按你的选择去。" },
    ]);
    const harness = new Harness(client, registryWith(dir), makeConfig(dir));
    let asked: string[] = [];
    const result = await harness.runTurn([{ role: "user", content: "测试" }], {
      onDecisionRequested: async (card) => {
        asked.push(card.question);
        return card.options[0]!;
      },
    });
    assert.deepEqual(asked, ["去还是不去？"]);
    assert.equal(result.decisions.length, 1);
    assert.equal(result.decisions[0]!.choice, "去");
    // 留痕落盘
    const log = readFileSync(join(dir, "decisions.jsonl"), "utf8");
    assert.ok(log.includes("去还是不去"));
    assert.equal(result.content, "好，我们按你的选择去。");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("决策卡：参数不合法时回填错误并继续", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rph-harness-"));
  try {
    const client = makeScriptedClient([
      { toolCalls: [{ id: "d1", type: "function", function: { name: DECIDE_TOOL_NAME, arguments: "{}" } }] },
      { content: "修正后继续" },
    ]);
    const harness = new Harness(client, registryWith(dir), makeConfig(dir));
    const result = await harness.runTurn([{ role: "user", content: "测试" }]);
    assert.equal(result.tools[0]!.ok, false);
    assert.ok(result.tools[0]!.output.includes("参数解析失败"));
    assert.equal(result.content, "修正后继续");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
