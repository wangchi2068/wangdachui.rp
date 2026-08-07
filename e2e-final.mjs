import { chromium } from "playwright";
const EXE = "C:/Users/wangchi2068/AppData/Local/ms-playwright/chromium-1148/chrome-win/chrome.exe";
const browser = await chromium.launch({ executablePath: EXE });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => console.log("PAGE_ERR:", String(e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE_ERR:", m.text().slice(0, 200)); });
  await page.goto("http://127.0.0.1:7620", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2500);

  const dump = async (label) => {
    const d = await page.evaluate(() => {
      const msgs = [];
      document.querySelectorAll(".msg, [class*=message], [class*=turn]").forEach(el => {
        const t = el.innerText?.trim();
        if (t && t.length > 1) msgs.push({ cls: (el.className || "").toString().slice(0, 40), t: t.slice(0, 120).replace(/\n/g, "|") });
      });
      const uniq = [];
      for (const m of msgs) if (!uniq.some(u => u.t === m.t)) uniq.push(m);
      return { generating: document.body.innerText.includes("生成中"), msgs: uniq.slice(0, 12), tail: document.body.innerText.slice(-1200) };
    });
    console.log(`=== ${label} ===`);
    console.log("GENERATING:", d.generating);
    console.log("MSGS:", JSON.stringify(d.msgs, null, 1));
    console.log("TAIL:", JSON.stringify(d.tail));
  };

  await dump("initial");

  const ta = page.locator("textarea").first();
  if (await ta.count()) {
    await ta.fill("我下班了，给你带了奶茶，加了双倍糖");
    const btn = page.locator("button[aria-label='发送'], button[title='发送']").first();
    if (await btn.count()) await btn.click(); else await ta.press("Enter");
    console.log("SENT");
  }

  let done = false;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(3000);
    const has = await page.evaluate(() => document.body.innerText.includes("生成中"));
    if (!has) { done = true; break; }
  }
  console.log("DONE:", done);
  await dump("final");
  await page.screenshot({ path: "web-shot-6.png" });
} finally { await browser.close(); }
