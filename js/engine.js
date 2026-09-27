// 約定の規約（05 詳細設計 §2）。すべて純粋な関数: DOM・保存・時計に触らない。
import { CARRY_RATE, CARRY_UTC_HOUR, LEVERAGE } from "./config.js";

const EPS = 1e-9;

export function decimals(step) {
  const s = String(step);
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

export function floorStep(x, step) {
  if (!(x > 0)) return 0;
  const n = Math.floor(x / step + EPS);
  return Number((n * step).toFixed(decimals(step)));
}

export function roundTick(p, tick, dir = "down") {
  const q = p / tick;
  const n = dir === "up" ? Math.ceil(q - EPS) : Math.floor(q + EPS);
  return Number((n * tick).toFixed(decimals(tick)));
}

// 手数料（円）。正の率は円未満切り上げ、負の率（Maker のリベート）は円未満切り捨てで負の手数料
export function feeYen(notional, rate) {
  if (!rate || !(notional > 0)) return 0;
  if (rate > 0) return Math.ceil(notional * rate - EPS);
  const r = Math.floor(notional * -rate + EPS);
  return r ? -r : 0; // -0 にしない
}

// 板（良い順）を上から食う。fillRemainder=true（決済）なら足りない残りを最後の段の値段で約定させる（04 R-4）
export function sweep(levels, size, { fillRemainder = false } = {}) {
  let left = size;
  let notional = 0;
  let filled = 0;
  let used = 0;
  let worst = null;
  for (const lv of levels) {
    if (left <= EPS) break;
    const take = Math.min(left, lv.size);
    if (take <= 0) continue;
    notional += take * lv.price;
    filled += take;
    left -= take;
    worst = lv.price;
    used += 1;
  }
  let remainder = left > EPS ? left : 0;
  if (remainder > 0 && fillRemainder && worst !== null) {
    notional += remainder * worst;
    filled += remainder;
    remainder = 0;
  }
  return { filled, avgPrice: filled > 0 ? notional / filled : null, notional, remainder, levelsUsed: used, worst };
}

// 指値で今すぐ約定できるぶん。買いは 値段≤指値、売りは 値段≥指値 の段だけ食う
export function sweepLimit(levels, size, limit, side) {
  const ok = side === "BUY" ? levels.filter((lv) => lv.price <= limit) : levels.filter((lv) => lv.price >= limit);
  return sweep(ok, size);
}

// 待機中の指値が約定したか（突き抜け・気配の逆転）。等しいだけでは約定しない（04 R-3）
export function limitHit(side, limit, { trade = null, bestBid = null, bestAsk = null } = {}) {
  if (side === "BUY") return (trade !== null && trade < limit) || (bestAsk !== null && bestAsk < limit);
  return (trade !== null && trade > limit) || (bestBid !== null && bestBid > limit);
}

// 逆指値の発火（最終約定で判定。04 R-11）
export function stopHit(side, stop, trade) {
  if (trade === null || trade === undefined) return false;
  return side === "BUY" ? trade >= stop : trade <= stop;
}

export function direction(side) {
  return side === "BUY" ? 1 : -1;
}

// 評価損益は決済する側の気配で（買い建ては bid で売る・売り建ては ask で買い戻す）
export function unrealized(pos, bestBid, bestAsk) {
  if (pos.side === "BUY") return bestBid === null ? 0 : (bestBid - pos.entryPrice) * pos.size;
  return bestAsk === null ? 0 : (pos.entryPrice - bestAsk) * pos.size;
}

export function requiredMargin(positions) {
  return positions.reduce((a, p) => a + (p.entryPrice * p.size) / LEVERAGE, 0);
}

export function marginRatio(cash, locked, unreal, required) {
  if (!(required > 0)) return Infinity;
  return (cash + locked + unreal) / required;
}

// (fromMs, toMs] に含まれる UTC hour:00 の回数
export function carryCount(fromMs, toMs, hour = CARRY_UTC_HOUR) {
  if (!(toMs > fromMs)) return 0;
  const H = 3600000;
  const D = 24 * H;
  const first = Math.floor((fromMs - hour * H) / D) * D + hour * H;
  let n = 0;
  for (let t = first; t <= toMs; t += D) if (t > fromMs && t <= toMs) n += 1;
  return n;
}

export function carryYen(entryNotional) {
  return Math.ceil(entryNotional * CARRY_RATE - EPS);
}

export function pnlSpotClose(size, price, fee, avgCost) {
  return size * price - fee - avgCost * size;
}

// レバの決済の損益。建てた時の手数料と建玉管理料は数量で按分する
export function pnlLevClose(pos, size, price, fee) {
  const share = pos.size > 0 ? size / pos.size : 1;
  const gross = direction(pos.side) * (price - pos.entryPrice) * size;
  return gross - fee - (pos.entryFee || 0) * share - (pos.carry || 0) * share;
}
