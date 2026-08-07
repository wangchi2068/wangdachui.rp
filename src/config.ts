import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  apiBase: string;
  apiKey: string;
  model: string;
  /** 记账/压缩用的便宜模型（缺省跟随主模型，多模型分级） */
  scribeModel?: string;
  compressModel?: string;
  /** 上下文预算：按字符估算（默认约 8k token ≈ 24k 字符），任务 5 使用 */
  contextBudgetChars: number;
  /** agent 循环最大迭代轮数，防死循环 */
  maxLoopTurns: number;
  /** 运行期数据目录（账本/存档等，纯 JSON） */
  stateDir: string;
  /** 每 N 回合自动存档（0 = 关闭） */
  autoSnapshotEvery: number;
  /** 战役包名：存在时从 assets/campaigns/<name>/ 加载卡与世界书（默认 undefined = 都市修仙） */
  campaign?: string;
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
  // 无状态环境（Vercel 等）：state 落 /tmp（实例临时盘，单用户/低流量可跑；实例回收会丢档）
  const isVercel = process.env.VERCEL === "1";
  const stateMode = process.env.WANGDACHUI_STATE_MODE ?? (isVercel ? "tmp" : "disk");
  return {
    apiBase: process.env.WANGDACHUI_API_BASE ?? "https://tokenrhythm.studio/v1",
    apiKey: process.env.WANGDACHUI_API_KEY ?? "",
    model: process.env.WANGDACHUI_MODEL ?? "deepseek-v4-flash-0731",
    scribeModel: process.env.WANGDACHUI_SCRIBE_MODEL || undefined,
    compressModel: process.env.WANGDACHUI_COMPRESS_MODEL || undefined,
    contextBudgetChars: Number(process.env.WANGDACHUI_CONTEXT_BUDGET_CHARS ?? 24000),
    maxLoopTurns: Number(process.env.WANGDACHUI_MAX_LOOP_TURNS ?? 10),
    stateDir: stateMode === "tmp" ? resolve("/tmp", "wangdachui-state") : resolve(process.cwd(), "state"),
    autoSnapshotEvery: Number(process.env.WANGDACHUI_AUTO_SNAPSHOT_EVERY ?? 5),
    campaign: process.env.WANGDACHUI_CAMPAIGN || "lotm", // 默认诡秘之主·廷根篇战役
  };
}
