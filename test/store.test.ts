import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.ts";

test("store：kv 读写删", () => {
	const dir = mkdtempSync(join(tmpdir(), "rph-store-"));
	try {
		const store = openStore(dir);
		store.kvSet("ledger", '{"characters":[]}');
		assert.equal(store.kvGet("ledger"), '{"characters":[]}');
		store.kvSet("ledger", '{"characters":[{"key":"a"}]}');
		assert.equal(store.kvGet("ledger"), '{"characters":[{"key":"a"}]}');
		store.kvDelete("ledger");
		assert.equal(store.kvGet("ledger"), null);
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("store：lines 追加保序（历史/归档/决策）", () => {
	const dir = mkdtempSync(join(tmpdir(), "rph-store-"));
	try {
		const store = openStore(dir);
		store.append("history", '{"id":"t1"}');
		store.append("history", '{"id":"t2"}');
		store.append("archive", '{"id":"t0"}');
		assert.deepEqual(store.readLines("history"), [
			'{"id":"t1"}',
			'{"id":"t2"}',
		]);
		assert.deepEqual(store.readLines("archive"), ['{"id":"t0"}']);
		store.removeKind("history");
		assert.deepEqual(store.readLines("history"), []);
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("store：旧 JSON 文件自动迁移到 SQLite 并删除", () => {
	const dir = mkdtempSync(join(tmpdir(), "rph-store-"));
	try {
		// 手工构造旧文件布局（模拟历史版本）
		writeFileSync(join(dir, "ledger.json"), '{"notes":[{"key":"n1"}]}', "utf8");
		writeFileSync(
			join(dir, "context.json"),
			'{"summary":"旧摘要","compressedUpTo":2}',
			"utf8",
		);
		writeFileSync(
			join(dir, "history.jsonl"),
			'{"id":"t1"}\n{"id":"t2"}\n',
			"utf8",
		);
		writeFileSync(join(dir, "decisions.jsonl"), '{"choice":"码头"}\n', "utf8");

		const store = openStore(dir);
		assert.equal(store.kvGet("ledger"), '{"notes":[{"key":"n1"}]}');
		assert.equal(
			store.kvGet("context"),
			'{"summary":"旧摘要","compressedUpTo":2}',
		);
		assert.deepEqual(store.readLines("history"), [
			'{"id":"t1"}',
			'{"id":"t2"}',
		]);
		assert.deepEqual(store.readLines("decisions"), ['{"choice":"码头"}']);
		store.close();

		// 旧文件已被删除，且再次打开（幂等）不会重复导入
		assert.ok(!existsSync(join(dir, "ledger.json")));
		assert.ok(!existsSync(join(dir, "history.jsonl")));
		const again = openStore(dir);
		assert.equal(again.readLines("history").length, 2);
		again.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("store：exportAll/importAll 快照往返（世界线存档语义）", () => {
	const dir = mkdtempSync(join(tmpdir(), "rph-store-"));
	const dir2 = mkdtempSync(join(tmpdir(), "rph-store2-"));
	try {
		const store = openStore(dir);
		store.kvSet("ledger", '{"characters":[{"key":"kc"}]}');
		store.kvSet("card", '{"name":"克莱恩"}');
		store.append("history", '{"id":"t1"}');
		store.append("decisions", '{"choice":"去码头"}');
		const dump = store.exportAll();
		store.close();

		// 恢复到另一个目录 = 回档
		const store2 = openStore(dir2);
		store2.importAll(dump);
		assert.equal(store2.kvGet("ledger"), '{"characters":[{"key":"kc"}]}');
		assert.equal(store2.kvGet("card"), '{"name":"克莱恩"}');
		assert.deepEqual(store2.readLines("history"), ['{"id":"t1"}']);
		assert.deepEqual(store2.readLines("decisions"), ['{"choice":"去码头"}']);
		// importAll 是整体替换：预置脏数据会被清掉
		store2.append("history", '{"id":"dirty"}');
		store2.importAll(dump);
		assert.deepEqual(store2.readLines("history"), ['{"id":"t1"}']);
		store2.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(dir2, { recursive: true, force: true });
	}
});
