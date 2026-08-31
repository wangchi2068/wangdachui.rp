import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	recordDecision,
	type DecisionCard,
} from "../src/harness/decision-card.ts";
import { validateSnapshotId } from "../src/harness/worldline.ts";
import { openStore } from "../src/store.ts";

test("recordDecision 写入指定 stateDir（会话隔离）", () => {
	const root = mkdtempSync(join(tmpdir(), "wd-decision-"));
	try {
		const sessA = resolve(root, "sessions", "sessA");
		const sessB = resolve(root, "sessions", "sessB");
		const card: DecisionCard = {
			question: "去码头还是去教会？",
			options: ["码头", "教会"],
			allowFreeInput: true,
		};

		recordDecision(sessA, card, "码头");
		recordDecision(sessB, card, "教会");

		// 各自落在自己的会话库（state.db），全局目录不出现
		const a = (() => {
			const s = openStore(sessA);
			try {
				return s.readLines("decisions").join("\n");
			} finally {
				s.close();
			}
		})();
		const b = (() => {
			const s = openStore(sessB);
			try {
				return s.readLines("decisions").join("\n");
			} finally {
				s.close();
			}
		})();
		// 隔离验证：各自的 choice 正确，且互不混入对方的选择
		assert.match(a, /"choice":"码头"/);
		assert.match(b, /"choice":"教会"/);
		assert.ok(!a.includes('"choice":"教会"'), "A 会话不应混入 B 的选择");
		assert.ok(!b.includes('"choice":"码头"'), "B 会话不应混入 A 的选择");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("validateSnapshotId 拒绝路径穿越", () => {
	assert.ok(validateSnapshotId("2026-08-07T12-30-00Z"));
	assert.ok(validateSnapshotId("snap1.json"));
	assert.ok(!validateSnapshotId("../../etc/passwd"));
	assert.ok(!validateSnapshotId(".."));
	assert.ok(!validateSnapshotId("a/b"));
	assert.ok(!validateSnapshotId("x".repeat(100)), "超长应拒绝");
});
