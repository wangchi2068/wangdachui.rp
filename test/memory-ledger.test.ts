import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyLedger,
  extractJson,
  mergeLedger,
  snapshotText,
  loadLedger,
  saveLedger,
} from "../src/harness/memory-ledger.ts";

test("extractJson：裸 JSON / 围栏 / 前后夹带文本", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('好的，账本如下：\n{"a":3}\n以上就是'), { a: 3 });
  assert.equal(extractJson("没有JSON"), null);
  assert.equal(extractJson(""), null);
});

test("mergeLedger：同名 key 更新，新 key 追加，去重不堆积", () => {
  const base = emptyLedger();
  base.characters = [{ key: "xiaolin", name: "小林", status: "存活" }];
  const merged = mergeLedger(base, {
    characters: [
      { key: "xiaolin", name: "小林", status: "受伤" }, // 同名更新
      { key: "xuanyi", name: "玄一", status: "苏醒" }, // 新增
    ],
    plots: [{ key: "p1", desc: "王总有妖气", status: "未回收" }],
  });
  assert.equal(merged.characters.length, 2);
  assert.equal(merged.characters[0]!.status, "受伤");
  assert.equal(merged.characters[1]!.name, "玄一");
  assert.equal(merged.plots.length, 1);
});

test("snapshotText：空账本与有内容", () => {
  assert.ok(snapshotText(emptyLedger()).includes("账本为空"));
  const l = emptyLedger();
  l.items = [{ key: "guyu", name: "古玉", owner: "小林" }];
  const text = snapshotText(l);
  assert.ok(text.includes("古玉"));
  assert.ok(text.includes("小林"));
});

test("load/saveLedger：落盘与容错（文件不存在/损坏）", () => {
  const dir = mkdtempSync(join(tmpdir(), "rph-ledger-"));
  try {
    assert.equal(loadLedger(dir).characters.length, 0); // 无文件
    const l = emptyLedger();
    l.notes = [{ key: "n1", content: "测试" }];
    saveLedger(dir, l);
    const reloaded = loadLedger(dir);
    assert.equal(reloaded.notes.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
