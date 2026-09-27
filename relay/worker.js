// TOKI 道場の中継（Cloudflare Workers）。GMO の公開の過去の足を読むことだけを取り次ぐ（05 §7.1）。
// ★鍵を持たない・書き込まない・決まった組み合わせ以外は断る（何でも取り次ぐ中継にしない。04 R-22）。
// Cloudflare の管理画面にこのファイルをそのまま貼って公開する（relay/README.md）。

const ORIGIN = "https://somanakahashi-ops.github.io";
const UPSTREAM = "https://api.coin.z.com/public/v1/klines";
// js/config.js の SPECS と同じ15銘柄（テストで一致を確かめる）
export const SYMBOLS = Object.freeze([
  "BTC", "ETH", "XRP", "SOL", "DOGE", "XLM", "ADA", "BCH",
  "BTC_JPY", "ETH_JPY", "XRP_JPY", "SOL_JPY", "DOGE_JPY", "ADA_JPY", "BCH_JPY",
]);
export const INTERVALS = Object.freeze(["1min", "5min", "15min", "1hour"]);
const MAX_BYTES = 1048576;
const DAY = 86400000;

// GMO の日付: 日本時間の朝6時で日が変わる（= UTC に3時間足した日付）
export function gmoDate(ms) {
  const d = new Date(ms + 3 * 3600000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

function headers(extra = {}) {
  return {
    "Access-Control-Allow-Origin": ORIGIN,
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  };
}

function reply(status, text) {
  return new Response(text, { status, headers: headers({ "Content-Type": "text/plain; charset=utf-8" }) });
}

export async function handle(request, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: headers({ "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" }) });
  }
  if (request.method !== "GET") return reply(405, "method");
  const url = new URL(request.url);
  if (url.pathname !== "/klines") return reply(404, "not found");
  const q = url.searchParams;
  const symbol = q.get("symbol");
  const interval = q.get("interval");
  const date = q.get("date");
  if ([...q.keys()].length !== 3 || !SYMBOLS.includes(symbol) || !INTERVALS.includes(interval)
    || !/^\d{8}$/.test(date || "") || date < gmoDate(now - 7 * DAY) || date > gmoDate(now + DAY)) {
    return reply(400, "bad request");
  }
  const ttl = date === gmoDate(now) ? 30 : 86400;
  try {
    const up = await fetchImpl(`${UPSTREAM}?symbol=${symbol}&interval=${interval}&date=${date}`, {
      cf: { cacheTtl: ttl, cacheEverything: true },
    });
    if (!up.ok) return reply(502, "upstream");
    const body = await up.text();
    if (body.length > MAX_BYTES) return reply(502, "upstream");
    return new Response(body, {
      status: 200,
      headers: headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${ttl}` }),
    });
  } catch {
    return reply(502, "upstream");
  }
}

export default { fetch: (request) => handle(request) };
