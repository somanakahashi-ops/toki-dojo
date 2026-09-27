// 05 詳細設計 §8 のテスト（account）。偽の時計と板で動かす。
import assert from "node:assert/strict";
import test from "node:test";

import { Account, newState } from "../js/account.js";
import { Market } from "../js/market.js";

function setup({ cash = 30000, latency = 0 } = {}) {
  let local = Date.parse("2026-09-27T10:00:00Z");
  const clock = () => local;
  const market = new Market(clock);
  const events = [];
  const trades = [];
  const acc = new Account({
    state: newState(cash, local), market, clock, latency: () => latency,
    onEvent: (e) => { events.push(e); if (e.trade) trades.push(e.trade); },
  });
  const book = (sym, bid, ask, size = 10) => {
    market.update({ kind: "book", symbol: sym, t: local, asks: [{ price: ask, size }, { price: ask + 1, size }],
      bids: [{ price: bid, size }, { price: bid - 1, size }] });
    acc.onBook(sym);
  };
  const trade = (sym, price) => {
    market.update({ kind: "trade", symbol: sym, t: local, price, size: 1, side: "BUY" });
    acc.onTrade(sym, price);
  };
  const advance = (ms) => { local += ms; };
  return { acc, market, events, trades, book, trade, advance, clock };
}

test("現物の往復: 現金と損益が式どおり、取引が1件（F-4 F-5）", () => {
  const { acc, trades, book } = setup();
  book("XRP", 214, 215);
  assert.ok(acc.place({ inst: "XRP", side: "BUY", type: "MARKET", size: 10 }).ok);
  acc.step();
  // 10 × 215 = 2150円、Taker 0.05% = 1.075 → 2円
  assert.equal(acc.s.cash, 30000 - 2150 - 2);
  assert.equal(acc.s.spot.XRP.qty, 10);
  book("XRP", 220, 221);
  assert.ok(acc.place({ inst: "XRP", side: "SELL", type: "MARKET", size: 10 }).ok);
  acc.step();
  // 10 × 220 = 2200円、手数料 1.1 → 2円。損益 = 2200 − 2 − 2152 = 46
  assert.equal(trades.length, 1);
  assert.equal(trades[0].pnl, 46);
  assert.equal(acc.s.cash, 30000 + 46);
  assert.equal(acc.s.spot.XRP.qty, 0);
});

test("数量の検査と刻みの切り下げ・現金不足", () => {
  const { acc, book } = setup();
  book("BTC", 13330000, 13330001);
  assert.equal(acc.place({ inst: "BTC", side: "BUY", type: "MARKET", size: 0.000001 }).ok, false);
  const r = acc.place({ inst: "BTC", side: "BUY", type: "MARKET", size: 0.0012345 });
  assert.equal(r.ok, true);
  assert.equal(r.order.size, 0.00123);
  const big = acc.place({ inst: "BTC", side: "BUY", type: "MARKET", size: 0.01 });
  assert.equal(big.ok, false);
  assert.match(big.message, /現金が足りません/);
});

test("待機中の注文は保有を押さえる: 同じ保有に売りの指値2本は2本目を断る（04 R-5）", () => {
  const { acc, book } = setup();
  book("XRP", 214, 215);
  acc.place({ inst: "XRP", side: "BUY", type: "MARKET", size: 10 });
  acc.step();
  assert.ok(acc.place({ inst: "XRP", side: "SELL", type: "LIMIT", size: 10, price: 230 }).ok);
  acc.step();
  const second = acc.place({ inst: "XRP", side: "SELL", type: "LIMIT", size: 10, price: 231 });
  assert.equal(second.ok, false);
});

test("指値は突き抜けで Maker 約定・同じ値では約定しない", () => {
  const { acc, book, trade } = setup();
  book("XRP", 214, 215);
  acc.place({ inst: "XRP", side: "BUY", type: "LIMIT", size: 10, price: 210 });
  acc.step();
  assert.equal(acc.s.orders[0].status, "working");
  trade("XRP", 210);
  assert.equal(acc.s.orders.length, 1);
  trade("XRP", 209.999);
  assert.equal(acc.s.orders.length, 0);
  // 10 × 210 = 2100円、Maker −0.01% = 0.21 → 0円（切り捨て）
  assert.equal(acc.s.cash, 30000 - 2100);
});

test("値が古いときは注文を断り、遅れの後に古くなっていれば取り消す（N-3 R-12）", () => {
  const { acc, book, advance, events } = setup({ latency: 300 });
  assert.equal(acc.place({ inst: "XRP", side: "BUY", type: "MARKET", size: 10 }).ok, false);
  book("XRP", 214, 215);
  assert.ok(acc.place({ inst: "XRP", side: "BUY", type: "MARKET", size: 10 }).ok);
  advance(6000);
  acc.step();
  assert.equal(acc.s.orders.length, 0);
  assert.equal(acc.s.cash, 30000);
  assert.ok(events.some((e) => /値が古い/.test(e.message)));
});

test("レバ: 損切り・利確は OCO、一部決済で数量が合う（04 R-7）", () => {
  const { acc, book, trade, trades } = setup({ cash: 100000 });
  book("XRP_JPY", 214, 215, 1000);
  assert.ok(acc.place({ inst: "XRP_JPY", side: "BUY", type: "MARKET", size: 100, intent: "open", sl: 205, tp: 230 }).ok);
  acc.step();
  const pos = acc.s.lev[0];
  assert.equal(pos.size, 100);
  assert.equal(acc.s.orders.filter((o) => o.role).length, 2);
  assert.ok(acc.place({ inst: "XRP_JPY", side: "SELL", type: "MARKET", size: 40, intent: "close", positionId: pos.id }).ok);
  acc.step();
  assert.equal(acc.s.lev[0].size, 60);
  for (const o of acc.s.orders.filter((x) => x.role)) assert.equal(o.remaining, 60);
  trade("XRP_JPY", 230.5);
  assert.equal(acc.s.lev.length, 0);
  assert.equal(acc.s.orders.length, 0); // 利確が約定し、損切りは取り消し
  assert.equal(trades.at(-1).exitReason, "利確");
});

test("強制決済: 維持率 75% 割れで全建玉を決済し、板が薄くても残さない（04 R-4 R-6）", () => {
  const { acc, market, book, events } = setup({ cash: 10000 });
  book("XRP_JPY", 214, 215, 1000);
  assert.ok(acc.place({ inst: "XRP_JPY", side: "BUY", type: "MARKET", size: 80, intent: "open" }).ok);
  acc.step();
  // 必要証拠金 80×215/2 = 8,600円。現金は約1,400円
  market.update({ kind: "book", symbol: "XRP_JPY", t: 0, asks: [{ price: 101, size: 5 }], bids: [{ price: 100, size: 5 }] });
  acc.onBook("XRP_JPY");
  assert.equal(acc.s.lev.length, 0);
  assert.ok(events.some((e) => e.type === "liquidation"));
});

test("空白の後は待機中の注文を取り消し、建玉管理料を追いつかせる", () => {
  const { acc, book, advance } = setup({ cash: 100000 });
  book("XRP_JPY", 214, 215, 1000);
  acc.place({ inst: "XRP_JPY", side: "BUY", type: "MARKET", size: 100, intent: "open" });
  acc.step();
  acc.place({ inst: "XRP_JPY", side: "SELL", type: "LIMIT", size: 100, intent: "close", positionId: acc.s.lev[0].id, price: 240 });
  acc.step();
  const cashBefore = acc.s.cash;
  advance(26 * 3600000); // UTC 10時 → 翌日12時（20時を1回またぐ）
  const n = acc.onGap();
  assert.equal(n, 1);
  // 建値 100×215 = 21,500円 × 0.04% = 8.6 → 9円
  assert.equal(acc.s.cash, cashBefore - 9);
});

test("同時に扱える銘柄は上限まで（04 R-8）", () => {
  const { acc, book } = setup({ cash: 1000000 });
  const syms = ["XRP", "ADA", "XLM", "DOGE", "SOL"];
  for (const s of syms) {
    book(s, 100, 101);
    assert.ok(acc.place({ inst: s, side: "BUY", type: "LIMIT", size: 10, price: 50 }).ok);
  }
  book("ETH", 400000, 400001);
  const r = acc.place({ inst: "ETH", side: "BUY", type: "LIMIT", size: 0.001, price: 300000 });
  assert.equal(r.ok, false);
  assert.match(r.message, /銘柄まで/);
});

test("板が足りない成行の新規は、約定したぶんだけ建て、残りは取り消して知らせる", () => {
  const { acc, book, events } = setup({ cash: 100000 });
  book("XRP_JPY", 214, 215, 10);
  acc.place({ inst: "XRP_JPY", side: "BUY", type: "MARKET", size: 100, intent: "open" });
  acc.step();
  assert.equal(acc.s.lev[0].size, 20);
  assert.ok(events.some((e) => /板の厚みが足りず/.test(e.message)));
  assert.equal(acc.s.reserved.cash, 0); // 押さえた証拠金は全部戻る
});

test("全部を決済した注文は「約定」で残り、付いていた損切り・利確だけが取り消しになる", () => {
  const { acc, book, trade } = setup({ cash: 100000 });
  book("XRP_JPY", 214, 215, 1000);
  acc.place({ inst: "XRP_JPY", side: "BUY", type: "MARKET", size: 100, intent: "open", sl: 205, tp: 230 });
  acc.step();
  const pos = acc.s.lev[0];
  acc.place({ inst: "XRP_JPY", side: "SELL", type: "MARKET", size: 100, intent: "close", positionId: pos.id });
  acc.step();
  const [close, ...rest] = acc.s.history;
  assert.equal(close.status, "filled");
  assert.match(close.label, /決済 成行/);
  assert.deepEqual(rest.slice(0, 2).map((h) => h.status), ["canceled", "canceled"]);
  // 利確で全部が決まった場合も、利確の注文は「約定」
  acc.place({ inst: "XRP_JPY", side: "BUY", type: "MARKET", size: 100, intent: "open", sl: 205, tp: 230 });
  acc.step();
  trade("XRP_JPY", 230.5);
  assert.equal(acc.s.history.find((h) => /@230/.test(h.label)).status, "filled");
});
