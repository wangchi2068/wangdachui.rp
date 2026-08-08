import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Director } from "../src/director/director.ts";
import { MAIN_ARC, type Phase } from "../src/director/arc.ts";

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
    assert.ok(directive.includes("主线事件"), "事件钩子常驻注入，第一幕也有钩子");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("导演：关键词命中 + 回合门槛达标才推进；事件钩子常驻注入", () => {
  const dir = freshDir();
  try {
    const d = new Director(dir);
    // 无关键词命中：即使回合数达标也不推进
    assert.equal(d.advance("今天天气不错，我们去喝碗豆花吧", 3).advanced, false);
    // 回合数达标且命中 → 推进到 p2
    const r = d.advance("我走进了便利店，老板娘苏涟漪递给我一杯符水", 3);
    assert.equal(r.advanced, true);
    assert.equal(r.to?.id, "p2-meet");
    // 事件钩子常驻：多次调用每次都出现（作为持续主线锚）
    const d1 = d.buildDirective();
    assert.ok(d1.includes("主线事件"));
    const d2 = d.buildDirective();
    assert.ok(d2.includes("主线事件"), "事件钩子应常驻注入（当前幕每回合可见）");
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

test("导演：自定义 arc（战役包）——初始用 arc[0]，推进按战役关键词", () => {
  const dir = freshDir();
  try {
    const lotmArc: Phase[] = [
      { id: "m1-awakening", act: 1, title: "第一幕·穿越者", summary: "", objectives: ["弄明白穿越"], unlockKeywords: ["罗塞尔", "灰雾"], minTurns: 1 },
      { id: "m2-seance", act: 1, title: "第二幕·通灵会", summary: "", objectives: ["参加通灵会"], unlockKeywords: ["通灵会"], minTurns: 1 },
    ];
    const d = new Director(dir, lotmArc);
    assert.equal(d.currentPhase().id, "m1-awakening");
    const r = d.advance("你翻开罗塞尔日记，眼前掠过灰雾", 2);
    assert.equal(r.advanced, true);
    assert.equal(d.currentPhase().id, "m2-seance");
    const directive = d.buildDirective();
    assert.ok(directive.includes("通灵会"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("导演：防连跳——间隔不足 2 回合不推进", () => {
  const dir = freshDir();
  try {
    const arc: Phase[] = [
      { id: "a", act: 1, title: "幕A", summary: "", objectives: [], unlockKeywords: ["x"], minTurns: 1 },
      { id: "b", act: 1, title: "幕B", summary: "", objectives: [], unlockKeywords: ["x"], minTurns: 1 },
      { id: "c", act: 1, title: "幕C", summary: "", objectives: [], unlockKeywords: ["x"], minTurns: 1 },
    ];
    const d = new Director(dir, arc);
    // 回合1：推进到 B
    assert.equal(d.advance("x", 1).advanced, true);
    // 回合1 再次调用：间隔 0 < 2，不推进
    assert.equal(d.advance("x", 1).advanced, false);
    // 回合2：间隔 1 < 2，仍不推进
    assert.equal(d.advance("x", 2).advanced, false);
    // 回合3：间隔 2 >= 2，推进到 C
    assert.equal(d.advance("x", 3).advanced, true);
    assert.equal(d.currentPhase().id, "c");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
