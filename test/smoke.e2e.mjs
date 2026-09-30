// 実際の配信で通しを確かめる（05 §8 Playwright）。npm test には入れない（外へつなぐため）。
// 使い方: NODE_USE_ENV_PROXY=1 node test/smoke.e2e.mjs <スクリーンショットの置き場>
// ページは https://dojo.test/ として手元のファイルを返し、WebSocket は Node から本物の GMO へ中継する
// （ブラウザが直接外へ出られない環境でも、中身は本物の配信で試せる）。
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { handle } from "../relay/worker.js";
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TYPES = { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml", webmanifest: "application/manifest+json" };
// relay: "ok" なら中継（relay/worker.js をそのまま Node で動かし、本物の GMO を読む）をつなぐ。"down" なら中継が落ちている
const RELAY = "https://relay.test";
async function serve(ctx, relay = "ok") {
  await ctx.route("https://dojo.test/**", (route) => {
    let p = new URL(route.request().url()).pathname;
    if (p.endsWith("/")) p += "index.html";
    let body;
    try { body = readFileSync(ROOT + decodeURIComponent(p), "utf8"); }
    catch { return route.fulfill({ status: 404, body: "" }); }
    // 設定されている中継（本番の URL か空）を、試験の中継に差し替える
    if (p === "/js/config.js") body = body.replace(/export const RELAY_URL = "[^"]*";/, `export const RELAY_URL = "${RELAY}";`);
    if (p === "/index.html") body = body.replace(/connect-src wss:\/\/api\.coin\.z\.com[^;]*;/, `connect-src wss://api.coin.z.com ${RELAY};`);
    return route.fulfill({ status: 200, contentType: TYPES[p.split(".").pop()] || "application/octet-stream", body });
  });
  await ctx.route(`${RELAY}/**`, async (route) => {
    if (relay === "down") return route.fulfill({ status: 502, body: "upstream" });
    const res = await handle(new Request(route.request().url()));
    // 中継が許す元は Pages だけ。試験のページ（dojo.test）を Pages の代わりとして扱うため、ここでだけ差し替える
    const headers = { ...Object.fromEntries(res.headers), "access-control-allow-origin": "https://dojo.test" };
    route.fulfill({ status: res.status, headers, body: await res.text() });
  });
}
const OUT = process.argv[2] || ".";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await serve(ctx);
// 砂箱の Chromium は外へ出られないので、ページの WebSocket を Node 経由で本物の GMO へ中継する（中身は本物の配信）
await ctx.routeWebSocket("wss://api.coin.z.com/ws/public/v1", (ws) => {
  const up = new WebSocket("wss://api.coin.z.com/ws/public/v1");
  const pending = [];
  // 上流がつながる前に溜まったぶんも、1.1秒おきに流す（中継のせいで GMO の制限を超えないように）
  let last = 0;
  const flush = () => {
    if (up.readyState !== 1 || !pending.length) return;
    const wait = last + 1100 - Date.now();
    if (wait > 0) return setTimeout(flush, wait);
    last = Date.now();
    up.send(pending.shift());
    if (pending.length) setTimeout(flush, 1100);
  };
  up.onopen = flush;
  up.onmessage = (e) => ws.send(String(e.data));
  up.onclose = () => ws.close();
  ws.onMessage((m) => { pending.push(m); flush(); });
  ws.onClose(() => up.close());
});
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(() => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
});
await page.goto("https://dojo.test/");
await page.waitForSelector(".book-row", { timeout: 40000 });
console.log("board rows", await page.locator(".book-row").count(), "status", await page.locator(".pill").textContent());
// 開いた直後から過去の足が出ている（知らせが消える＝20本以上）
await page.waitForFunction(() => document.querySelector(".chart-note")?.textContent === "", null, { timeout: 20000 })
  .catch(async (e) => { console.log("note:", await page.locator(".chart-note").textContent(), errors); throw e; });
console.log("history: chart has >=20 bars right after opening");
await page.screenshot({ path: `${OUT}/history.png` });
// ティック足: Tick（線）と 10T（ローソク足）で、開いた直後から過去の約定が出る
for (const [label, shot] of [["Tick", "tick"], ["10T", "t10"]]) {
  await page.locator(`.chip:text-is("${label}")`).click();
  await page.waitForFunction(() => document.querySelector(".chart-note")?.textContent === "", null, { timeout: 30000 })
    .catch(async (e) => { console.log("note:", await page.locator(".chart-note").textContent(), errors); throw e; });
  console.log(`ticks: ${label} has >=20 points right after switching`);
  await page.screenshot({ path: `${OUT}/${shot}.png` });
}
await page.locator('.chip:text-is("1分")').click();
// 縦軸を引いて自動の幅合わせを切ってから銘柄を変えても、新しい銘柄の幅に合う（04 R-33）
{
  const box = await page.locator(".chart-box").boundingBox();
  const x = box.x + box.width - 30;
  await page.mouse.move(x, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(x, box.y + 260, { steps: 8 });
  await page.mouse.up();
  await page.screenshot({ path: `${OUT}/axis-dragged.png` });
  await page.selectOption("#sym", "XRP");
  await page.waitForFunction(() => document.querySelector(".chart-note")?.textContent === "", null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/axis-xrp.png` });
  console.log("axis: switched to XRP after dragging the price axis");
  await page.selectOption("#sym", "BTC");
  await page.waitForTimeout(1500);
}
await page.waitForFunction(() => !document.querySelector(".ticket .btn.buy, .ticket .btn.sell").disabled, null, { timeout: 20000 });
await page.fill("#size", "0.0001");
await page.waitForTimeout(400);
console.log("est:", await page.locator(".est").innerText());
await page.locator(".ticket button.btn.buy").click();
await page.waitForSelector("text=BTC 現物", { timeout: 5000 });
console.log("spot holding row ok");
await page.screenshot({ path: `${OUT}/spot.png`, fullPage: true });
await page.locator("button:has-text('全部売る')").click();
await page.locator("button:has-text('全部売る')").click();   // 2回押しで確定
await page.waitForTimeout(1500);
// レバ: 新規買い → 決済
await page.locator(".topbar button:has-text('レバ')").click();
await page.waitForFunction(() => { const b = document.querySelector(".ticket .btn.buy"); return b && !b.disabled; }, null, { timeout: 20000 });
await page.fill("#size", "0.001");
await page.waitForTimeout(400);
console.log("lev est:", await page.locator(".est").innerText());
await page.locator(".ticket button.btn.buy").click();
await page.waitForSelector("text=BTC_JPY 買い", { timeout: 5000 });
console.log("lev pos ok; margin:", await page.locator(".acct").innerText());
await page.locator(".pos-card button:has-text('決済')").first().click();
await page.locator(".pos-card button:has-text('決済')").first().click();   // 2回押しで確定
await page.waitForTimeout(1500);
// レバ: 新規売り → チャートに「新売」の矢印と「建値 売」の破線が出る → 決済
await page.locator(".ticket .seg.buy-sell button.s").click();
await page.fill("#size", "0.001");
await page.waitForTimeout(400);
await page.locator(".ticket button.btn.sell").click();
await page.waitForSelector("text=BTC_JPY 売り", { timeout: 5000 });
await page.waitForTimeout(1200);
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${OUT}/short.png` });
console.log("lev short opened; screenshot short.png");
// 建玉のカード（04 R-37 R-38）: はみ出さない・入力欄16px以上・入力が描画をまたいで残る・反映で損切りが出る
{
  const over = await page.evaluate(() => {
    const card = document.querySelector("#app .pos-card:last-child") || document.querySelector(".pos-card");
    const r = card.getBoundingClientRect();
    return [...card.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > r.right + 1).map((e) => e.tagName + ":" + e.textContent.slice(0, 20));
  });
  console.log("card overflow:", JSON.stringify(over));
  const input = page.locator(".pos-card input[aria-label='損切り（逆指値）']").first();
  console.log("input font-size:", await input.evaluate((e) => getComputedStyle(e).fontSize));
  const ask = await page.evaluate(() => Number(document.querySelector(".book-row.ask .px")?.textContent.replace(/,/g, "")) || 0);
  const slPrice = String(Math.round(ask * 1.02));
  await input.fill(slPrice);
  await page.locator("h2:text-is('チャート')").click();   // 入力欄から離れる
  await page.waitForTimeout(2000);
  console.log("typed value survives renders:", (await input.inputValue()) === slPrice);
  await page.locator(".pos-card button:has-text('反映')").first().click();
  await page.waitForTimeout(800);
  console.log("stop order listed:", await page.locator("td:text-is('損切り')").count() > 0);
  await page.locator(".pos-card").last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/poscard.png` });
}
await page.locator(".pos-card button:has-text('決済')").first().click();
await page.locator(".pos-card button:has-text('決済')").first().click();   // 2回押しで確定
await page.waitForTimeout(1500);
{
  const kept = await page.evaluate(async () => {
    const w = [...document.querySelectorAll(".table-wrap")].find((x) => x.scrollWidth > x.clientWidth);
    if (!w) return "no scrollable table";
    w.scrollLeft = 40;
    await new Promise((r) => setTimeout(r, 2000));
    return w.scrollLeft > 0;
  });
  console.log("table scroll kept across renders:", kept);
}
console.log("history:", (await page.locator("text=最近の注文").locator("xpath=following-sibling::*[1]").innerText()).replace(/\n/g, " | "));
console.log("banner:", await page.locator(".banner").isVisible() ? await page.locator(".banner").textContent() : "(none)");
await page.locator(".tabs button:has-text('振り返り')").click();
await page.waitForTimeout(800);
const n = await page.locator(".stat").first().innerText();
console.log("review:", n.replace(/\n/g, " "));
await page.screenshot({ path: `${OUT}/review.png`, fullPage: true });
await page.locator(".tabs button:has-text('取引')").click();
await page.waitForTimeout(3000);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/trade.png` });
console.log("csp violations:", JSON.stringify(await page.evaluate(() => window.__csp)));
console.log("errors:", JSON.stringify(errors));
// 埋め込みの確認
const p2 = await ctx.newPage();
await p2.setContent('<iframe src="https://dojo.test/" width=400 height=300></iframe>');
await p2.waitForTimeout(1500);
console.log("framed text:", await p2.frames()[1].locator("#app").innerText());
// 中継が落ちていても、今まで通り動く
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
await serve(ctx2, "down");
const p3 = await ctx2.newPage();
await p3.goto("https://dojo.test/");
await p3.waitForFunction(() => /過去の足を取れませんでした/.test(document.querySelector(".chart-note")?.textContent || ""), null, { timeout: 15000 });
console.log("relay down → fallback note:", await p3.locator(".chart-note").textContent());
await browser.close();
