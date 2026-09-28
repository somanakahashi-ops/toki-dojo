// 過去の足（05 §7.1）: 中継から GMO の公開の過去の足を取り、検査して返す。
// ★見るためだけ。約定の判定には使わない（04 R-18）。端末には保存せず、記憶に少しだけ置く。
import {
  HISTORY_BARS, HISTORY_CACHE_MS, HISTORY_MAX_ROWS, HISTORY_TIMEOUT_MS, RELAY_URL, SPECS,
  TICK_HISTORY_MAX, TICK_HISTORY_PAGES, TICK_CACHE_MS,
} from "./config.js";

const DAY = 86400000;
const INTERVAL = Object.freeze({ 1: "1min", 5: "5min", 15: "15min", 60: "1hour" });
const MAX_DAYS = Object.freeze({ 1: 2, 5: 2, 15: 3, 60: 7 });

// GMO の日付: 日本時間の朝6時で日が変わる（= UTC に3時間足した日付）
export function gmoDate(ms) {
  const d = new Date(ms + 3 * 3600000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// 1行でも外れたら全体を捨てる（null）。status が 0 以外（その日のぶんが無い等）は空
export function parseKlines(json, frameMin) {
  if (!json || typeof json !== "object") return null;
  if (json.status !== 0) return [];
  if (!Array.isArray(json.data) || json.data.length > HISTORY_MAX_ROWS) return null;
  const out = [];
  for (const r of json.data) {
    if (!r || typeof r !== "object") return null;
    const t = num(r.openTime);
    const o = num(r.open);
    const h = num(r.high);
    const l = num(r.low);
    const c = num(r.close);
    const v = num(r.volume);
    if (t === null || t % (frameMin * 60000) !== 0) return null;
    if (!(o > 0 && h > 0 && l > 0 && c > 0) || v === null || v < 0) return null;
    if (l > Math.min(o, c) || h < Math.max(o, c)) return null;
    out.push({ t, o, h, l, c, v });
  }
  return out;
}

// 最近の約定（05 §7.2）。status が 0 以外は空、1行でも外れたら全体を捨てる（null）
export function parseTrades(json) {
  if (!json || typeof json !== "object") return null;
  if (json.status !== 0) return [];
  const list = json.data && json.data.list;
  if (!Array.isArray(list) || list.length > 100) return null;
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== "object") return null;
    const t = Date.parse(r.timestamp);
    const price = num(r.price);
    const size = num(r.size);
    if (!Number.isFinite(t) || !(price > 0) || size === null || size < 0 || (r.side !== "BUY" && r.side !== "SELL")) return null;
    out.push({ t, price, size, side: r.side });
  }
  return out;
}

export function tradeKey(k) {
  return `${k.t}|${k.price}|${k.size}|${k.side}`;
}

export class History {
  constructor({ relay = RELAY_URL, fetchImpl = globalThis.fetch?.bind(globalThis), now = () => Date.now() } = {}) {
    this.relay = relay;
    this.fetch = fetchImpl;
    this.now = now;
    this.cache = new Map(); // key -> {at, promise}
  }

  get enabled() {
    return !!this.relay && typeof this.fetch === "function";
  }

  clear() {
    this.cache.clear();
  }

  async get(path, parse) {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), HISTORY_TIMEOUT_MS) : null;
    try {
      const res = await this.fetch(`${this.relay}${path}`, { signal: ctl?.signal, credentials: "omit", referrerPolicy: "no-referrer" });
      if (!res.ok) throw new Error(`relay ${res.status}`);
      const rows = parse(await res.json());
      if (rows === null) throw new Error("bad data");
      return rows;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  day(inst, frame, date) {
    return this.get(`/klines?symbol=${encodeURIComponent(inst)}&interval=${INTERVAL[frame]}&date=${date}`, (j) => parseKlines(j, frame));
  }

  // 最近の約定を新しい方から1ページ100件ずつ取り、古い順に返す。
  // ページの間に新しい約定が入ると古い側へずれるので、重複は出るが抜けは出ない → 重複を除く（04 R-28）
  trades(inst) {
    if (!this.enabled || !SPECS[inst]) return Promise.resolve(null);
    return this.cached(`${inst}|ticks`, TICK_CACHE_MS, async () => {
      const byKey = new Map();
      for (let page = 1; page <= TICK_HISTORY_PAGES && byKey.size < TICK_HISTORY_MAX; page += 1) {
        const rows = await this.get(`/trades?symbol=${encodeURIComponent(inst)}&page=${page}&count=100`, parseTrades);
        for (const k of rows) byKey.set(tradeKey(k), k);
        if (rows.length < 100) break;
      }
      return [...byKey.values()].sort((a, b) => a.t - b.t);
    });
  }

  cached(key, ms, make) {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < ms) return hit.promise;
    const promise = make();
    this.cache.set(key, { at: this.now(), promise });
    promise.catch(() => this.cache.delete(key)); // 失敗は取り置かない（次の切り替えで取り直す）
    return promise;
  }

  // 今日から1日ずつ遡り、HISTORY_BARS 本そろうか上限の日数に届くまで取る。失敗は投げる（呼ぶ側が今まで通りに戻す）
  load(inst, frame) {
    if (!this.enabled || !SPECS[inst] || !INTERVAL[frame]) return Promise.resolve(null);
    return this.cached(`${inst}|${frame}`, HISTORY_CACHE_MS, async () => {
      const byT = new Map();
      const now = this.now();
      for (let d = 0; d < MAX_DAYS[frame] && byT.size < HISTORY_BARS; d += 1) {
        for (const b of await this.day(inst, frame, gmoDate(now - d * DAY))) byT.set(b.t, b);
      }
      return [...byT.values()].sort((a, b) => a.t - b.t);
    });
  }
}
