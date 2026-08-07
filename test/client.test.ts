/**
 * LlmClient 多 provider 兜底：用 globalThis.fetch 桩模拟主 provider 各种失败
 * 模式，验证回退 / 不回退 / 全部失败时抛错的语义。
 *
 * 注意：Node 22 的 fetch 是全局的；这里直接覆盖再还原。测试串行运行。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmClient, ApiError } from "../src/llm/client.ts";
import type { Config } from "../src/config.ts";

/** 造一个可记录每个 provider 被命中次数的 fetch 桩 */
type FetchCall = { url: string; auth: string | null; model: string };
function makeFetchStub(
  // 按 (apiBase, model) 路由；value 可以是 { ok, status, body? }，null/undefined 抛网络错误
  routes: Map<string, (call: FetchCall) => Response | Promise<Response>>,
  log: FetchCall[],
  networkError: { apiBase: string } | null = null,
): typeof fetch {
  return async (input: any, init?: any): Promise<Response> => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    const auth = (init?.headers?.Authorization ?? init?.headers?.authorization ?? null) as string | null;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const model = body?.model ?? "";
    // 反推 apiBase
    const m = String(url).match(/^(https?:\/\/[^/]+)\/chat\/completions/);
    const apiBase = m ? m[1] : url;
    const call: FetchCall = { url: String(url), auth, model };
    log.push(call);
    if (networkError && apiBase === networkError.apiBase) {
      throw new Error(`simulated network error to ${apiBase}`);
    }
    const handler = routes.get(apiBase);
    if (!handler) throw new Error(`test stub: no route for ${apiBase}`);
    return handler(call);
  };
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function okContent(text: string): Response {
  return jsonRes(200, { choices: [{ message: { content: text }, finish_reason: "stop" }] });
}

function errRes(status: number, msg = "boom"): Response {
  return jsonRes(status, { error: { message: msg } });
}

function cfgWithFallbacks(primary: { apiBase: string; apiKey: string; model: string }, fallbacks: { apiBase: string; apiKey: string; model: string }[] = [], disableFallback = false): Config {
  return {
    apiBase: primary.apiBase,
    apiKey: primary.apiKey,
    model: primary.model,
    fallbacks,
    disableFallback,
    contextBudgetChars: 24000,
    maxLoopTurns: 5,
    stateDir: "/tmp",
    autoSnapshotEvery: 0,
  };
}

let origFetch: typeof fetch;
test.beforeEach(() => { origFetch = globalThis.fetch; });
test.afterEach(() => { globalThis.fetch = origFetch; });

test("单 provider：成功直接返回", async () => {
  const log: FetchCall[] = [];
  globalThis.fetch = makeFetchStub(
    new Map([["https://primary", () => okContent("hi")]]),
    log,
  );
  const client = new LlmClient(cfgWithFallbacks({ apiBase: "https://primary", apiKey: "k1", model: "m1" }));
  const r = await client.chat([{ role: "user", content: "x" }]);
  assert.equal(r.content, "hi");
  assert.equal(log.length, 1);
  assert.equal(log[0]!.model, "m1");
  assert.equal(log[0]!.auth, "Bearer k1");
});

test("单 provider：5xx 重试 3 次后抛错", async () => {
  const log: FetchCall[] = [];
  globalThis.fetch = makeFetchStub(
    new Map([["https://primary", () => errRes(500, "down")]]),
    log,
  );
  const client = new LlmClient(cfgWithFallbacks({ apiBase: "https://primary", apiKey: "k1", model: "m1" }));
  await assert.rejects(client.chat([{ role: "user", content: "x" }]), (e: unknown) => {
    return e instanceof ApiError && e.status === 500;
  });
  assert.equal(log.length, 3, "5xx 应该重试 3 次（1+2）");
});

test("兜底：主 5xx 重试耗尽 → 切到兜底成功", async () => {
  const log: FetchCall[] = [];
  globalThis.fetch = makeFetchStub(
    new Map([
      ["https://primary", () => errRes(503, "down")],
      ["https://fallback1", () => okContent("hello from fallback")],
    ]),
    log,
  );
  const client = new LlmClient(cfgWithFallbacks(
    { apiBase: "https://primary", apiKey: "k1", model: "m1" },
    [{ apiBase: "https://fallback1", apiKey: "k2", model: "m2" }],
  ));
  const r = await client.chat([{ role: "user", content: "x" }]);
  assert.equal(r.content, "hello from fallback");
  assert.equal(log.length, 4, "3 次 primary + 1 次 fallback1");
  assert.equal(log[3]!.auth, "Bearer k2");
  assert.equal(log[3]!.model, "m2");
});

test("兜底：主 401 → 立即切到兜底（不等重试）", async () => {
  const log: FetchCall[] = [];
  globalThis.fetch = makeFetchStub(
    new Map([
      ["https://primary", () => errRes(401, "bad key")],
      ["https://fallback1", () => okContent("via fallback")],
    ]),
    log,
  );
  const client = new LlmClient(cfgWithFallbacks(
    { apiBase: "https://primary", apiKey: "k1", model: "m1" },
    [{ apiBase: "https://fallback1", apiKey: "k2", model: "m2" }],
  ));
  const r = await client.chat([{ role: "user", content: "x" }]);
  assert.equal(r.content, "via fallback");
  assert.equal(log.length, 2, "401 不在主 provider 内重试，立即切兜底");
});

test("兜底：主 404（模型不存在） → 切到兜底", async () => {
  const log: FetchCall[] = [];
  globalThis.fetch = makeFetchStub(
    new Map([
      ["https://primary", () => errRes(404, "model not found")],
      ["https://fallback1", () => okContent("from fb")],
    ]),
    log,
  );
  const client = new LlmClient(cfgWithFallbacks(
    { apiBase: "https://primary", apiKey: "k1", model: "deepseek-v4-flash-0731" },
    [{ apiBase: "https://fallback1", apiKey: "k2", model: "deepseek-v4-flash" }],
  ));
  const r = await client.chat([{ role: "user", content: "x" }]);
  assert.equal(r.content, "from fb");
  assert.equal(log.length, 2);
});

test("不兜底：主 400（payload 错） → 直接返回，不试兜底", async () => {
  // 现有 chat() 行为：4xx 不抛错，body 没有 choices 字段，返回 content=""
  // 兜底规则不触发：400 是 payload 错，payload 一样发到兜底还是会 400，浪费调用
  const log: FetchCall[] = [];
  globalThis.fetch = makeFetchStub(
    new Map([
      ["https://primary", () => errRes(400, "bad request")],
      ["https://fallback1", () => okContent("should not reach")],
    ]),
    log,
  );
  const client = new LlmClient(cfgWithFallbacks(
    { apiBase: "https://primary", apiKey: "k1", model: "m1" },
    [{ apiBase: "https://fallback1", apiKey: "k2", model: "m2" }],
  ));
  const r = await client.chat([{ role: "user", content: "x" }]);
  assert.equal(r.content, ""); // 4xx 响应体无 choices，content 为空
  assert.equal(log.length, 1, "400 不触发兜底");
});

test("兜底：主网络错误（fetch throw） → 切到兜底", async () => {
  const log: FetchCall[] = [];
  globalThis.fetch = makeFetchStub(
    new Map([
      ["https://fallback1", () => okContent("from fb")],
    ]),
    log,
    { apiBase: "https://primary" }, // 主 provider 网络错误
  );
  const client = new LlmClient(cfgWithFallbacks(
    { apiBase: "https://primary", apiKey: "k1", model: "m1" },
    [{ apiBase: "https://fallback1", apiKey: "k2", model: "m2" }],
  ));
  const r = await client.chat([{ role: "user", content: "x" }]);
  assert.equal(r.content, "from fb");
  assert.ok(log.length >= 4, "primary 抛 3 次 + fallback1 1 次");
});

test("兜底：所有 provider 都失败 → 抛最后一个错", async () => {
  const log: FetchCall[] = [];
  globalThis.fetch = makeFetchStub(
    new Map([
      ["https://primary", () => errRes(500, "p down")],
      ["https://fallback1", () => errRes(502, "f1 down")],
      ["https://fallback2", () => errRes(503, "f2 down")],
    ]),
    log,
  );
  const client = new LlmClient(cfgWithFallbacks(
    { apiBase: "https://primary", apiKey: "k1", model: "m1" },
    [
      { apiBase: "https://fallback1", apiKey: "k2", model: "m2" },
      { apiBase: "https://fallback2", apiKey: "k3", model: "m3" },
    ],
  ));
  await assert.rejects(client.chat([{ role: "user", content: "x" }]), (e: unknown) => {
    return e instanceof ApiError && e.status === 503;
  });
  // primary: 3 次; fallback1: 3 次; fallback2: 3 次
  assert.equal(log.length, 9);
});

test("disableFallback=true：兜底配置存在也不启用", async () => {
  const log: FetchCall[] = [];
  globalThis.fetch = makeFetchStub(
    new Map([
      ["https://primary", () => errRes(500, "p down")],
      ["https://fallback1", () => okContent("should not reach")],
    ]),
    log,
  );
  const client = new LlmClient(cfgWithFallbacks(
    { apiBase: "https://primary", apiKey: "k1", model: "m1" },
    [{ apiBase: "https://fallback1", apiKey: "k2", model: "m2" }],
    true, // disableFallback
  ));
  await assert.rejects(client.chat([{ role: "user", content: "x" }]), (e: unknown) => {
    return e instanceof ApiError && e.status === 500;
  });
  assert.equal(log.length, 3, "只在 primary 重试 3 次");
});

test("兜底：主 429 → 本 provider 内重试，不立即切兜底", async () => {
  const log: FetchCall[] = [];
  let primaryHits = 0;
  globalThis.fetch = makeFetchStub(
    new Map([
      ["https://primary", () => {
        primaryHits++;
        if (primaryHits < 3) return errRes(429, "rate limit");
        return okContent("from primary after retry");
      }],
      ["https://fallback1", () => okContent("from fb")],
    ]),
    log,
  );
  const client = new LlmClient(cfgWithFallbacks(
    { apiBase: "https://primary", apiKey: "k1", model: "m1" },
    [{ apiBase: "https://fallback1", apiKey: "k2", model: "m2" }],
  ));
  const r = await client.chat([{ role: "user", content: "x" }]);
  assert.equal(r.content, "from primary after retry");
  assert.equal(log.length, 3, "429 在 primary 内重试到第 3 次成功");
});

test("兜底：stream() 也走同一套兜底链", async () => {
  const log: FetchCall[] = [];
  globalThis.fetch = makeFetchStub(
    new Map([
      ["https://primary", () => errRes(502, "bad gateway")],
      ["https://fallback1", () => new Response(
        // SSE 流：单个 content 块
        `data: {"choices":[{"delta":{"content":"streamed-from-fb"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      )],
    ]),
    log,
  );
  const client = new LlmClient(cfgWithFallbacks(
    { apiBase: "https://primary", apiKey: "k1", model: "m1" },
    [{ apiBase: "https://fallback1", apiKey: "k2", model: "m2" }],
  ));
  const deltas: string[] = [];
  const r = await client.stream(
    [{ role: "user", content: "x" }],
    { onDelta: (d) => deltas.push(d) },
  );
  assert.equal(r.content, "streamed-from-fb");
  assert.deepEqual(deltas, ["streamed-from-fb"]);
  assert.equal(log.length, 4, "3 次 primary 失败 + 1 次 fallback 成功");
});
