import type { Config } from "../config.ts";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  /** 正文（给用户看的剧情/回复） */
  content: string;
  /** 思维链（reasoning_content，仅供内部消费，绝不直接展示） */
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: { prompt: number; completion: number; total: number };
}

export class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`API ${status}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

export interface ChatOptions {
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  /** 模型覆盖（多模型分级：记账/压缩用便宜模型） */
  model?: string;
}

/**
 * 零依赖 OpenAI 兼容客户端。
 * 统一入口点：${apiBase}/chat/completions（如 https://tokenrhythm.studio/v1）
 */
export class LlmClient {
  private cfg: Config;
  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  private async request(messages: ChatMessage[], opts: ChatOptions & { stream?: boolean }): Promise<Response> {
    const body: Record<string, unknown> = {
      model: opts.model ?? this.cfg.model,
      messages,
      stream: opts.stream ?? false,
    };
    if (opts.tools?.length) body.tools = opts.tools;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

    // 网络/5xx/429/超时重试（最多 2 次，指数退避）；4xx 业务错误不重试
    const MAX_RETRY = 2;
    const TIMEOUT_MS = 90_000; // 单次请求超时（防上游 API 挂起导致前端永久"生成中"）
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(`${this.cfg.apiBase}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res;
        lastErr = new ApiError(res.status, await res.text());
      } catch (e) {
        lastErr = e; // 网络层错误 / 超时（AbortError）
      } finally {
        clearTimeout(timer);
      }
      if (attempt < MAX_RETRY) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
    // 重试耗尽：把 AbortError 转成可读错误
    if (lastErr instanceof Error && lastErr.name === "AbortError") {
      throw new Error(`请求超时（${TIMEOUT_MS / 1000}s × ${MAX_RETRY + 1} 次）：上游 API 无响应，请重试或检查网络`);
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** 非流式单轮调用——旁侧模型（记账、压缩、摘要）用 */
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const res = await this.request(messages, opts);
    const data = (await res.json()) as {
      choices?: { message?: Record<string, unknown>; finish_reason?: string }[];
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    const msg = data.choices?.[0]?.message ?? {};
    return {
      content: typeof msg.content === "string" ? msg.content : "",
      reasoning: typeof msg.reasoning_content === "string" ? msg.reasoning_content : "",
      toolCalls: Array.isArray(msg.tool_calls) ? (msg.tool_calls as ToolCall[]) : [],
      finishReason: data.choices?.[0]?.finish_reason ?? "",
      usage: data.usage
        ? {
            prompt: data.usage.prompt_tokens,
            completion: data.usage.completion_tokens,
            total: data.usage.total_tokens,
          }
        : undefined,
    };
  }

  /**
   * 流式调用——主剧情用。
   * 正文增量经 onDelta 实时流出给用户；思维链只累计进 reasoning，不回调（实现"剥离"）。
   * 工具调用按 index 增量拼接。
   */
  async stream(
    messages: ChatMessage[],
    opts: ChatOptions & { onDelta?: (delta: string) => void } = {},
  ): Promise<ChatResult> {
    const res = await this.request(messages, { ...opts, stream: true });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    const toolCalls: ToolCall[] = [];
    let finishReason = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 事件以空行分隔；残留在 buffer 等下一块
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        for (const line of part.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          let chunk: any;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = chunk.choices?.[0]?.delta ?? {};
          finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
          if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
          if (typeof delta.content === "string") {
            content += delta.content;
            opts.onDelta?.(delta.content);
          }
          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index ?? toolCalls.length;
            if (!toolCalls[idx]) toolCalls[idx] = { id: `call_${idx}`, type: "function", function: { name: "", arguments: "" } };
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }
    }
    return { content, reasoning, toolCalls: toolCalls.filter(Boolean), finishReason, usage: undefined };
  }
}
