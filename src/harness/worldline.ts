import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface SnapshotBundle {
  id: string;
  at: string;
  label?: string;
  /** 相对 stateDir 的文件名 → 内容（全部为纯文本/JSON，回档即整体替换） */
  files: Record<string, string>;
}

export interface SnapshotMeta {
  id: string;
  at: string;
  label?: string;
}

/** 参与世界线快照的状态文件（正文历史/摘要/账本/决策/角色卡全打包，保证"回档整个世界"一致） */
const STATE_FILES = [
  "ledger.json",
  "context.json",
  "history.jsonl",
  "archive.jsonl",
  "decisions.jsonl",
  "card.json",
  "director.json",
] as const;

function snapshotsDir(stateDir: string): string {
  return resolve(stateDir, "snapshots");
}

/** 全量存档：把当前世界状态（六文件）打包为 state/snapshots/<ts>.json */
export function createSnapshot(stateDir: string, label?: string): SnapshotBundle {
  const bundle: SnapshotBundle = {
    id: new Date().toISOString().replace(/[:.]/g, "-"),
    at: new Date().toISOString(),
    label,
    files: {},
  };
  for (const f of STATE_FILES) {
    const p = resolve(stateDir, f);
    if (existsSync(p)) bundle.files[f] = readFileSync(p, "utf8");
  }
  const dir = snapshotsDir(stateDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${bundle.id}.json`), JSON.stringify(bundle, null, 2), "utf8");
  return bundle;
}

/** 快照列表（新→旧） */
export function listSnapshots(stateDir: string): SnapshotMeta[] {
  const dir = snapshotsDir(stateDir);
  if (!existsSync(dir)) return [];
  const metas: SnapshotMeta[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const b = JSON.parse(readFileSync(resolve(dir, f), "utf8")) as SnapshotBundle;
      metas.push({ id: b.id, at: b.at, label: b.label });
    } catch {
      /* 跳过损坏快照 */
    }
  }
  return metas.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * 回档：把快照中的文件整体写回 stateDir。
 * 注意：调用方必须在回档后重建 ContextManager（它持有内存中的回合与摘要），
 * 并从磁盘重新加载角色卡。
 */
export function restoreSnapshot(stateDir: string, id: string): { ok: boolean; error?: string; at?: string; label?: string } {
  const p = resolve(stateDir, "snapshots", `${id}.json`);
  if (!existsSync(p)) return { ok: false, error: `快照不存在：${id}` };
  let bundle: SnapshotBundle;
  try {
    bundle = JSON.parse(readFileSync(p, "utf8")) as SnapshotBundle;
  } catch {
    return { ok: false, error: "快照文件损坏" };
  }
  mkdirSync(stateDir, { recursive: true });
  for (const [name, content] of Object.entries(bundle.files)) {
    writeFileSync(resolve(stateDir, name), content, "utf8");
  }
  return { ok: true, at: bundle.at, label: bundle.label };
}

export function deleteSnapshot(stateDir: string, id: string): void {
  rmSync(resolve(stateDir, "snapshots", `${id}.json`), { force: true });
}
