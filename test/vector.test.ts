import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalize,
  ngram,
  buildDf,
  tfidfVector,
  cosine,
  VectorIndex,
} from "../src/roleplay/vector.ts";

test("normalize：剔除非汉字/数字/字母，转小写", () => {
  assert.equal(normalize("Hello 都市！仙修??"), "hello都市仙修");
  assert.equal(normalize("苏涟漪：只收功德点"), "苏涟漪只收功德点");
});

test("ngram：bigram 切分正确，短文本退化", () => {
  assert.deepEqual(ngram("都市修仙"), ["都市", "市修", "修仙"]);
  assert.deepEqual(ngram("玄一"), ["玄一"]);
  assert.deepEqual(ngram(""), []);
  assert.deepEqual(ngram("a", 1), ["a"]);
});

test("cosine：相同向量=1，正交=0，部分重叠居中", () => {
  const df = buildDf(["都市修仙", "都市生活", "灵气复苏"]);
  const v1 = tfidfVector("都市修仙", df, 3);
  const v2 = tfidfVector("都市修仙", df, 3);
  assert.ok(Math.abs(cosine(v1, v2) - 1) < 1e-9);
  const v3 = tfidfVector("灵气复苏", df, 3);
  assert.ok(cosine(v1, v3) >= 0);
  assert.ok(cosine(v1, v3) < cosine(v1, v2));
});

test("VectorIndex：语义近似命中（不出现关键词也能召回）", () => {
  const docs = [
    "苏涟漪：楼下便利店老板娘，只收功德点不收钱，账本记着半个城修仙者的命",
    "妖狐小九：白天送外卖，晚上卖情报",
    "王总：天工科技老板，说了句怪话：你工位底下埋着的东西你知道吗",
  ];
  const idx = new VectorIndex(docs);
  // 剧情只说“便利店老板娘”，未出现“苏涟漪”关键词，仍应召回第 0 篇
  const hits = idx.query("楼下便利店老板娘只收功德点不要钱", 1);
  assert.ok(hits.length > 0);
  const h0 = hits[0];
  assert.ok(h0, "应召回第 0 篇");
  assert.equal(h0.index, 0);
  assert.ok(h0.score > 0);

  const hit2 = idx.query("外卖小哥白天跑腿晚上打听消息", 1);
  assert.ok(hit2.length > 0);
  const h1 = hit2[0];
  assert.ok(h1, "应召回第 1 篇");
  assert.equal(h1.index, 1);
});

test("VectorIndex：topK 数量与降序", () => {
  const idx = new VectorIndex(["甲乙丙", "甲", "丁戊"]);
  const hits = idx.query("甲乙", 2);
  assert.equal(hits.length, 2);
  const [a, b] = hits;
  assert.ok(a && b);
  assert.ok(a.score >= b.score);
  assert.equal(idx.size, 3);
});

test("VectorIndex：空语料安全", () => {
  const idx = new VectorIndex([]);
  assert.deepEqual(idx.query("任意"), []);
});