/**
 * RP-Harness Web 服务：手写 WebSocket（RFC6455）+ Node http 静态托管 + REST API。
 * 零第三方依赖：Node 内置 http/fetch/WebSocket 客户端 + 手写协议层。
 *
 * 启动：npm run web  →  http://127.0.0.1:7620
 */
import { createServer, type IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { LlmClient, type ChatMessage } from "./llm/client.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { registerBuiltinTools } from "./tools/builtin.ts";
import { registerDecisionTool, type DecisionCard } from "./harness/decision-card.ts";
import { Harness } from "./harness/harness.ts";
import { LedgerService, snapshotText } from "./harness/memory-ledger.ts";
import { ContextManager } from "./harness/context.ts";
import { parseCard, type CharacterCard } from "./roleplay/character-card.ts";
import { activateLore } from "./roleplay/lorebook.ts";
import { buildSystemPrompt } from "./roleplay/assemble.ts";

const PORT = Number(process.env.LIYUAN_PORT ?? 7620);
const root = process.cwd();
const cfg = loadConfig();
if (!cfg.apiKey) {
  console.error("缺少 LIYUAN_API_KEY：请检查 .env 文件");
  process.exit(1);
}

const client = new LlmClient(cfg);
const registry = new ToolRegistry({ stateDir: cfg.stateDir });
registerBuiltinTools(registry, { stateDir: cfg.stateDir });
registerDecisionTool(registry);
const harness = new Harness(client, registry, cfg);
const ledgerService = new LedgerService(client, cfg.stateDir);

let card: CharacterCard | null = loadDefaultCard();
let ctx = new ContextManager(client, cfg);
let lastContext = "";

function loadDefaultCard(): CharacterCard | null {
  const saved = resolve(root, "state/card.json");
  if (existsSync(saved)) {
    try {
      const parsed = parseCard(JSON.parse(readFileSync(saved, "utf8")));
      if (parsed) return parsed;
    } catch {
      /* 损坏则回退示例卡 */
    }
  }
  const example = resolve(root, "assets/cards/libai.json");
  if (existsSync(example)) {
    try {
      return parseCard(JSON.parse(readFileSync(example, "utf8")));
    } catch {
      return null;
    }
  }
  return null;
}

function buildSystem(): string {
  if (!card) return "（尚未导入角色卡）";
  return buildSystemPrompt({
    card,
    lore: activateLore(card.characterBook ?? [], lastContext),
    ledgerSnapshot: snapshotText(ledgerService.load()),
    extraRules: "用第一人称扮演角色，保持人设；遇到重大剧情转折时用 decide 工具把候选方向做成卡片询问用户，不要滥用。",
  });
}

function collectState() {
  const ledger = ledgerService.load();
  return {
    cardName: card?.name ?? null,
    model: cfg.model,
    budgetChars: cfg.contextBudgetChars,
    ledger,
    summary: ctx.summaryText,
    windowTurns: ctx.windowSize,
    totalTurns: ctx.totalTurns,
    turns: ctx.allTurns.slice(-6).map((t) => ({ user: t.userInput, messages: t.messages })),
  };
}

/* ─────────────── HTTP ─────────────── */

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(resolve(root, "web/index.html")));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(collectState()));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/card") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed: CharacterCard | null = null;
      try {
        parsed = parseCard(JSON.parse(body));
      } catch {
        parsed = null;
      }
      if (!parsed) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "角色卡解析失败：请上传有效的 SillyTavern JSON 角色卡" }));
        return;
      }
      card = parsed;
      mkdirSync(cfg.stateDir, { recursive: true });
      writeFileSync(resolve(cfg.stateDir, "card.json"), JSON.stringify(parsed), "utf8");
      ctx = new ContextManager(client, cfg); // 换卡 = 新会话
      lastContext = "";
      if (card.firstMes) {
        await ctx.endTurn({
          systemText: buildSystem(),
          userInput: "",
          added: [{ role: "assistant", content: card.firstMes }],
        });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: card.name, firstMes: card.firstMes ?? "" }));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
});

/* ─────────────── WebSocket（手写 RFC6455） ─────────────── */

interface Connection {
  socket: Socket;
  send(obj: unknown): void;
}

const connections = new Set<Socket>();
let pendingDecision: { resolve: (choice: string) => void } | null = null;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function sendFrame(socket: Socket, opcode: number, payload: Buffer): void {
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

/** 增量解析客户端帧（支持 126/127 长度与掩码；text/continuation/close/ping） */
function frameParser(socket: Socket, onText: (s: string) => void, onClose: () => void): void {
  let buffer = Buffer.alloc(0);
  let textAccum = "";
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const b0 = buffer[0];
      const opcode = b0 & 0x0f;
      const b1 = buffer[1];
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let maskKey: Buffer | null = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + len) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + len));
      buffer = buffer.subarray(offset + len);
      if (maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }
      if (opcode === 0x8) {
        socket.end();
        onClose();
        return;
      }
      if (opcode === 0x9) {
        sendFrame(socket, 0xa, payload); // ping → pong
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        textAccum += payload.toString("utf8");
        if (b0 & 0x80) {
          onText(textAccum);
          textAccum = "";
        }
      }
    }
  });
}

server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
  const key = req.headers["sec-websocket-key"];
  if (req.url !== "/ws" || typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
      accept +
      "\r\n\r\n",
  );
  const conn: Connection = {
    socket,
    send: (obj) => {
      if (!socket.destroyed) sendFrame(socket, 0x1, Buffer.from(JSON.stringify(obj), "utf8"));
    },
  };
  connections.add(socket);
  conn.send({ type: "init", state: collectState() });
  frameParser(
    socket,
    (data) => {
      let msg: { type?: string; text?: string };
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.type === "chat" && typeof msg.text === "string") void handleChat(conn, msg.text);
      if (msg.type === "choice" && typeof msg.text === "string" && pendingDecision) {
        const p = pendingDecision;
        pendingDecision = null;
        p.resolve(msg.text);
      }
    },
    () => connections.delete(socket),
  );
  socket.on("close", () => {
    connections.delete(socket);
    pendingDecision = null;
  });
});

async function handleChat(conn: Connection, text: string): Promise<void> {
  if (!card) {
    conn.send({ type: "error", message: "请先导入角色卡" });
    return;
  }
  try {
    lastContext = text;
    const system = buildSystem();
    const visible = ctx.visibleMessages(system, text);
    const result = await harness.runTurn(visible, {
      onNarrativeDelta: (d) => conn.send({ type: "delta", text: d }),
      onDecisionRequested: (cardData: DecisionCard) =>
        new Promise<string>((resolve) => {
          pendingDecision = { resolve };
          conn.send({ type: "card", card: cardData });
        }),
    });
    if (result.stoppedBy === "max-turns") conn.send({ type: "warn", message: "达到循环上限，本轮未产出正文" });
    conn.send({
      type: "turn_done",
      stats: { modelCalls: result.modelCalls, stoppedBy: result.stoppedBy, tools: result.tools, decisions: result.decisions },
    });
    const prune = await ctx.endTurn({ systemText: system, userInput: text, added: result.added });
    const up = await ledgerService.updateAfterTurn({ characterName: card.name, userInput: text, narrative: result.content });
    lastContext = `${text}\n${result.content}`;
    conn.send({ type: "state", state: collectState(), prune, ledgerUpdate: up });
  } catch (e) {
    conn.send({ type: "error", message: (e as Error).message });
  }
}

server.listen(PORT, () => {
  console.log(`✦ RP-Harness 已启动：http://127.0.0.1:${PORT}`);
  console.log(`  模型：${cfg.model} | 角色卡：${card?.name ?? "无"}`);
});
