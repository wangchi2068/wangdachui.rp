import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 一个 OpenAI 兼容的 LLM provider 端点；用于主调用或兜底 */
export interface Provider {
  apiBase: string;
  apiKey: string;
  model: string;
}

export interface Config {
  apiBase: string;
  apiKey: string;
  model: string;
  /**
   * 兜底 provider 列表（按顺序回退）。
   * 主 provider 不可达 / 5xx / 429 重试耗尽 / 401·403·404 时，自动切到下一个。
   * 400·422 这类业务错误不触发兜底（payload 错就是错，换 provider 也没用）。
   * 设为空数组 = 不兜底（旧行为）。通过 WANGDACHUI_FALLBACK_API_BASE/_KEY/_MODEL
   * 或 WANGDACHUI_FALLBACKS_JSON 配置。
   */
  fallbacks?: Provider[];
  /** 调试用：禁用兜底强制走主 provider，便于复现主 provider 故障 */
  disableFallback?: boolean;
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
    fallbacks: loadFallbacks(),
    disableFallback: process.env.WANGDACHUI_DISABLE_FALLBACK === "1",
    scribeModel: process.env.WANGDACHUI_SCRIBE_MODEL || undefined,
    compressModel: process.env.WANGDACHUI_COMPRESS_MODEL || undefined,
    contextBudgetChars: Number(process.env.WANGDACHUI_CONTEXT_BUDGET_CHARS ?? 24000),
    maxLoopTurns: Number(process.env.WANGDACHUI_MAX_LOOP_TURNS ?? 10),
    stateDir: stateMode === "tmp" ? resolve("/tmp", "wangdachui-state") : resolve(process.cwd(), "state"),
    autoSnapshotEvery: Number(process.env.WANGDACHUI_AUTO_SNAPSHOT_EVERY ?? 5),
    campaign: process.env.WANGDACHUI_CAMPAIGN || "lotm", // 默认诡秘之主·廷根篇战役
  };
}

/**
 * 加载兜底 provider 列表。两套配置方式，按以下优先级：
 *  1) WANGDACHUI_FALLBACKS_JSON — JSON 数组，可配置多个；用于部署时多网关轮换
 *  2) WANGDACHUI_FALLBACK_API_BASE / _KEY / _MODEL — 单个兜底，写在 .env 里
 * 缺省返回空数组（保持旧行为：不兜底）。
 */
function loadFallbacks(): Provider[] {
  const out: Provider[] = [];
  const json = process.env.WANGDACHUI_FALLBACKS_JSON;
  if (json && json.trim()) {
    try {
      const arr = JSON.parse(json);
      if (Array.isArray(arr)) {
        for (const f of arr) {
          if (f && typeof f.apiBase === "string" && typeof f.apiKey === "string" && typeof f.model === "string") {
            out.push({ apiBase: f.apiBase, apiKey: f.apiKey, model: f.model });
          }
        }
      }
    } catch (e) {
      console.warn("[config] WANGDACHUI_FALLBACKS_JSON 解析失败，已忽略：", e instanceof Error ? e.message : e);
    }
  }
  const singleBase = process.env.WANGDACHUI_FALLBACK_API_BASE;
  if (singleBase && singleBase.trim()) {
    out.push({
      apiBase: singleBase,
      apiKey: process.env.WANGDACHUI_FALLBACK_API_KEY ?? "",
      model: process.env.WANGDACHUI_FALLBACK_API_MODEL ?? process.env.WANGDACHUI_MODEL ?? "deepseek-v4-flash-0731",
    });
  }
  return out;
}
