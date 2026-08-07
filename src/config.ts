import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  apiBase: string;
  apiKey: string;
  model: string;
  /** 上下文预算：按字符估算（默认约 8k token ≈ 24k 字符），任务 5 使用 */
  contextBudgetChars: number;
  /** agent 循环最大迭代轮数，防死循环 */
  maxLoopTurns: number;
  /** 运行期数据目录（账本/存档等，纯 JSON） */
  stateDir: string;
}

/** 极简 .env 加载器（不覆盖已存在的环境变量） */
export function loadEnvFile(envPath = resolve(process.cwd(), ".env")): void {
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadConfig(): Config {
  loadEnvFile();
  return {
    apiBase: process.env.LIYUAN_API_BASE ?? "https://tokenrhythm.studio/v1",
    apiKey: process.env.LIYUAN_API_KEY ?? "",
    model: process.env.LIYUAN_MODEL ?? "deepseek-v4-flash-0731",
    contextBudgetChars: Number(process.env.LIYUAN_CONTEXT_BUDGET_CHARS ?? 24000),
    maxLoopTurns: Number(process.env.LIYUAN_MAX_LOOP_TURNS ?? 10),
    stateDir: resolve(process.cwd(), "state"),
  };
}
