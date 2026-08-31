import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { openStore } from "../store.ts";

export interface SnapshotBundle {
	id: string;
	at: string;
	label?: string;
	/** store 全量导出：{ "kv:key": value, "lines:kind": "行1\n行2" }。回档即整体替换 */
	files: Record<string, string>;
}

export interface SnapshotMeta {
	id: string;
	at: string;
	label?: string;
}

function snapshotsDir(stateDir: string): string {
	return resolve(stateDir, "snapshots");
}

/**
 * 全量存档：把当前世界状态（kv + lines 全部内容，即账本/摘要/历史/归档/决策/
 * 角色卡/主线进度）打包为 state/snapshots/<ts>.json。回档整个世界一致。
 */
export function createSnapshot(
	stateDir: string,
	label?: string,
): SnapshotBundle {
	const store = openStore(stateDir);
	let files: Record<string, string>;
	try {
		files = store.exportAll();
	} finally {
		store.close();
	}
	const bundle: SnapshotBundle = {
		id: new Date().toISOString().replace(/[:.]/g, "-"),
		at: new Date().toISOString(),
		label,
		files,
	};
	const dir = snapshotsDir(stateDir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		resolve(dir, `${bundle.id}.json`),
		JSON.stringify(bundle, null, 2),
		"utf8",
	);
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
			const b = JSON.parse(
				readFileSync(resolve(dir, f), "utf8"),
			) as SnapshotBundle;
			metas.push({ id: b.id, at: b.at, label: b.label });
		} catch {
			/* 跳过损坏快照 */
		}
	}
	return metas.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * 回档：把快照中的 store 导出整体写回 state.db。
 * 注意：调用方必须在回档后重建 ContextManager/Director（它们持有内存状态），
 * 并从存储重新加载角色卡。
 */
export function restoreSnapshot(
	stateDir: string,
	id: string,
): { ok: boolean; error?: string; at?: string; label?: string } {
	if (!validateSnapshotId(id))
		return { ok: false, error: `非法快照 id：${id}` };
	const p = resolve(stateDir, "snapshots", `${id}.json`);
	if (!existsSync(p)) return { ok: false, error: `快照不存在：${id}` };
	let bundle: SnapshotBundle;
	try {
		bundle = JSON.parse(readFileSync(p, "utf8")) as SnapshotBundle;
	} catch {
		return { ok: false, error: "快照文件损坏" };
	}
	const store = openStore(stateDir);
	try {
		store.importAll(bundle.files);
	} finally {
		store.close();
	}
	return { ok: true, at: bundle.at, label: bundle.label };
}

export function deleteSnapshot(stateDir: string, id: string): void {
	if (!validateSnapshotId(id)) return;
	rmSync(resolve(stateDir, "snapshots", `${id}.json`), { force: true });
}

/** 快照 id 白名单校验：防路径穿越（id 只能是指定字符，禁止 ../ 等） */
export function validateSnapshotId(id: string): boolean {
	return (
		typeof id === "string" &&
		/^[A-Za-z0-9._-]{1,80}$/.test(id) &&
		!id.includes("..")
	);
}
