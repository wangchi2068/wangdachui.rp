import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCard } from "../src/roleplay/character-card.ts";
import { parseLorebook, activateLore, parseLoreEntries } from "../src/roleplay/lorebook.ts";

test("角色卡：v2 格式（data 包裹）解析", () => {
  const card = parseCard({
    spec: "chara_card_v2",
    data: {
      name: "玄一",
      description: "上古剑仙",
      personality: "毒舌",
      scenario: "都市",
      first_mes: "你好",
      mes_example: "<START>\n{{user}}: 嗨\n{{char}}: 哼",
      character_book: { entries: [{ keys: [], content: "常驻设定", constant: true }] },
    },
  });
  assert.ok(card);
  assert.equal(card!.name, "玄一");
  assert.equal(card!.firstMes, "你好");
  assert.equal(card!.characterBook?.length, 1);
});

test("角色卡：v1 格式（character 包裹）与扁平格式解析", () => {
  const v1 = parseCard({ character: { name: "老张", description: "x", personality: "", scenario: "", first_mes: "", mes_example: "" } });
  assert.equal(v1!.name, "老张");
  const flat = parseCard({ name: "李四", description: "", personality: "", scenario: "", first_mes: "", mes_example: "" });
  assert.equal(flat!.name, "李四");
});

test("角色卡：缺字段容错与非法输入", () => {
  assert.equal(parseCard(null), null);
  assert.equal(parseCard("string"), null);
  const bare = parseCard({ name: "无名" });
  assert.equal(bare!.name, "无名");
  assert.equal(bare!.description, "");
});

test("世界书：解析 + 常驻/关键词激活", () => {
  const entries = parseLoreEntries([
    { keys: [], content: "常驻A", constant: true },
    { keys: ["便利店"], content: "便利店设定", constant: false },
    { keys: ["妖狐"], content: "妖狐设定", constant: false },
    { content: "无 keys 的非常驻（不应激活）", constant: false },
  ]);
  assert.equal(entries.length, 4);

  const active = activateLore(entries, "楼下的便利店亮了蓝灯");
  assert.deepEqual(active.map((e) => e.content), ["常驻A", "便利店设定"]);

  const none = activateLore(entries, "今天天气不错");
  assert.deepEqual(none.map((e) => e.content), ["常驻A"]);
});

test("世界书：独立文件外层结构 {entries} 与 {data:{entries}}", () => {
  assert.equal(parseLorebook({ entries: [{ keys: [], content: "a", constant: true }] }).length, 1);
  assert.equal(parseLorebook({ data: { entries: [{ keys: [], content: "b", constant: false }] } }).length, 1);
});
