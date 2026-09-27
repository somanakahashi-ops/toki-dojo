// 定数だけを置く（05 詳細設計 §1）。銘柄の仕様は GMO GET /public/v1/symbols の実値（2026-09-27 取得）。

export const SPECS_FETCHED_AT = "2026-09-27";

// key: 配信の symbol。min/max: 注文数量、step: 数量の刻み、tick: 値段の刻み、taker/maker: 手数料率
export const SPECS = Object.freeze({
  BTC: { min: 0.00001, max: 5, step: 0.00001, tick: 1, taker: 0.0005, maker: -0.0001 },
  ETH: { min: 0.001, max: 100, step: 0.0001, tick: 1, taker: 0.0005, maker: -0.0001 },
  XRP: { min: 1, max: 100000, step: 1, tick: 0.001, taker: 0.0005, maker: -0.0001 },
  SOL: { min: 0.01, max: 500, step: 0.01, tick: 1, taker: 0.0009, maker: -0.0003 },
  DOGE: { min: 10, max: 200000, step: 1, tick: 0.001, taker: 0.0009, maker: -0.0003 },
  XLM: { min: 1, max: 50000, step: 1, tick: 0.001, taker: 0.0009, maker: -0.0003 },
  ADA: { min: 1, max: 50000, step: 1, tick: 0.001, taker: 0.0009, maker: -0.0003 },
  BCH: { min: 0.01, max: 100, step: 0.001, tick: 1, taker: 0.0009, maker: -0.0003 },
  BTC_JPY: { min: 0.001, max: 5, step: 0.001, tick: 1, taker: 0, maker: 0 },
  ETH_JPY: { min: 0.01, max: 100, step: 0.01, tick: 1, taker: 0, maker: 0 },
  XRP_JPY: { min: 10, max: 100000, step: 10, tick: 0.001, taker: 0, maker: 0 },
  SOL_JPY: { min: 0.1, max: 500, step: 0.1, tick: 1, taker: 0.0003, maker: 0 },
  DOGE_JPY: { min: 10, max: 200000, step: 10, tick: 0.001, taker: 0.0003, maker: 0 },
  ADA_JPY: { min: 10, max: 50000, step: 10, tick: 0.001, taker: 0.0003, maker: 0 },
  BCH_JPY: { min: 0.1, max: 100, step: 0.1, tick: 1, taker: 0, maker: 0 },
});

export const BASES = Object.freeze(["BTC", "ETH", "XRP", "SOL", "DOGE", "XLM", "ADA", "BCH"]);

export function instKey(base, market) {
  return market === "lev" ? `${base}_JPY` : base;
}

export function hasLeverage(base) {
  return Object.prototype.hasOwnProperty.call(SPECS, `${base}_JPY`);
}

export function parseInst(key) {
  const lev = key.endsWith("_JPY");
  return { key, base: lev ? key.slice(0, -4) : key, market: lev ? "lev" : "spot" };
}

export const LEVERAGE = 2;
export const CARRY_RATE = 0.0004;
export const CARRY_UTC_HOUR = 20;
export const LOSSCUT_RATIO = 0.75;

export const FRESH_MS = 5000;
export const GAP_MS = 30000;
export const LATENCY_CHOICES = Object.freeze([0, 100, 300, 1000]);
export const LATENCY_MS = 300;
export const SUB_INTERVAL_MS = 1100;
export const MAX_INSTRUMENTS = 6;
export const MSG_MAX_BYTES = 262144;
export const BOOK_LEVELS_MAX = 100;
export const TAPE_KEEP = 200;
export const KEEP_DAYS = 7;
export const TRADES_MAX = 5000;
export const FILLS_MAX = 20000;
export const MEMO_MAX = 500;
export const RANDOM_DRAWS = 200;
export const RANDOM_MIN_TRADES = 20;
export const CAPITAL_CHOICES = Object.freeze([30000, 100000, 300000, 1000000]);
export const CAPITAL_DEFAULT = 30000;

export const WS_URL = "wss://api.coin.z.com/ws/public/v1";

// 過去の足の中継（Cloudflare Workers・relay/worker.js）。空なら過去の足を取らない（今まで通り）。
// 変えたら index.html の CSP の connect-src にも同じ origin を入れる（構造のテストで確かめる）
export const RELAY_URL = "";
export const HISTORY_BARS = 120;
export const HISTORY_MAX_ROWS = 1500;
export const HISTORY_TIMEOUT_MS = 8000;
export const HISTORY_CACHE_MS = 60000;
export const DB_NAME = "toki-dojo-v1";
