// 振り返り（05 §4）: 集計・偶然との比較・書き出し。すべて純粋な関数。
import { RANDOM_DRAWS, RANDOM_MIN_TRADES, SPECS } from "./config.js";
import { carryCount, carryYen, direction, feeYen } from "./engine.js";

const MIN = 60000;

export function stats(trades, initialCash) {
  const ts = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const n = ts.length;
  const wins = ts.filter((t) => t.pnl > 0);
  const losses = ts.filter((t) => t.pnl <= 0);
  const total = ts.reduce((a, t) => a + t.pnl, 0);
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of ts) {
    cum += t.pnl;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }
  const byHour = Array.from({ length: 24 }, () => ({ n: 0, pnl: 0 }));
  for (const t of ts) {
    const h = new Date(t.entryTime + 9 * 3600000).getUTCHours();
    byHour[h].n += 1;
    byHour[h].pnl += t.pnl;
  }
  return {
    n, winRate: n ? wins.length / n : null, total,
    avgWin: wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : null,
    avgLoss: losses.length ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : null,
    fees: ts.reduce((a, t) => a + (t.fees || 0), 0), carry: ts.reduce((a, t) => a + (t.carry || 0), 0),
    maxDdYen: maxDd, maxDdPct: initialCash > 0 ? (maxDd / initialCash) * 100 : null, byHour,
  };
}

// シードつきの乱数（mulberry32）
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 保有 h 分のあいだ1分も欠けない開始点の番号
export function startCandidates(series, h) {
  const out = [];
  let run = 0;
  for (let i = 0; i < series.length; i += 1) {
    run = i > 0 && series[i].t - series[i - 1].t === MIN ? run + 1 : 0;
    if (run >= h) out.push(i - h);
  }
  return out;
}

function legPrice(q, side, leg, liquidity) {
  const mid = (q.bid + q.ask) / 2;
  if (liquidity === "maker") return mid;
  const buying = (leg === "entry") === (side === "BUY");
  return buying ? q.ask : q.bid;
}

// 偶然との比較: 同じ銘柄・同じ向き・同じ保有時間で、入る時刻だけ無作為に変えた取引の合計の分布
export function randomCompare(trades, quotes, { draws = RANDOM_DRAWS, seed = 7, minTrades = RANDOM_MIN_TRADES } = {}) {
  const usable = [];
  let excluded = 0;
  for (const tr of trades) {
    const series = quotes[tr.inst] || [];
    const h = Math.max(1, Math.round((tr.exitTime - tr.entryTime) / MIN));
    const cands = startCandidates(series, h);
    if (!cands.length || !SPECS[tr.inst]) {
      excluded += 1;
      continue;
    }
    usable.push({ tr, series, h, cands });
  }
  const userTotal = usable.reduce((a, u) => a + u.tr.pnl, 0);
  if (usable.length < minTrades) {
    return { status: "insufficient", included: usable.length, excluded, userTotal, minTrades };
  }
  const rand = rng(seed);
  const totals = [];
  for (let d = 0; d < draws; d += 1) {
    let sum = 0;
    for (const { tr, series, h, cands } of usable) {
      const i = cands[Math.floor(rand() * cands.length)];
      const qi = series[i];
      const qo = series[i + h];
      const liq = tr.liquidity || { entry: "taker", exit: "taker" };
      const pin = legPrice(qi, tr.side, "entry", liq.entry);
      const pout = legPrice(qo, tr.side, "exit", liq.exit);
      const spec = SPECS[tr.inst];
      const rate = (l) => (l === "maker" ? spec.maker : spec.taker);
      const fees = feeYen(tr.size * pin, rate(liq.entry)) + feeYen(tr.size * pout, rate(liq.exit));
      const carry = tr.market === "lev" ? carryCount(qi.t, qo.t) * carryYen(tr.size * pin) : 0;
      sum += direction(tr.side) * (pout - pin) * tr.size - fees - carry;
    }
    totals.push(sum);
  }
  totals.sort((a, b) => a - b);
  const q = (p) => totals[Math.min(totals.length - 1, Math.floor(p * totals.length))];
  return {
    status: "ok", included: usable.length, excluded, userTotal,
    percentile: (totals.filter((x) => x < userTotal).length / totals.length) * 100,
    median: q(0.5), p5: q(0.05), p95: q(0.95),
  };
}

// CSV のセル。数式として読まれないように = + - @ で始まるものは ' を前に付ける（N-2）
export function csvCell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function jst(ms) {
  if (!ms) return "";
  const d = new Date(ms + 9 * 3600000);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function toCsv(trades) {
  const head = ["番号", "銘柄", "市場", "向き", "数量", "建値", "決済値", "建てた時刻(JST)", "決済した時刻(JST)",
    "保有(分)", "手数料", "建玉管理料", "損益", "決済の理由", "メモ"];
  const rows = [...trades].sort((a, b) => a.exitTime - b.exitTime).map((t, i) => [
    i + 1, t.inst, t.market === "lev" ? "レバ" : "現物", t.side === "BUY" ? "買い" : "売り", t.size,
    round(t.entryPrice), round(t.exitPrice), jst(t.entryTime), jst(t.exitTime),
    Math.round((t.exitTime - t.entryTime) / MIN), Math.round(t.fees || 0), Math.round(t.carry || 0),
    Math.round(t.pnl), t.exitReason, t.memo || "",
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

function round(x) {
  return Number(Number(x).toPrecision(8));
}
