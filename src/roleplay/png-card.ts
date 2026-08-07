import { parseCard, type CharacterCard } from "./character-card.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngTextChunk {
  keyword: string;
  text: string;
}

/**
 * 手写 PNG 结构解析：遍历 chunk（length + type + data + CRC），
 * 提取 tEXt 块（keyword\0text）。tEXt 不压缩，无需 zlib。
 * 只解析不校验 CRC——坏图也能尽力提取角色卡。
 */
export function extractTextChunks(png: Buffer): PngTextChunk[] {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return [];
  const chunks: PngTextChunk[] = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd > png.length) break; // 数据不完整，停止
    if (type === "tEXt") {
      const data = png.subarray(dataStart, dataEnd);
      const nul = data.indexOf(0);
      if (nul >= 0) {
        chunks.push({
          keyword: data.subarray(0, nul).toString("latin1"),
          text: data.subarray(nul + 1).toString("utf8"),
        });
      }
    }
    offset = dataEnd + 4; // 跳过 CRC
  }
  return chunks;
}

/**
 * 从 PNG 角色卡提取内嵌 JSON 并解析。
 * 兼容 SillyTavern 生态的两种埋点：
 *  - "chara" / "character" / "v2"：直接 JSON（v1 / v2 扁平）
 *  - "ccv3"：base64 编码的 JSON（v3）
 */
export function parsePngCard(png: Buffer): CharacterCard | null {
  for (const { keyword, text } of extractTextChunks(png)) {
    if (keyword === "ccv3") {
      try {
        const raw = JSON.parse(Buffer.from(text, "base64").toString("utf8"));
        const card = parseCard(raw);
        if (card) return card;
      } catch {
        /* 尝试下一个 chunk */
      }
    }
    if (keyword === "chara" || keyword === "character" || keyword === "v2") {
      try {
        const card = parseCard(JSON.parse(text));
        if (card) return card;
      } catch {
        /* 尝试下一个 chunk */
      }
    }
  }
  return null;
}
