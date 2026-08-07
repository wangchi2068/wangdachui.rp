/**
 * WebSocket 协议测试：连接 /ws，发一条聊天，打印服务端事件流。
 * 用 Node 22 内置 WebSocket 客户端验证手写协议层。
 * 用法：node scripts/ws-test.mjs ["对话内容"]
 */
const text = process.argv[2] ?? "雨停了，我们继续赶路吧。你想起月儿了吗？";

const ws = new WebSocket("ws://127.0.0.1:7620/ws");
const t0 = Date.now();
let narrative = "";

ws.onopen = () => {
  console.log("[连接成功]");
  ws.send(JSON.stringify({ type: "chat", text }));
};
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  switch (msg.type) {
    case "init":
      console.log(`[init] 角色=${msg.state.cardName} 窗口=${msg.state.windowTurns}/${msg.state.totalTurns}`);
      break;
    case "delta":
      narrative += msg.text;
      break;
    case "card":
      console.log(`[决策卡] ${msg.card.question}`);
      console.log(`  选项：${msg.card.options.map((o, i) => `${i + 1}.${o}`).join(" | ")}`);
      ws.send(JSON.stringify({ type: "choice", text: msg.card.options[0] }));
      console.log("  → 已选择选项 1");
      break;
    case "turn_done":
      console.log(`[回合结束] 模型调用 ${msg.stats.modelCalls} 次 | 工具 ${msg.stats.tools.length} | 决策 ${msg.stats.decisions.length}`);
      console.log(`[正文] ${narrative.slice(0, 160)}...`);
      break;
    case "state":
      const st = msg.state;
      console.log(`[状态] 账本: 人物${st.ledger.characters.length} 物品${st.ledger.items.length} 关系${st.ledger.relations.length} 伏笔${st.ledger.plots.length} | 摘要 ${st.summary.length} 字 | 窗口 ${st.windowTurns}/${st.totalTurns}`);
      console.log(`[完成] 总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      ws.close();
      process.exit(0);
      break;
    case "error":
      console.error("[错误]", msg.message);
      process.exit(1);
  }
};
ws.onerror = (e) => { console.error("WS 错误", e.message); process.exit(1); };
setTimeout(() => { console.error("超时"); process.exit(2); }, 120000);
