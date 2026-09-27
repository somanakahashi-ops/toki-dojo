// 05 詳細設計 §8 のテスト（engine・validate・review）。node --test で走らせる。
import assert from "node:assert/strict";
import test from "node:test";

import * as E from "../js/engine.js";
import { csvCell, randomCompare, startCandidates, stats, toCsv } from "../js/review.js";
import { message, rejected } from "../js/validate.js";

test("手数料は円未満切り上げ、リベートは切り捨て（負の手数料）", () => {
  assert.equal(E.feeYen(3675, 0.0005), 2); // 1.84円 → 2円
  assert.equal(E.feeYen(3675, 0.0009), 4); // 3.31円 → 4円
  assert.equal(E.feeYen(3675, -0.0001), 0); // 0.37円のリベート → 0円
  assert.equal(E.feeYen(100000, -0.0003), -30);
  assert.equal(E.feeYen(1000, 0), 0);
});

test("数量は刻みに切り下げ、値段は向きで丸める", () => {
  assert.equal(E.floorStep(0.000123, 0.00001), 0.00012);
  assert.equal(E.floorStep(12.7, 1), 12);
  assert.equal(E.floorStep(0.3, 0.1), 0.3);
  assert.equal(E.roundTick(13355400.6, 1, "down"), 13355400);
  assert.equal(E.roundTick(215.4321, 0.001, "up"), 215.433);
});

const asks = [{ price: 100, size: 1 }, { price: 101, size: 2 }, { price: 103, size: 5 }];

test("成行は板を上から食う（加重平均）・足りなければ残る・決済は最後の段で残りも約定", () => {
  const r = E.sweep(asks, 2);
  assert.equal(r.filled, 2);
  assert.equal(r.avgPrice, 100.5);
  const thin = E.sweep(asks, 10);
  assert.equal(thin.remainder, 2);
  const close = E.sweep(asks, 10, { fillRemainder: true });
  assert.equal(close.remainder, 0);
  assert.equal(close.filled, 10);
  assert.equal(close.notional, 100 + 202 + 515 + 2 * 103);
});

test("指値で今すぐ約定できるぶんは、指値を超える段を食わない", () => {
  const r = E.sweepLimit(asks, 5, 101, "BUY");
  assert.equal(r.filled, 3);
  assert.equal(r.remainder, 2);
});

test("待機中の指値: 突き抜け・気配の逆転で約定、同じ値では約定しない（04 R-3）", () => {
  assert.equal(E.limitHit("BUY", 100, { trade: 100 }), false);
  assert.equal(E.limitHit("BUY", 100, { trade: 99.9 }), true);
  assert.equal(E.limitHit("BUY", 100, { bestAsk: 99 }), true);
  assert.equal(E.limitHit("SELL", 100, { trade: 100 }), false);
  assert.equal(E.limitHit("SELL", 100, { bestBid: 100.5 }), true);
});

test("逆指値は最終約定が線を越えたら発火（04 R-11）", () => {
  assert.equal(E.stopHit("SELL", 100, 100), true);
  assert.equal(E.stopHit("SELL", 100, 100.1), false);
  assert.equal(E.stopHit("BUY", 100, 99.9), false);
});

test("評価損益は決済する側の気配・維持率の式（04 R-6）", () => {
  assert.equal(E.unrealized({ side: "BUY", entryPrice: 100, size: 2 }, 99, 101), -2);
  assert.equal(E.unrealized({ side: "SELL", entryPrice: 100, size: 2 }, 99, 101), -2);
  assert.equal(E.requiredMargin([{ entryPrice: 100, size: 2 }]), 100);
  assert.equal(E.marginRatio(0, 100, -30, 100), 0.7);
  assert.equal(E.marginRatio(10, 0, 0, 0), Infinity);
});

test("建玉管理料は UTC 20時をまたいだ回数だけ", () => {
  const t = (s) => Date.parse(s);
  assert.equal(E.carryCount(t("2026-09-27T19:00:00Z"), t("2026-09-27T19:59:59Z")), 0);
  assert.equal(E.carryCount(t("2026-09-27T19:00:00Z"), t("2026-09-27T20:00:00Z")), 1);
  assert.equal(E.carryCount(t("2026-09-27T20:00:00Z"), t("2026-09-28T19:00:00Z")), 0); // ちょうどは前の回に数えた
  assert.equal(E.carryCount(t("2026-09-27T10:00:00Z"), t("2026-09-30T10:00:00Z")), 3);
  assert.equal(E.carryYen(100000), 40);
});

test("電文の検査: 壊れた・巨大・負の値・知らない銘柄・段の多すぎを捨てる", () => {
  const syms = new Set(["BTC"]);
  const before = rejected.count;
  assert.equal(message("{bad", syms), null);
  assert.equal(message("x".repeat(300000), syms), null);
  assert.equal(message(JSON.stringify({ channel: "trades", symbol: "BTC", price: "-1", size: "1", side: "BUY", timestamp: "2026-09-27T00:00:00Z" }), syms), null);
  assert.equal(message(JSON.stringify({ channel: "trades", symbol: "ETH", price: "1", size: "1", side: "BUY", timestamp: "2026-09-27T00:00:00Z" }), syms), null);
  assert.equal(rejected.count, before + 4);
  const many = Array.from({ length: 150 }, (_, i) => ({ price: String(100 + i), size: "1" }));
  const b = message(JSON.stringify({ channel: "orderbooks", symbol: "BTC", asks: many, bids: [{ price: "99", size: "1" }], timestamp: "2026-09-27T00:00:00Z" }), syms);
  assert.equal(b.asks.length, 100);
  const ok = message(JSON.stringify({ channel: "trades", symbol: "BTC", price: "13330000", size: "0.0001", side: "SELL", timestamp: "2026-09-27T13:01:12.933Z" }), syms);
  assert.deepEqual([ok.kind, ok.price, ok.side], ["trade", 13330000, "SELL"]);
});

test("CSV のセルは数式にならない", () => {
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("-5"), "'-5");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  const csv = toCsv([{ inst: "BTC", market: "spot", side: "BUY", size: 0.001, entryPrice: 1, exitPrice: 2, entryTime: 0, exitTime: 60000, pnl: 1, memo: "@cmd", exitReason: "手動" }]);
  assert.ok(csv.includes("'@cmd"));
});

test("最大DD は確定損益の累計（04 R-9）", () => {
  const s = stats([{ pnl: 100, exitTime: 1, entryTime: 0 }, { pnl: -300, exitTime: 2, entryTime: 0 }, { pnl: 50, exitTime: 3, entryTime: 0 }], 30000);
  assert.equal(s.maxDdYen, 300);
  assert.equal(s.maxDdPct, 1);
  assert.equal(s.winRate, 2 / 3);
});

function quotes(n, t0 = Date.parse("2026-09-27T00:00:00Z"), gapAt = -1) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    if (i === gapAt) continue;
    const mid = 100 + Math.sin(i / 7) * 2;
    out.push({ inst: "XRP", t: t0 + i * 60000, bid: mid - 0.01, ask: mid + 0.01 });
  }
  return out;
}

function tr(i, pnl, holdMin = 5) {
  const t0 = Date.parse("2026-09-27T00:00:00Z") + i * 60000;
  return { inst: "XRP", market: "spot", side: "BUY", size: 10, entryTime: t0, exitTime: t0 + holdMin * 60000, pnl,
    liquidity: { entry: "taker", exit: "taker" } };
}

test("偶然との比較: 20件未満は判定できない・空白をまたぐ取引は外す・シードで同じ結果（04 R-2）", () => {
  const q = { XRP: quotes(300) };
  const few = randomCompare(Array.from({ length: 5 }, (_, i) => tr(i, 1)), q);
  assert.equal(few.status, "insufficient");
  const many = Array.from({ length: 25 }, (_, i) => tr(i, 50));
  const a = randomCompare(many, q);
  const b = randomCompare(many, q);
  assert.equal(a.status, "ok");
  assert.equal(a.percentile, b.percentile);
  assert.ok(a.percentile > 90); // 1件 +50円は偶然（手数料・スプレッド込み）より十分良い
  const long = tr(0, 1, 400); // 400分連続の区間が無い → 外す
  const r = randomCompare([...many, long], q);
  assert.equal(r.excluded, 1);
  // 5分目が欠けた列: 番号 0〜4 が 0〜4分、番号5以降が 6分〜。3分連続の開始点は番号 0・1・5
  assert.deepEqual(startCandidates(quotes(10, 0, 5), 3), [0, 1, 5]);
});
