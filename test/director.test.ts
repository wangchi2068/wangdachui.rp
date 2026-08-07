import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Director } from "../src/director/director.ts";
import { MAIN_ARC } from "../src/director/arc.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "rph-dir-"));
}

test("导演：初始在第一幕·觉醒，directive 含当前目标", () => {
  const dir = freshDir();
  try {
    const d = new Director(dir);
    assert.equal(d.currentPhase().id, "p1-awakening");
    const directive = d.buildDirective();
    assert.ok(directive.includes("第一幕"));
    assert.ok(directive.includes("当前目标"));
    assert.ok(!directive.includes("主线事件")); // 初始无事件
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("导演：关键词命中 + 回合门槛达标才推进；事件钩子只注入一次", () => {
  const dir = freshDir();
  try {
    const d = new Director(dir);
    // 无关键词命中：即使回合数达标也不推进
    assert.equal(d.advance("今天天气不错，我们去喝碗豆花吧", 3).advanced, false);
    // 回合数达标且命中 → 推进到 p2
    const r = d.advance("我走进了便利店，老板娘苏涟漪递给我一杯符水", 3);
    assert.equal(r.advanced, true);
    assert.equal(r.to?.id, "p2-meet");
    // 事件钩子消费一次
    const d1 = d.buildDirective();
    assert.ok(d1.includes("主线事件"));
    const d2 = d.buildDirective();
    assert.ok(!d2.includes("主线事件"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("导演：终局阶段不再推进；状态持久化", () => {
  const dir = freshDir();
  try {
    const d = new Director(dir);
    // 直接推进到终局（用足够的回合与关键词链）
    let guard = 0;
    while (d.currentPhase().id !== MAIN_ARC[MAIN_ARC.length - 1]!.id && guard++ < 20) {
      const p = d.currentPhase();
      const kw = p.unlockKeywords[0] ?? "抉择";
      d.advance("剧情中提到" + kw + "相关的内容，继续深入调查灵气井和王总", p.minTurns + 1);
    }
    assert.equal(d.currentPhase().id, MAIN_ARC[MAIN_ARC.length - 1]!.id);
    assert.equal(d.advance("任何内容", 999).advanced, false); // 终局不再推进

    // 持久化：新实例从磁盘恢复
    const d2 = new Director(dir);
    assert.equal(d2.currentPhase().id, MAIN_ARC[MAIN_ARC.length - 1]!.id);
    const persisted = JSON.parse(readFileSync(join(dir, "director.json"), "utf8"));
    assert.ok(persisted.unlocked.length >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("导演：reset 回到第一幕", () => {
  const dir = freshDir();
  try {
    const d = new Director(dir);
    d.advance("便利店老板娘苏涟漪的账本和机房", 5);
    assert.notEqual(d.currentPhase().id, "p1-awakening");
    d.reset();
    assert.equal(d.currentPhase().id, "p1-awakening");
    const d2 = new Director(dir);
    assert.equal(d2.currentPhase().id, "p1-awakening");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
