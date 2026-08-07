import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLoreEntries,
  activateLore,
  activateLoreHybrid,
  type LorebookEntry,
} from "../src/roleplay/lorebook.ts";

function entry(partial: Partial<LorebookEntry>): LorebookEntry {
  return {
    keys: [],
    content: "",
    constant: false,
    enabled: true,
    insertionOrder: 0,
    ...partial,
  };
}

test("activateLore：语义补充（剧情不出现关键词也能命中相关条目）", () => {
  const entries = [
    entry({ keys: ["苏涟漪"], content: "便利店老板娘苏涟漪，只收功德点", insertionOrder: 0 }),
    entry({ keys: ["小九"], content: "妖狐小九，白天送外卖", insertionOrder: 1 }),
    entry({ keys: ["王总"], content: "王总：天工科技老板", insertionOrder: 2 }),
  ];
  // 关键词：剧情含“苏涟漪”→ 精确命中；不含“王总”但说“老板”→ 向量应把它补进来
  const result = activateLoreHybrid(entries, "苏涟漪让便利店老板娘给她留了份符水奶茶", 8, 4);
  const contents = result.entries.map((e) => e.content);
  assert.ok(contents.some((c) => c.includes("苏涟漪")), "关键词命中的苏涟漪在");
  // 向量应把“王总·老板”召回（“老板”与“老板娘”共享 bigram），虽然没出现关键词
  assert.ok(contents.some((c) => c.includes("王总")), "语义相关（老板/老板娘）应被向量补充");
});

test("activateLoreHybrid：rank 标注来源与去重", () => {
  const entries = [
    entry({ keys: ["苏涟漪"], content: "内容甲：苏涟漪", insertionOrder: 0 }),
    entry({ keys: ["王总"], content: "内容乙：王总之怪话", insertionOrder: 1 }),
    entry({ keys: [], content: "内容丙：老板娘功德点账本", insertionOrder: 2 }),
  ];
  const { entries: activated, rank } = activateLoreHybrid(entries, "苏涟漪提到王总的怪话", 8, 4);
  assert.equal(activated.length, rank.length);
  const kw = rank.filter((r) => r === "keyword").length;
  const vec = rank.filter((r) => r === "vector").length;
  // 苏涟漪+王总为关键词命中
  assert.ok(kw >= 2);
  // 至少补了 1 条向量召回（“老板娘”相关的内容丙），且不重复
  assert.ok(vec >= 1);
  const uniq = new Set(activated);
  assert.equal(uniq.size, activated.length, "不应出现重复条目");
});

test("activateLore：旧签名仍可用（纯关键词转混合）", () => {
  const entries = [
    entry({ keys: ["苏涟漪"], content: "苏涟漪条目", insertionOrder: 0 }),
    entry({ keys: ["其他"], content: "无关条目", insertionOrder: 1 }),
  ];
  const hit = activateLore(entries, "今天碰到苏涟漪了", 4);
  // 关键词命中的苏涟漪必须在且排第一
  assert.ok(hit.length >= 1);
  const first = hit[0];
  assert.ok(first, "至少命中一条");
  assert.equal(first.content, "苏涟漪条目");
});

test("activateLore：常驻条目恒在，总量被 max 封顶", () => {
  const entries = [
    entry({ constant: true, keys: [], content: "常驻世界观" }),
    entry({ keys: ["甲"], content: "甲条目" }),
    entry({ keys: ["乙"], content: "乙条目" }),
    entry({ keys: ["丙"], content: "丙条目" }),
    entry({ keys: ["丁"], content: "丁条目" }),
  ];
  // 关键词全中但 max=3：常驻占 1 + 升序前 2（甲乙），总量 3，向量无剩余名额
  const hit = activateLore(entries, "甲乙丙丁", 3);
  assert.equal(hit.length, 3);
  const [c0, c1, c2] = hit;
  assert.ok(c0 && c1 && c2);
  assert.equal(c0.content, "常驻世界观");
  assert.equal(c1.content, "甲条目");
  assert.equal(c2.content, "乙条目");
});

test("parseLoreEntries：容错与字段归一", () => {
  const raw = [
    { keys: ["A"], content: "x", constant: true, insertion_order: 7 },
    { keys: 123, content: "y" }, // 非法 keys 过滤
    { content: "" }, // 空内容跳过
    { not: "object" } as unknown,
  ];
  const es = parseLoreEntries(raw);
  assert.equal(es.length, 2);
  const e0 = es[0];
  const e1 = es[1];
  assert.ok(e0 && e1);
  assert.equal(e0.constant, true);
  assert.equal(e0.insertionOrder, 7);
  assert.deepEqual(e1.keys, []);
});