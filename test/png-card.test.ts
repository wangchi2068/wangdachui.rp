import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { parsePngCard, extractTextChunks } from "../src/roleplay/png-card.ts";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 构造一个带 tEXt chunk 的最小合法 PNG（IHDR 13 字节 + tEXt + IEND） */
function makePngWithText(keyword: string, text: string): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const tEXtData = Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(text, "utf8")]);
  return Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("tEXt", tEXtData), chunk("IEND", Buffer.alloc(0))]);
}

const V2_CARD = {
  spec: "chara_card_v2",
  data: {
    name: "玄一",
    description: "上古剑仙",
    personality: "毒舌",
    scenario: "都市",
    first_mes: "本座醒了",
    mes_example: "",
  },
};

test("extractTextChunks：提取 tEXt 的 keyword 与文本", () => {
  const png = makePngWithText("chara", JSON.stringify(V2_CARD));
  const chunks = extractTextChunks(png);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.keyword, "chara");
  assert.ok(chunks[0]!.text.includes("玄一"));
});

test("parsePngCard：chara 关键词直接 JSON（v2 卡）", () => {
  const png = makePngWithText("chara", JSON.stringify(V2_CARD));
  const card = parsePngCard(png);
  assert.ok(card);
  assert.equal(card!.name, "玄一");
  assert.equal(card!.firstMes, "本座醒了");
});

test("parsePngCard：ccv3 关键词 base64 编码", () => {
  const b64 = Buffer.from(JSON.stringify(V2_CARD), "utf8").toString("base64");
  const png = makePngWithText("ccv3", b64);
  const card = parsePngCard(png);
  assert.ok(card);
  assert.equal(card!.name, "玄一");
});

test("parsePngCard：非 PNG / 无卡 chunk → null", () => {
  assert.equal(parsePngCard(Buffer.from("not a png")), null);
  const png = makePngWithText("Software", "GIMP");
  assert.equal(parsePngCard(png), null);
});
