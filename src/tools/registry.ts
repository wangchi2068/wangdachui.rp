import type { ToolDef } from "../llm/client.ts";

export interface ToolContext {
  /** 运行期数据目录 */
  stateDir: string;
}

export type ToolExecutor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

export interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: ToolExecutor;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

/**
 * 工具注册表：harness 与工具之间的唯一接口。
 * - 工具自描述（name/description/parameters）→ 转成 OpenAI tools schema；
 * - 执行统一入口：参数 JSON 解析失败、工具抛错，都包装成文本结果回填给模型，
 *   让模型能"看到错误→修正→再试"（验证-再思考循环），而不是把异常抛到主循环。
 */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  register(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  defs(): ToolDef[] {
    return [...this.tools.values()].map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  async run(name: string, argsJson: string): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, output: `未知工具：${name}（可用：${this.names().join(", ")}）` };
    try {
      const args: Record<string, unknown> = argsJson ? JSON.parse(argsJson) : {};
      const output = await tool.execute(args, this.ctx);
      return { ok: true, output };
    } catch (e) {
      return { ok: false, output: `工具 ${name} 执行失败：${(e as Error).message}` };
    }
  }
}
