/**
 * SQLite 存储层（每会话一个 <stateDir>/state.db）。
 *
 * 替代原先散落的 JSON 文件（ledger.json / context.json / history.jsonl /
 * archive.jsonl / decisions.jsonl / card.json / director.json），保持零依赖
 * （Node ≥ 22 内置 node:sqlite）。公开语义与旧文件等价：
 *
 *  - kv 表：单文档状态（ledger / context / card / director）
 *  - lines 表：追加式记录（history / archive / decisions，按写入序）
 *
 * 启动时若 state.db 不存在而旧 JSON 文件存在，自动迁移并删除旧文件（幂等）。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const DB_NAME = "state.db";

/** kv 键 → 旧 JSON 文件名（迁移用） */
const KV_LEGACY: Record<string, string> = {
	ledger: "ledger.json",
	context: "context.json",
	card: "card.json",
	director: "director.json",
};

/** lines kind → 旧 JSONL 文件名（迁移用） */
const LINES_LEGACY: Record<string, string> = {
	history: "history.jsonl",
	archive: "archive.jsonl",
	decisions: "decisions.jsonl",
};

export interface Store {
	kvGet(key: string): string | null;
	kvSet(key: string, value: string): void;
	kvDelete(key: string): void;
	append(kind: string, line: string): void;
	readLines(kind: string): string[];
	removeKind(kind: string): void;
	/** 快照导出：{ "kv:<key>": value, "lines:<kind>": "行1\n行2" } */
	exportAll(): Record<string, string>;
	/** 快照导入：整体替换当前内容 */
	importAll(data: Record<string, string>): void;
	close(): void;
}

/** 打开（或迁移后打开）会话存储 */
export function openStore(stateDir: string): Store {
	mkdirSync(stateDir, { recursive: true });
	const db = new DatabaseSync(resolve(stateDir, DB_NAME));
	db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lines (
      kind TEXT NOT NULL,
      seq INTEGER NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (kind, seq)
    );
  `);
	migrateLegacy(db, stateDir);

	return {
		kvGet(key: string): string | null {
			const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
				| { value: string }
				| undefined;
			return row?.value ?? null;
		},
		kvSet(key: string, value: string): void {
			db.prepare(
				"INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			).run(key, value);
		},
		kvDelete(key: string): void {
			db.prepare("DELETE FROM kv WHERE key = ?").run(key);
		},
		append(kind: string, line: string): void {
			const max = db
				.prepare("SELECT COALESCE(MAX(seq), -1) AS m FROM lines WHERE kind = ?")
				.get(kind) as { m: number };
			db.prepare("INSERT INTO lines (kind, seq, value) VALUES (?, ?, ?)").run(
				kind,
				max.m + 1,
				line,
			);
		},
		readLines(kind: string): string[] {
			const rows = db
				.prepare("SELECT value FROM lines WHERE kind = ? ORDER BY seq")
				.all(kind) as { value: string }[];
			return rows.map((r) => r.value);
		},
		removeKind(kind: string): void {
			db.prepare("DELETE FROM lines WHERE kind = ?").run(kind);
		},
		exportAll(): Record<string, string> {
			const out: Record<string, string> = {};
			const kvRows = db.prepare("SELECT key, value FROM kv").all() as {
				key: string;
				value: string;
			}[];
			for (const r of kvRows) out[`kv:${r.key}`] = r.value;
			const kinds = db.prepare("SELECT DISTINCT kind FROM lines").all() as {
				kind: string;
			}[];
			for (const k of kinds)
				out[`lines:${k.kind}`] = this.readLines(k.kind).join("\n");
			return out;
		},
		importAll(data: Record<string, string>): void {
			db.exec("DELETE FROM kv; DELETE FROM lines;");
			const stmtKv = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)");
			const stmtLine = db.prepare(
				"INSERT INTO lines (kind, seq, value) VALUES (?, ?, ?)",
			);
			let seq = 0;
			for (const [key, value] of Object.entries(data)) {
				if (key.startsWith("kv:")) stmtKv.run(key.slice(3), value);
				else if (key.startsWith("lines:")) {
					const kind = key.slice(6);
					for (const line of value.split("\n")) {
						if (line.trim()) stmtLine.run(kind, seq++, line);
					}
				}
			}
		},
		close(): void {
			db.close();
		},
	};
}

/** 首次打开且存在旧 JSON 时迁移（导入 → 删除旧文件）。幂等：db 有数据即跳过 */
function migrateLegacy(db: DatabaseSync, stateDir: string): void {
	const kvCount = (
		db.prepare("SELECT COUNT(*) AS n FROM kv").get() as { n: number }
	).n;
	const lineCount = (
		db.prepare("SELECT COUNT(*) AS n FROM lines").get() as { n: number }
	).n;
	if (kvCount > 0 || lineCount > 0) return;

	let imported = false;
	const stmtKv = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)");
	const stmtLine = db.prepare(
		"INSERT INTO lines (kind, seq, value) VALUES (?, ?, ?)",
	);
	for (const [key, file] of Object.entries(KV_LEGACY)) {
		const p = resolve(stateDir, file);
		if (!existsSync(p)) continue;
		try {
			stmtKv.run(key, readFileSync(p, "utf8"));
			imported = true;
		} catch {
			/* 损坏文件跳过迁移（等价于无数据） */
		}
	}
	for (const [kind, file] of Object.entries(LINES_LEGACY)) {
		const p = resolve(stateDir, file);
		if (!existsSync(p)) continue;
		try {
			const lines = readFileSync(p, "utf8")
				.split(/\r?\n/)
				.filter((l) => l.trim());
			lines.forEach((line, i) => stmtLine.run(kind, i, line));
			imported = imported || lines.length > 0;
		} catch {
			/* 跳过 */
		}
	}
	if (imported) {
		for (const file of [
			...Object.values(KV_LEGACY),
			...Object.values(LINES_LEGACY),
		]) {
			rmSync(resolve(stateDir, file), { force: true });
		}
	}
}
