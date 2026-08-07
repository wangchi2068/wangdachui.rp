/**
 * RP-Harness Web 服务：手写 WebSocket（RFC6455）+ Node http 静态托管 + REST API。
 * 零第三方依赖：Node 内置 http/fetch/WebSocket 客户端 + 手写协议层。
 *
 * 启动：npm run web  →  http://127.0.0.1:7620
 */
import { createServer, type IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { LlmClient, type ChatMessage } from "./llm/client.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { registerBuiltinTools } from "./tools/builtin.ts";
import { registerDecisionTool, type DecisionCard } from "./harness/decision-card.ts";
import { Harness } from "./harness/harness.ts";
import { LedgerService, snapshotText } from "./harness/memory-ledger.ts";
import { ContextManager, estimateChars } from "./harness/context.ts";
import { createSnapshot, deleteSnapshot, listSnapshots, restoreSnapshot } from "./harness/worldline.ts";
import { Director } from "./director/director.ts";
import type { Phase } from "./director/arc.ts";
import { parseCard, type CharacterCard } from "./roleplay/character-card.ts";
import { parsePngCard } from "./roleplay/png-card.ts";
import { activateLoreHybrid, parseLorebook, type LorebookEntry } from "./roleplay/lorebook.ts";
import { VectorIndex } from "./roleplay/vector.ts";
import { buildSystemPrompt } from "./roleplay/assemble.ts";

const PORT = Number(process.env.LIYUAN_PORT ?? 7620);
const root = process.cwd();
const cfg = loadConfig();
if (!cfg.apiKey) {
  console.error("缺少 LIYUAN_API_KEY：请检查 .env 文件");
  process.exit(1);
}

/** 战役包目录：LIYUAN_CAMPAIGN=lotm → assets/campaigns/lotm/（不存在则返回 null） */
function campaignDir(): string | null {
  if (!cfg.campaign) return null;
  const dir = resolve(root, "assets/campaigns", cfg.campaign);
  return existsSync(dir) ? dir : null;
}

const client = new LlmClient(cfg);
const registry = new ToolRegistry({ stateDir: cfg.stateDir });
registerBuiltinTools(registry, { stateDir: cfg.stateDir });
registerDecisionTool(registry);
const harness = new Harness(client, registry, cfg);
const ledgerService = new LedgerService(client, cfg.stateDir, cfg.scribeModel);

let card: CharacterCard | null = loadDefaultCard();
let ctx = new ContextManager(client, cfg);
/** 战役主线：campaign/arc.json 的 phases 数组（无战役/无 arc.json 时返回 undefined → 用默认三幕） */
function loadCampaignArc(): Phase[] | undefined {
  const camp = campaignDir();
  if (!camp) return undefined;
  const arcFile = resolve(camp, "arc.json");
  if (!existsSync(arcFile)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(arcFile, "utf8")) as { phases?: Phase[] };
    return Array.isArray(raw.phases) && raw.phases.length ? (raw.phases as Phase[]) : undefined;
  } catch {
    return undefined;
  }
}

let director = new Director(cfg.stateDir, loadCampaignArc());
let lastContext = "";

/** 把当前生效角色卡持久化（仅在上传/回档后调用；默认卡以 assets 为兜底，不落盘） */
function persistCurrentCard(): void {
  if (!card) return;
  mkdirSync(cfg.stateDir, { recursive: true });
  writeFileSync(resolve(cfg.stateDir, "card.json"), JSON.stringify(card), "utf8");
}

/** 全新对话/换卡：清空对话记忆、主线、账本与决策留痕（角色卡与世界书保留） */
function resetWorld(): void {
  ctx.reset();
  director.reset();
  lastContext = "";
  for (const f of ["ledger.json", "decisions.jsonl"]) {
    try {
      rmSync(resolve(cfg.stateDir, f), { force: true });
    } catch {
      /* 文件不存在则跳过 */
    }
  }
}

function loadDefaultCard(): CharacterCard | null {
  // 战役模式：优先读 campaign 目录下的 card-*.json
  const camp = campaignDir();
  if (camp) {
    for (const f of readdirSync(camp)) {
      if (!f.startsWith("card-") || !f.endsWith(".json")) continue;
      try {
        const parsed = parseCard(JSON.parse(readFileSync(resolve(camp, f), "utf8")));
        if (parsed) return parsed;
      } catch {
        /* 跳过损坏的战役卡 */
      }
    }
    console.warn(`[campaign] ${cfg.campaign} 下未找到 card-*.json，回退默认卡`);
  }
  const saved = resolve(root, "state/card.json");
  if (existsSync(saved)) {
    try {
      const parsed = parseCard(JSON.parse(readFileSync(saved, "utf8")));
      if (parsed) return parsed;
    } catch {
      /* 损坏则回退示例卡 */
    }
  }
  const example = resolve(root, "assets/cards/xiuxian.json");
  if (existsSync(example)) {
    try {
      return parseCard(JSON.parse(readFileSync(example, "utf8")));
    } catch {
      return null;
    }
  }
  return null;
}

/* ─────────── 对话导出（md / Word 兼容 HTML）─────────── */

interface HistoryTurn {
  id?: string;
  at?: string;
  userInput?: string;
  messages?: { role: string; content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] }[];
}

/** 读取 state/history.jsonl → 结构化回合数组 */
function loadHistoryTurns(): HistoryTurn[] {
  const f = resolve(cfg.stateDir, "history.jsonl");
  if (!existsSync(f)) return [];
  const turns: HistoryTurn[] = [];
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      turns.push(JSON.parse(line) as HistoryTurn);
    } catch {
      /* 跳过损坏行 */
    }
  }
  return turns;
}

/** 组装 Markdown 对话记录（标题 + 逐回合：用户 → 剧情正文 + 工具缩进） */
function buildExportMarkdown(): string {
  const cardName = card?.name ?? "（未导入角色卡）";
  const lines: string[] = [
    `# RP-Harness 对话记录`,
    ``,
    `> 角色：${cardName}`,
    `> 导出时间：${new Date().toLocaleString("zh-CN")}`,
    `> 主线：${director.summary().title}`,
    ``,
    `---`,
    ``,
  ];
  for (const t of loadHistoryTurns()) {
    if (t.userInput && t.userInput.trim()) {
      lines.push(`## 🧑 玩家：${t.userInput.trim()}`, ``);
    }
    for (const m of t.messages ?? []) {
      if (m.role === "assistant" && m.content) {
        lines.push(m.content.trim(), ``);
      } else if (m.role === "assistant" && m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          const name = tc.function?.name ?? "工具";
          let args = "";
          try {
            args = JSON.stringify(JSON.parse(tc.function?.arguments ?? "{}"), null, 1) ?? "";
          } catch {
            args = tc.function?.arguments ?? "";
          }
          lines.push(`<details><summary>⚙ ${name}</summary>\n\n\`\`\`json\n${args}\n\`\`\`\n</details>`, ``);
        }
      } else if (m.role === "tool" && m.content) {
        lines.push(`> 🔧 ${String(m.content).slice(0, 200).replace(/\n+/g, " ")}`, ``);
      }
    }
    lines.push(`---`, ``);
  }
  return lines.join("\n");
}

/** Word 兼容 HTML（.doc 扩展，Word/ WPS 可直接打开）：内容与 md 一致，加最小排版 */
function buildExportWordHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = md
    .split(/\n{2,}/)
    .map((block) => {
      const b = block.trim();
      if (!b) return "";
      if (b.startsWith("# ")) return `<h1>${esc(b.slice(2))}</h1>`;
      if (b.startsWith("## ")) return `<h2>${esc(b.slice(3))}</h2>`;
      if (b.startsWith("> ")) return `<blockquote>${esc(b.slice(2))}</blockquote>`;
      if (b === "---") return `<hr>`;
      if (b.startsWith("<details>")) return `<p style="color:#666;font-size:12px;">${esc(b).slice(0, 300)}</p>`;
      return `<p style="white-space:pre-wrap;line-height:1.7;">${esc(b)}</p>`;
    })
    .join("\n");
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>RP-Harness 对话记录</title></head><body style="font-family:'Microsoft YaHei',sans-serif;max-width:760px;margin:24px auto;color:#222;">${body}</body></html>`;
}

function buildSystem(): string {
  if (!card) return "（尚未导入角色卡）";
  const lore = activateLoreHybrid(allLoreEntries(), lastContext, 8, 4);
  const blocks = [
    buildSystemPrompt({
      card,
      lore: lore.entries,
      ledgerSnapshot: snapshotText(ledgerService.load()),
      extraRules: buildExtraRules(),
    }),
  ];
  const directive = director.buildDirective();
  if (directive) blocks.push(directive);
  return blocks.join("\n\n");
}

/** 动态补充规则：根据玩家上一条输入形态注入针对性指引（短输入/走偏处理） */
function buildExtraRules(): string {
  const rules = ["用第一人称扮演角色，保持人设；遇到重大剧情转折时用 decide 工具把候选方向做成卡片询问用户，不要滥用。"];
  const last = (lastContext || "").trim();
  // 短输入（<=12 字且不含标点长句）：注入兜底指引，AI 自动推进并给可选行动
  if (last.length > 0 && last.length <= 12) {
    rules.push(
      "【短输入指引】玩家上一条输入很简短（可能只是'继续/嗯/看看'）。不要反问玩家想做什么：按克莱恩谨慎理性的人设自动推进剧情一小步，并在回复结尾用【你可以…】列出 2-3 个具体可选行动（每个 1-2 个短句），玩家回一个字或序号即可继续。",
    );
  }
  // 玩家明确拒绝/走偏：提示后果真实但主线会拉回
  if (/拒绝|不去|算了|不干|不要|走开|离开|不想/.test(last)) {
    rules.push(
      "【偏离处理】玩家可能拒绝了某个邀约/线索。后果要真实（对方失望、线索关闭、处境更险），但关键剧情节点不能被跳过：用世界因果让关键事件以另一种方式再次找上玩家（如被邪教盯上→被迫求助；镜子作祟→不得不查）。永远给玩家重新选择的机会。",
    );
  }
  return rules.join("\n");
}

/** 汇总可用的世界书条目：卡内嵌 book + 战役 worldbook.json（战役模式）或 assets/lorebooks/*.json */
function allLoreEntries(): LorebookEntry[] {
  const fromCard = card?.characterBook ?? [];
  const fromFiles: LorebookEntry[] = [];
  const camp = campaignDir();
  if (camp) {
    // 战役模式：只读 campaign/worldbook.json（不混入都市修仙 lorebooks）
    const wb = resolve(camp, "worldbook.json");
    if (existsSync(wb)) {
      try {
        fromFiles.push(...parseLorebook(JSON.parse(readFileSync(wb, "utf8"))));
      } catch {
        /* 跳过损坏的世界书 */
      }
    }
    return [...fromCard, ...fromFiles];
  }
  const dir = resolve(root, "assets/lorebooks");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        fromFiles.push(...parseLorebook(JSON.parse(readFileSync(resolve(dir, f), "utf8"))));
      } catch {
        /* 跳过损坏的世界书文件 */
      }
    }
  }
  return [...fromCard, ...fromFiles];
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
    mainline: director.summary(),
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
    if (req.method === "GET" && url.pathname === "/api/export") {
      const fmt = url.searchParams.get("fmt") === "doc" ? "doc" : "md";
      const md = buildExportMarkdown();
      if (fmt === "md") {
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": 'attachment; filename="rp-dialog.md"',
        });
        res.end(md);
      } else {
        res.writeHead(200, {
          "Content-Type": "application/msword; charset=utf-8",
          "Content-Disposition": 'attachment; filename="rp-dialog.doc"',
        });
        res.end(buildExportWordHtml(md));
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/card") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed: CharacterCard | null = null;
      try {
        const bodyObj = JSON.parse(body) as { json?: unknown; pngBase64?: string };
        if (typeof bodyObj.pngBase64 === "string") {
          parsed = parsePngCard(Buffer.from(bodyObj.pngBase64, "base64"));
        } else if (bodyObj.json !== undefined) {
          parsed = parseCard(bodyObj.json);
        } else {
          parsed = parseCard(bodyObj); // 直接贴角色卡 JSON
        }
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
      resetWorld(); // 换卡 = 新世界
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
    if (req.method === "GET" && url.pathname === "/api/snapshots") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(listSnapshots(cfg.stateDir)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/snapshot") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const label = (() => {
        try {
          const b = JSON.parse(body) as { label?: string };
          return typeof b.label === "string" ? b.label : undefined;
        } catch {
          return undefined;
        }
      })();
      const snap = createSnapshot(cfg.stateDir, label);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, id: snap.id, at: snap.at }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/restore") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let id = "";
      try {
        id = String((JSON.parse(body) as { id?: unknown }).id ?? "");
      } catch {
        id = "";
      }
      if (!id) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "缺少快照 id" }));
        return;
      }
      // 回档前自动留档，防手滑
      createSnapshot(cfg.stateDir, "回档前自动存档");
      const result = restoreSnapshot(cfg.stateDir, id);
      if (!result.ok) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: result.error }));
        return;
      }
      // 重建内存态：上下文管理器（回合/摘要）与角色卡都从磁盘重新加载
      ctx = new ContextManager(client, cfg);
      director = new Director(cfg.stateDir, loadCampaignArc()); // 主线进度随快照回档
      card = loadDefaultCard();
      persistCurrentCard();
      lastContext = "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, at: result.at, label: result.label }));
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/snapshot/")) {
      deleteSnapshot(cfg.stateDir, decodeURIComponent(url.pathname.slice("/api/snapshot/".length)));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
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
      const b0 = buffer.readUInt8(0);
      const opcode = b0 & 0x0f;
      const b1 = buffer.readUInt8(1);
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
        for (let i = 0; i < payload.length; i++) {
          const byte = payload[i] ?? 0;
          payload[i] = byte ^ (maskKey[i & 3] ?? 0);
        }
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
  // 客户端异常断开（ECONNRESET 等）绝不能崩进程：所有 socket 一律兜底 error
  socket.on("error", (err) => {
    connections.delete(socket);
    pendingDecision = null;
  });
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
      if (msg.type === "chat" && typeof msg.text === "string") {
        // 决策卡挂起时，普通输入视为自由选择（防止"没人点卡片 → 对话卡死"）
        if (pendingDecision) {
          const p = pendingDecision;
          pendingDecision = null;
          p.resolve(msg.text);
          conn.send({ type: "warn", message: "已把你的输入作为决策卡的自由选择：" + msg.text });
        } else {
          void handleChat(conn, msg.text);
        }
      }
      if (msg.type === "command" && typeof msg.text === "string") void handleCommand(conn, msg.text);
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

// http 层的兜底：升级/请求中途断连也不崩进程
server.on("clientError", (_err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  else socket.destroy();
});

/** 斜杠命令：/help /state /snap /back /new /lore /phase */
async function handleCommand(conn: Connection, text: string): Promise<void> {
  const [rawCmd, ...rest] = text.trim().split(/\s+/);
  const cmd = (rawCmd ?? "").toLowerCase();
  const arg = rest.join(" ").trim();
  const notice = (m: string) => conn.send({ type: "notice", text: m });
  try {
    switch (cmd) {
      case "/help":
        notice("可用命令：/state 看账本 · /snap [名字] 存档 · /back [N] 列档/回档 · /new 开新会话 · /lore 词 查世界书 · /phase 主线进度 · /help");
        break;
      case "/state":
        notice(snapshotText(ledgerService.load()));
        break;
      case "/snap": {
        const s = createSnapshot(cfg.stateDir, arg || undefined);
        notice(`已存档 ${s.at.slice(0, 19)}${s.label ? `（${s.label}）` : ""}`);
        break;
      }
      case "/back": {
        const snaps = listSnapshots(cfg.stateDir);
        if (!snaps.length) {
          notice("暂无存档");
          break;
        }
        if (!arg) {
          notice(
            `共 ${snaps.length} 个存档：\n` +
              snaps.map((s, i) => `${i + 1}. ${s.label ? s.label + " · " : ""}${s.at.slice(0, 19)}`).join("\n") +
              `\n用 /back N 回档（1 = 最新）`,
          );
          break;
        }
        const n = Number(arg);
        const snap = Number.isInteger(n) && n >= 1 && n <= snaps.length ? snaps[n - 1] : undefined;
        if (!snap) {
          notice(`编号无效，共 ${snaps.length} 个存档`);
          break;
        }
        createSnapshot(cfg.stateDir, "回档前自动存档");
        const r = restoreSnapshot(cfg.stateDir, snap.id);
        if (!r.ok) {
          notice(`回档失败：${r.error}`);
          break;
        }
        ctx = new ContextManager(client, cfg);
        director = new Director(cfg.stateDir, loadCampaignArc());
        card = loadDefaultCard();
        persistCurrentCard();
        lastContext = "";
        notice(`已回档到 ${snap.at.slice(0, 19)}${snap.label ? `（${snap.label}）` : ""}`);
        conn.send({ type: "reload" });
        break;
      }
      case "/new": {
        resetWorld();
        // 新对话重新播放角色开场白
        if (card?.firstMes) {
          await ctx.endTurn({
            systemText: buildSystem(),
            userInput: "",
            added: [{ role: "assistant", content: card.firstMes }],
          });
        }
        notice("已开新对话（角色卡保留），历史/账本/主线已清空");
        conn.send({ type: "reload" });
        break;
      }
      case "/lore": {
        const all = allLoreEntries();
        const kwHits = all.filter(
          (e) => e.enabled && (!arg || e.content.includes(arg) || e.keys.some((k) => k.includes(arg.toLowerCase()))),
        );
        // 无关键词命中时用向量语义检索补充展示（带来源标注）
        if (kwHits.length) {
          notice("世界书命中：\n" + kwHits.slice(0, 6).map((e) => `- ${e.content.slice(0, 100)}`).join("\n"));
        } else {
          const idx = new VectorIndex(all.filter((e) => e.enabled).map((e) => `${e.keys.join(" ")} ${e.content}`));
          const hits = idx.query(arg ?? "", 4);
          if (!hits.length) {
            notice(`世界书未命中「${arg}”`);
            break;
          }
          notice("世界书语义相关：\n" + hits.map((h) => {
            const e = all[h.index];
            return `- [${(h.score * 100).toFixed(0)}%] ${e ? e.content.slice(0, 100) : ""}`;
          }).join("\n"));
        }
        break;
      }
      case "/phase": {
        const m = director.summary();
        notice(`【${m.title}】\n目标：${m.objectives.join("；")}\n已解锁：${m.unlocked.join(" → ")}`);
        break;
      }
      default:
        notice(`未知命令 ${cmd}，输入 /help 查看`);
    }
  } catch (e) {
    notice(`命令失败：${(e as Error).message}`);
  }
}

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
    if (result.stoppedBy === "max-turns") conn.send({ type: "warn", message: "本轮达到工具循环上限，正文可能不完整，可重发或输入『继续』" });
    else if (!result.content.trim()) conn.send({ type: "warn", message: "模型本轮未产出正文（可能只输出了思考链），换个说法重发试试" });
    else if (result.lastFinishReason === "length") conn.send({ type: "warn", message: "回复达到长度上限被截断，输入『继续』可接着写" });
    conn.send({
      type: "turn_done",
      stats: {
        modelCalls: result.modelCalls,
        stoppedBy: result.stoppedBy,
        tools: result.tools,
        decisions: result.decisions,
        estTokens: Math.round(estimateChars(visible) / 3), // 字符估算，仅供展示
      },
    });
    const prune = await ctx.endTurn({ systemText: system, userInput: text, added: result.added });
    const up = await ledgerService.updateAfterTurn({ characterName: card.name, userInput: text, narrative: result.content });
    // 主线推进：把最近剧情（输入+正文+账本）交给导演比对关键词
    lastContext = `${text}\n${result.content}`;
    const adv = director.advance(`${lastContext}\n${snapshotText(ledgerService.load())}`, ctx.totalTurns);
    if (adv.advanced) conn.send({ type: "warn", message: `✦ 主线推进：${adv.to?.title}` });
    // 自动存档：每 N 回合存一次，防丢档
    if (cfg.autoSnapshotEvery > 0 && ctx.totalTurns > 0 && ctx.totalTurns % cfg.autoSnapshotEvery === 0) {
      const snap = createSnapshot(cfg.stateDir, `自动存档·第${ctx.totalTurns}回合`);
      conn.send({ type: "warn", message: `💾 已自动存档（第 ${ctx.totalTurns} 回合）` });
    }
    conn.send({ type: "state", state: collectState(), prune, ledgerUpdate: up });
  } catch (e) {
    conn.send({ type: "error", message: (e as Error).message });
  }
}

server.listen(PORT, () => {
  console.log(`✦ RP-Harness 已启动：http://127.0.0.1:${PORT}`);
  console.log(`  模型：${cfg.model} | 角色卡：${card?.name ?? "无"}`);
});
