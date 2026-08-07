import type { Config, Provider } from "../config.ts";

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

/** 读 body 但不动原 Response 的流（兜底场景里 res 可能还要 return 给调用方） */
async function resCloneBody(res: Response): Promise<string> {
  try {
    return await res.clone().text();
  } catch {
    return "";
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
 *
 * 多 provider 兜底：构造时读 cfg.fallbacks 列表。主 provider 不可达 / 5xx /
 * 429 重试耗尽 / 401·403·404 时自动切到下一个；400·422 等业务错误直接抛。
 * 4xx 兜底规则：401（key 不对）403（被禁）404（模型不存在）—— 不同网关的鉴权
 * / 模型命名不同，切到下一家很可能就活了；400 / 422 是 payload 错误，换 provider
 * 也没用。WANGDACHUI_DISABLE_FALLBACK=1 可强制只走主 provider 复现故障。
 */
export class LlmClient {
  private cfg: Config;
  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  /** 主 provider + 兜底列表（disableFallback 时只返主） */
  private chain(): Provider[] {
    const primary: Provider = { apiBase: this.cfg.apiBase, apiKey: this.cfg.apiKey, model: this.cfg.model };
    return this.cfg.disableFallback ? [primary] : [primary, ...(this.cfg.fallbacks ?? [])];
  }

  private async request(messages: ChatMessage[], opts: ChatOptions & { stream?: boolean }): Promise<Response> {
    // 多 provider 兜底：主 provider 失败 → 下一个。每个 provider 内仍带自己的重试退避。
    // model 优先用 opts.model（旁侧模型：记账/压缩/摘要会显式覆盖），否则用本 provider 自己的 model。
    const chain = this.chain();
    const MAX_RETRY = 2;
    const TIMEOUT_MS = 90_000; // 单次请求超时（防上游 API 挂起导致前端永久"生成中"）
    // 只记 status 不读 body：避免在重试 / 兜底切换路径上把 Response 的 body 流消耗掉，
    // 否则最后"返回 res 让调用方报错"时调用方会拿到"Body has already been read"。
    let lastStatus: number | null = null;
    let lastErr: unknown = null;

    for (let pIdx = 0; pIdx < chain.length; pIdx++) {
      const provider = chain[pIdx]!; // 循环边界内必存在
      const isLastProvider = pIdx === chain.length - 1;

      const body: Record<string, unknown> = {
        model: opts.model ?? provider.model,
        messages,
        stream: opts.stream ?? false,
      };
      if (opts.tools?.length) body.tools = opts.tools;
      if (opts.temperature !== undefined) body.temperature = opts.temperature;
      if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
      const bodyJson = JSON.stringify(body);

      for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const res = await fetch(`${provider.apiBase}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${provider.apiKey}`,
            },
            body: bodyJson,
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (res.ok) {
            if (pIdx > 0) console.warn(`[llm] 主 provider 失败后兜底到 ${provider.apiBase} (${provider.model}) 成功`);
            return res;
          }
          // 4xx 业务错误处理
          if (res.status >= 400 && res.status < 500) {
            if (res.status === 429) {
              // 限流：本 provider 内重试（兜底可能也限流，不直接换）
              lastStatus = res.status;
              lastErr = new ApiError(res.status, await resCloneBody(res));
            } else if (res.status === 401 || res.status === 403 || res.status === 404) {
              // 鉴权/权限/模型不存在：换 provider 很可能就修好了
              lastStatus = res.status;
              lastErr = new ApiError(res.status, await resCloneBody(res));
              if (!isLastProvider) {
                console.warn(`[llm] provider ${provider.apiBase} 返回 ${res.status}，切到下一个兜底`);
                break; // 跳出本 provider 的重试，进入下一个 provider
              }
              return res; // 已是最后一个，让调用方按原 4xx 处理（保持 chat() 既有行为）
            } else {
              // 400/422 等：payload 错就是错，换 provider 也没用
              return res;
            }
          } else {
            // 5xx：本 provider 内重试
            lastStatus = res.status;
            lastErr = new ApiError(res.status, await resCloneBody(res));
          }
        } catch (e) {
          clearTimeout(timer);
          lastErr = e; // 网络层错误 / AbortError
        }
        if (attempt < MAX_RETRY) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
      // 走到这里：本 provider 重试耗尽。若还有下一个 provider，继续；否则下面统一抛。
      if (!isLastProvider) {
        console.warn(`[llm] provider ${provider.apiBase} 连续 ${MAX_RETRY + 1} 次失败，切到下一个兜底`);
      }
    }

    // 所有 provider 都失败
    if (lastErr instanceof Error && lastErr.name === "AbortError") {
      throw new Error(`请求超时（${TIMEOUT_MS / 1000}s × providers=${chain.length}）：上游 API 无响应，请重试或检查网络`);
    }
    if (lastErr instanceof Error) throw lastErr;
    throw new Error(String(lastErr ?? `所有 ${chain.length} 个 provider 均失败（最后 status=${lastStatus}）`));
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
    // 流式空闲超时：SSE 连接已建立但服务端停止推流（LLM 挂起/过载）时，
    // reader.read() 会永久挂起，必须超时 abort 而不是让前端永久"生成中"。
    const IDLE_TIMEOUT_MS = 45_000;
    while (true) {
      let readResult: Awaited<ReturnType<typeof reader.read>>;
      try {
        readResult = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => {
              console.warn("[llm] 流式空闲超时：服务端 45s 未推流");
              reject(new Error("stream idle timeout"));
            }, IDLE_TIMEOUT_MS),
          ),
        ]);
      } catch (e) {
        // 空闲超时（服务端停止推流）：清理流后，有内容按已有内容返回，无内容抛错
        reader.cancel().catch(() => {});
        if (content || reasoning || toolCalls.length) break;
        throw e;
      }
      const { done, value } = readResult;
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
