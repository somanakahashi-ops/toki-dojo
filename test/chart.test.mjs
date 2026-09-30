// チャートに自分の約定を重ねる（05・04 R-35 R-36）。placeMarkers は DOM に触らない純粋な関数。
import assert from "node:assert/strict";
import test from "node:test";

import { placeMarkers } from "../js/ui/chart.js";

const MIN = 60000;
const t0 = Date.parse("2026-09-30T01:00:00Z");
// 1分足（time は描く側の時刻。ここでは分の番号で代用）
const bars = [0, 1, 2, 5].map((k) => ({ t: t0 + k * MIN, time: 100 + k }));

test("約定はその約定を含む足に乗り、足の範囲より前は出さない", () => {
  const fills = [
    { inst: "BTC", side: "BUY", time: t0 - 1 },                  // 範囲より前
    { inst: "BTC", side: "BUY", time: t0 + 30000 },              // 0分の足
    { inst: "BTC", side: "SELL", time: t0 + 2 * MIN },           // 2分の足（始まりちょうど）
    { inst: "BTC", side: "SELL", time: t0 + 3.5 * MIN },         // 空白（3・4分）の中 → 手前の2分の足
    { inst: "ETH", side: "BUY", time: t0 + 30000 },              // 別の銘柄
  ];
  const m = placeMarkers(fills, bars, "BTC");
  assert.deepEqual(m.map((x) => [x.time, x.text, x.position, x.shape]), [
    [100, "買", "belowBar", "arrowUp"], [102, "売", "aboveBar", "arrowDown"], [102, "売", "aboveBar", "arrowDown"],
  ]);
});

test("レバの新規売りは「新売」、決済は「決済」、前の記録（intent 無し）は向きだけ", () => {
  const fills = [
    { inst: "BTC_JPY", market: "lev", intent: "open", side: "SELL", time: t0 },
    { inst: "BTC_JPY", market: "lev", intent: "close", side: "BUY", time: t0 + MIN },
    { inst: "BTC_JPY", market: "lev", intent: "open", side: "BUY", time: t0 + 2 * MIN },
    { inst: "BTC_JPY", side: "SELL", time: t0 + 5 * MIN },
  ];
  assert.deepEqual(placeMarkers(fills, bars, "BTC_JPY").map((x) => x.text), ["新売", "決済", "新買", "売"]);
});

test("ティック（足の時刻は約定の時刻）では直前の約定に乗り、時刻順に並ぶ・最大100件", () => {
  const ticks = [0, 400, 900, 1500].map((ms, i) => ({ t: t0 + ms, time: i + 1 }));
  const fills = [{ inst: "XRP", side: "SELL", time: t0 + 1000 }, { inst: "XRP", side: "BUY", time: t0 + 450 }];
  assert.deepEqual(placeMarkers(fills, ticks, "XRP").map((x) => [x.time, x.text]), [[2, "買"], [3, "売"]]);
  const many = Array.from({ length: 150 }, (_, i) => ({ inst: "XRP", side: "BUY", time: t0 + 1500 + i }));
  assert.equal(placeMarkers(many, ticks, "XRP").length, 100);
});
