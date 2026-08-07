/**
 * wangdachui.pi Web 服务：手写 WebSocket（RFC6455）+ Node http 静态托管 + REST API。
 * 零第三方依赖：Node 内置 http/fetch/WebSocket 客户端 + 手写协议层。
 *
 * 启动：npm run web  →  http://127.0.0.1:7620
 */
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
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

const PORT = Number(process.env.WANGDACHUI_PORT ?? 7620);
// 资源根目录：优先用 import.meta.url 定位（Vercel 打包器可静态识别，能正确带上 web/ 与 assets/）；
// 本地 node 直跑时 import.meta.url 也指向 src/ 同级，行为一致。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = loadConfig();
if (!cfg.apiKey) {
  console.error("缺少 WANGDACHUI_API_KEY：请检查 .env 文件");
  process.exit(1);
}

/** 战役包目录：WANGDACHUI_CAMPAIGN=lotm → assets/campaigns/lotm/（不存在则返回 null） */
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

/** 单个访客会话：独立 state 目录 + 独立上下文/账本/主线（互不影响） */
interface SessionState {
  sid: string;
  stateDir: string;
  card: CharacterCard | null;
  ctx: ContextManager;
  ledger: LedgerService;
  director: Director;
  lastContext: string;
}

/** 默认会话（HTTP API / 无 sid 时用）：state 目录与全局同层 */
const sessions = new Map<string, SessionState>();

/** 获取（或创建）会话实例：sid 为空/无 sid 用默认目录，否则用 stateDir/sessions/<sid>/ */
function getSession(sid?: string | null): SessionState {
  const key = sid && /^[A-Za-z0-9_\-]{4,64}$/.test(sid) ? sid : "default";
  const exist = sessions.get(key);
  if (exist) return exist;
  const stateDir = key === "default" ? cfg.stateDir : resolve(cfg.stateDir, "sessions", key);
  const st: SessionState = {
    sid: key,
    stateDir,
    card: null,
    ctx: new ContextManager(client, cfg, stateDir),
    ledger: new LedgerService(client, stateDir, cfg.scribeModel),
    director: new Director(stateDir, loadCampaignArc()),
    lastContext: "",
  };
  st.card = loadDefaultCard(stateDir);
  sessions.set(key, st);
  return st;
}

/** 会话状态快照（前端 init/state 用） */
function collectState(st: SessionState) {
  const ledger = st.ledger.load();
  return {
    cardName: st.card?.name ?? null,
    model: cfg.model,
    budgetChars: cfg.contextBudgetChars,
    ledger,
    summary: st.ctx.summaryText,
    windowTurns: st.ctx.windowSize,
    totalTurns: st.ctx.totalTurns,
    turns: st.ctx.allTurns.slice(-6).map((t) => ({ user: t.userInput, messages: t.messages })),
    mainline: st.director.summary(),
  };
}

/** 把当前生效角色卡持久化（仅在上传/回档后调用；默认卡以 assets 为兜底，不落盘） */
function persistCurrentCard(st: SessionState): void {
  if (!st.card) return;
  mkdirSync(st.stateDir, { recursive: true });
  writeFileSync(resolve(st.stateDir, "card.json"), JSON.stringify(st.card), "utf8");
}

/** 全新对话/换卡：清空对话记忆、主线、账本与决策留痕（角色卡与世界书保留） */
function resetWorld(st: SessionState): void {
  st.ctx.reset();
  st.director.reset();
  st.lastContext = "";
  for (const f of ["ledger.json", "decisions.jsonl"]) {
    try {
      rmSync(resolve(st.stateDir, f), { force: true });
    } catch {
      /* 文件不存在则跳过 */
    }
  }
}

function loadDefaultCard(stateDir?: string): CharacterCard | null {
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
  // 会话级角色卡（上传/回档的产物）；目录不存在则跳过
  if (stateDir) {
    const saved = resolve(stateDir, "card.json");
    if (existsSync(saved)) {
      try {
        const parsed = parseCard(JSON.parse(readFileSync(saved, "utf8")));
        if (parsed) return parsed;
      } catch {
        /* 损坏则回退示例卡 */
      }
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

/* ─────────── 对话导出（md / Word 兼容 HTML）─────────── */

interface HistoryTurn {
  id?: string;
  at?: string;
  userInput?: string;
  messages?: { role: string; content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] }[];
}

/** 读取 state/history.jsonl → 结构化回合数组 */
function loadHistoryTurns(stateDir: string): HistoryTurn[] {
  const f = resolve(stateDir, "history.jsonl");
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
function buildExportMarkdown(st: SessionState): string {
  const cardName = st.card?.name ?? "（未导入角色卡）";
  const lines: string[] = [
    `# wangdachui.pi 对话记录`,
    ``,
    `> 角色：${cardName}`,
    `> 导出时间：${new Date().toLocaleString("zh-CN")}`,
    `> 主线：${st.director.summary().title}`,
    ``,
    `---`,
    ``,
  ];
  for (const t of loadHistoryTurns(st.stateDir)) {
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
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>wangdachui.pi 对话记录</title></head><body style="font-family:'Microsoft YaHei',sans-serif;max-width:760px;margin:24px auto;color:#222;">${body}</body></html>`;
}

function buildSystem(st: SessionState): string {
  if (!st.card) return "（尚未导入角色卡）";
  const lore = activateLoreHybrid(allLoreEntries(st), st.lastContext, 8, 4);
  const blocks = [
    buildSystemPrompt({
      card: st.card,
      lore: lore.entries,
      ledgerSnapshot: snapshotText(st.ledger.load()),
      extraRules: buildExtraRules(st),
    }),
  ];
  const directive = st.director.buildDirective();
  if (directive) blocks.push(directive);
  return blocks.join("\n\n");
}

/** 动态补充规则：根据玩家上一条输入形态注入针对性指引（短输入/走偏处理） */
function buildExtraRules(st: SessionState): string {
  const rules = ["用第一人称扮演角色，保持人设；遇到重大剧情转折时用 decide 工具把候选方向做成卡片询问用户，不要滥用。"];
  const last = (st.lastContext || "").trim();
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
function allLoreEntries(st: SessionState): LorebookEntry[] {
  const fromCard = st.card?.characterBook ?? [];
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
      const st = getSession(url.searchParams.get("sid"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(collectState(st)));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/export") {
      const st = getSession(url.searchParams.get("sid"));
      const fmt = url.searchParams.get("fmt") === "doc" ? "doc" : "md";
      const md = buildExportMarkdown(st);
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
      const st = getSession(url.searchParams.get("sid"));
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
      st.card = parsed;
      mkdirSync(st.stateDir, { recursive: true });
      writeFileSync(resolve(st.stateDir, "card.json"), JSON.stringify(parsed), "utf8");
      resetWorld(st); // 换卡 = 新世界
      if (st.card.firstMes) {
        await st.ctx.endTurn({
          systemText: buildSystem(st),
          userInput: "",
          added: [{ role: "assistant", content: st.card.firstMes }],
        });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: st.card.name, firstMes: st.card.firstMes ?? "" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/snapshots") {
      const st = getSession(url.searchParams.get("sid"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(listSnapshots(st.stateDir)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/snapshot") {
      const st = getSession(url.searchParams.get("sid"));
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
      const snap = createSnapshot(st.stateDir, label);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, id: snap.id, at: snap.at }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/restore") {
      const st = getSession(url.searchParams.get("sid"));
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
      createSnapshot(st.stateDir, "回档前自动存档");
      const result = restoreSnapshot(st.stateDir, id);
      if (!result.ok) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: result.error }));
        return;
      }
      // 重建内存态：上下文管理器（回合/摘要）与角色卡都从磁盘重新加载
      st.ctx = new ContextManager(client, cfg, st.stateDir);
      st.director = new Director(st.stateDir, loadCampaignArc()); // 主线进度随快照回档
      st.card = loadDefaultCard(st.stateDir);
      persistCurrentCard(st);
      st.lastContext = "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, at: result.at, label: result.label }));
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/snapshot/")) {
      const st = getSession(url.searchParams.get("sid"));
      deleteSnapshot(st.stateDir, decodeURIComponent(url.pathname.slice("/api/snapshot/".length)));
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

/* ─────────────── WebSocket（ws 库，兼容 Vercel/本地） ─────────────── */

interface Connection {
  socket: WebSocket;
  send(obj: unknown): void;
}

const connections = new Set<WebSocket>();

/** 每个连接独立挂起决策（防两个访客同时决策卡互相覆盖） */
type ConnDecision = { resolve: (choice: string) => void };
const connDecisions = new WeakMap<WebSocket, ConnDecision>();

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
  // 解析 ?sid=：每个浏览器一个稳定会话 ID（localStorage 生成），服务端按它隔离全部状态
  const url = new URL(req.url ?? "/ws", "http://localhost");
  const sid = url.searchParams.get("sid");
  const st = getSession(sid);
  // 客户端异常断开（ECONNRESET 等）绝不能崩进程：一律兜底 error
  socket.on("error", () => {
    connections.delete(socket);
    connDecisions.delete(socket);
  });
  const conn: Connection = {
    socket,
    send: (obj) => {
      if (socket.readyState === 1 /* OPEN */) socket.send(JSON.stringify(obj));
    },
  };
  connections.add(socket);
  conn.send({ type: "init", state: collectState(st) });
  socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    let msg: { type?: string; text?: string };
    try {
      msg = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    } catch {
      return;
    }
    const pending = connDecisions.get(socket);
    if (msg.type === "chat" && typeof msg.text === "string") {
      // 决策卡挂起时，普通输入视为自由选择（防止"没人点卡片 → 对话卡死"）
      if (pending) {
        connDecisions.delete(socket);
        pending.resolve(msg.text);
        conn.send({ type: "warn", message: "已把你的输入作为决策卡的自由选择：" + msg.text });
      } else {
        void handleChat(conn, st, msg.text);
      }
    }
    if (msg.type === "command" && typeof msg.text === "string") void handleCommand(conn, st, msg.text);
    if (msg.type === "choice" && typeof msg.text === "string" && pending) {
      connDecisions.delete(socket);
      pending.resolve(msg.text);
    }
  });
  socket.on("close", () => {
    connections.delete(socket);
    connDecisions.delete(socket);
  });
});

// http 层的兜底：升级/请求中途断连也不崩进程
server.on("clientError", (_err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  else socket.destroy();
});

/** 斜杠命令：/help /state /snap /back /new /lore /phase */
async function handleCommand(conn: Connection, st: SessionState, text: string): Promise<void> {
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
        notice(snapshotText(st.ledger.load()));
        break;
      case "/snap": {
        const s = createSnapshot(st.stateDir, arg || undefined);
        notice(`已存档 ${s.at.slice(0, 19)}${s.label ? `（${s.label}）` : ""}`);
        break;
      }
      case "/back": {
        const snaps = listSnapshots(st.stateDir);
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
        createSnapshot(st.stateDir, "回档前自动存档");
        const r = restoreSnapshot(st.stateDir, snap.id);
        if (!r.ok) {
          notice(`回档失败：${r.error}`);
          break;
        }
        st.ctx = new ContextManager(client, cfg, st.stateDir);
        st.director = new Director(st.stateDir, loadCampaignArc());
        st.card = loadDefaultCard(st.stateDir);
        persistCurrentCard(st);
        st.lastContext = "";
        notice(`已回档到 ${snap.at.slice(0, 19)}${snap.label ? `（${snap.label}）` : ""}`);
        conn.send({ type: "reload" });
        break;
      }
      case "/new": {
        resetWorld(st);
        // 新对话重新播放角色开场白
        if (st.card?.firstMes) {
          await st.ctx.endTurn({
            systemText: buildSystem(st),
            userInput: "",
            added: [{ role: "assistant", content: st.card.firstMes }],
          });
        }
        notice("已开新对话（角色卡保留），历史/账本/主线已清空");
        conn.send({ type: "reload" });
        break;
      }
      case "/lore": {
        const all = allLoreEntries(st);
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
        const m = st.director.summary();
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

async function handleChat(conn: Connection, st: SessionState, text: string): Promise<void> {
  if (!st.card) {
    conn.send({ type: "error", message: "请先导入角色卡" });
    return;
  }
  try {
    st.lastContext = text;
    const system = buildSystem(st);
    const visible = st.ctx.visibleMessages(system, text);
    const result = await harness.runTurn(visible, {
      onNarrativeDelta: (d) => conn.send({ type: "delta", text: d }),
      onDecisionRequested: (cardData: DecisionCard) =>
        new Promise<string>((resolve) => {
          connDecisions.set(conn.socket, { resolve });
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
    const prune = await st.ctx.endTurn({ systemText: system, userInput: text, added: result.added });
    const up = await st.ledger.updateAfterTurn({ characterName: st.card.name, userInput: text, narrative: result.content });
    // 主线推进：把最近剧情（输入+正文+账本）交给导演比对关键词
    st.lastContext = `${text}\n${result.content}`;
    const adv = st.director.advance(`${st.lastContext}\n${snapshotText(st.ledger.load())}`, st.ctx.totalTurns);
    if (adv.advanced) conn.send({ type: "warn", message: `✦ 主线推进：${adv.to?.title}` });
    // 自动存档：每 N 回合存一次，防丢档
    if (cfg.autoSnapshotEvery > 0 && st.ctx.totalTurns > 0 && st.ctx.totalTurns % cfg.autoSnapshotEvery === 0) {
      const snap = createSnapshot(st.stateDir, `自动存档·第${st.ctx.totalTurns}回合`);
      conn.send({ type: "warn", message: `💾 已自动存档（第 ${st.ctx.totalTurns} 回合）` });
    }
    conn.send({ type: "state", state: collectState(st), prune, ledgerUpdate: up });
  } catch (e) {
    conn.send({ type: "error", message: (e as Error).message });
  }
}

server.listen(PORT, () => {
  console.log(`✦ wangdachui.pi 已启动：http://127.0.0.1:${PORT}`);
  console.log(`  模型：${cfg.model} | 角色卡：${getSession(null).card?.name ?? "无"}`);
});
