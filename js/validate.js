// 受け取った電文の検査（05 §5）。外から来たものは必ずここを通す。外れたら null を返して数える。
import { BOOK_LEVELS_MAX, MSG_MAX_BYTES } from "./config.js";

export const rejected = { count: 0, last: "" };

function drop(why) {
  rejected.count += 1;
  rejected.last = why;
  return null;
}

function pos(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nonneg(x) {
  const n = Number(x);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function time(x) {
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : null;
}

function levels(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const lv of arr.slice(0, BOOK_LEVELS_MAX)) {
    const price = pos(lv && lv.price);
    const size = nonneg(lv && lv.size);
    if (price === null || size === null) return null;
    out.push({ price, size });
  }
  return out;
}

// raw: WebSocket の文字列。symbols: 購読中の銘柄の集合
export function message(raw, symbols) {
  if (typeof raw !== "string") return drop("文字列ではない");
  if (raw.length > MSG_MAX_BYTES) return drop("大きすぎる");
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return drop("JSON ではない");
  }
  if (!m || typeof m !== "object") return drop("形が違う");
  if (m.error) return { kind: "error", error: String(m.error).slice(0, 200) };
  const sym = typeof m.symbol === "string" ? m.symbol : null;
  if (!sym || (symbols && !symbols.has(sym))) return drop("購読していない銘柄");
  const t = time(m.timestamp);
  if (t === null) return drop("時刻が読めない");
  if (m.channel === "ticker") {
    const out = { kind: "ticker", symbol: sym, t, ask: pos(m.ask), bid: pos(m.bid), last: pos(m.last),
      high: pos(m.high), low: pos(m.low), volume: nonneg(m.volume) };
    if (out.last === null) return drop("ticker の値が不正");
    return out;
  }
  if (m.channel === "orderbooks") {
    const asks = levels(m.asks);
    const bids = levels(m.bids);
    if (!asks || !bids) return drop("板の値が不正");
    asks.sort((a, b) => a.price - b.price);
    bids.sort((a, b) => b.price - a.price);
    return { kind: "book", symbol: sym, t, asks, bids };
  }
  if (m.channel === "trades") {
    const price = pos(m.price);
    const size = nonneg(m.size);
    if (price === null || size === null || (m.side !== "BUY" && m.side !== "SELL")) return drop("約定の値が不正");
    return { kind: "trade", symbol: sym, t, price, size, side: m.side };
  }
  return drop("知らない channel");
}
