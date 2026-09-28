// 過去の足（05 §7.1・04 R-25）
import assert from "node:assert/strict";
import test from "node:test";

import { SPECS } from "../js/config.js";
import { Candles } from "../js/candles.js";
import { History, gmoDate, parseKlines } from "../js/history.js";
import * as worker from "../relay/worker.js";

test("GMO の日付は日本時間の朝6時で変わる（アプリと中継で同じ）", () => {
  // 2026-09-27 20:59 UTC = 9/28 05:59 JST → 20260927、21:00 UTC = 9/28 06:00 JST → 20260928
  assert.equal(gmoDate(Date.parse("2026-09-27T20:59:59Z")), "20260927");
  assert.equal(gmoDate(Date.parse("2026-09-27T21:00:00Z")), "20260928");
  for (const t of [0, 1790456400000, 1790542740000, Date.now()]) assert.equal(worker.gmoDate(t), gmoDate(t));
});

test("中継の銘柄はアプリの銘柄と同じ", () => {
  assert.deepEqual([...worker.SYMBOLS].sort(), Object.keys(SPECS).sort());
});

const row = (t, o = "100", h = "110", l = "90", c = "105", v = "1") => ({ openTime: String(t), open: o, high: h, low: l, close: c, volume: v });

test("parseKlines: 壊れた値・区切りに合わない時刻・高安の矛盾は全体を捨てる", () => {
  const t = 1790456400000;
  assert.deepEqual(parseKlines({ status: 0, data: [row(t)] }, 1), [{ t, o: 100, h: 110, l: 90, c: 105, v: 1 }]);
  assert.deepEqual(parseKlines({ status: 2, messages: [{ message_code: "ERR-5207" }] }, 1), []); // その日のぶんが無い
  assert.equal(parseKlines({ status: 0, data: [row(t + 1000)] }, 1), null);
  assert.equal(parseKlines({ status: 0, data: [row(t + 60000)] }, 5), null);
  assert.equal(parseKlines({ status: 0, data: [row(t), row(t + 60000, "abc")] }, 1), null);
  assert.equal(parseKlines({ status: 0, data: [row(t, "100", "99")] }, 1), null); // 高値 < 始値
  assert.equal(parseKlines({ status: 0, data: [row(t, "100", "110", "90", "105", "-1")] }, 1), null);
  assert.equal(parseKlines({ status: 0, data: Array.from({ length: 1501 }, (_, i) => row(t + i * 60000)) }, 1), null);
  assert.equal(parseKlines("<html>", 1), null);
});

test("History.load: 足りるまで前の日を取り、中継が無ければ何もしない・失敗は投げる", async () => {
  const now = Date.parse("2026-09-27T23:00:00Z"); // GMO の 20260928
  const urls = [];
  const base = Date.parse("2026-09-27T21:00:00Z");
  const fetchImpl = async (url) => {
    urls.push(url);
    const date = new URL(url).searchParams.get("date");
    const start = date === "20260928" ? base : base - 86400000;
    const n = date === "20260928" ? 30 : 200; // 今日はまだ30本
    return { ok: true, json: async () => ({ status: 0, data: Array.from({ length: n }, (_, i) => row(start + i * 60000)) }) };
  };
  const h = new History({ relay: "https://relay.example", fetchImpl, now: () => now });
  const bars = await h.load("BTC", 1);
  assert.equal(bars.length, 230);
  assert.ok(bars.every((b, i) => i === 0 || b.t > bars[i - 1].t));
  assert.deepEqual(urls.map((u) => new URL(u).searchParams.get("date")), ["20260928", "20260927"]);
  assert.match(urls[0], /^https:\/\/relay\.example\/klines\?symbol=BTC&interval=1min&date=20260928$/);
  await h.load("BTC", 1);
  assert.equal(urls.length, 2); // 60秒は取り直さない
  assert.equal(await new History({ relay: "", fetchImpl }).load("BTC", 1), null);
  const bad = new History({ relay: "https://relay.example", fetchImpl: async () => ({ ok: false, status: 502 }), now: () => now });
  await assert.rejects(bad.load("BTC", 1));
  await assert.rejects(bad.load("BTC", 1)); // 失敗は取り置かず、次も取りに行く
});

test("candles: 同じ分は 始値＝過去・高安＝広い方・終値＝配信（04 R-25）", () => {
  const c = new Candles(null);
  const t0 = Date.parse("2026-09-27T23:00:00Z");
  c.seed("BTC", 1, [{ t: t0 - 60000, o: 90, h: 95, l: 85, c: 92, v: 1 }, { t: t0, o: 100, h: 104, l: 99, c: 101, v: 2 }]);
  c.onTrade("BTC", 106, 0.1, t0 + 30000); // 開いた分の途中から
  c.onTrade("BTC", 98, 0.1, t0 + 40000);
  c.onTrade("BTC", 103, 0.1, t0 + 61000); // 次の分（配信だけ）
  const s = c.series("BTC", 1);
  assert.deepEqual(s.map((b) => [b.t - t0, b.o, b.h, b.l, b.c]), [[-60000, 90, 95, 85, 92], [0, 100, 106, 98, 98], [60000, 103, 103, 103, 103]]);
  assert.equal(c.series("ETH", 1).length, 0);
});

const tr = (ms, price = "100", size = "0.1", side = "BUY") => ({ timestamp: new Date(ms).toISOString(), price, size, side });

test("parseTrades: 壊れた約定は全体を捨てる", async () => {
  const { parseTrades } = await import("../js/history.js");
  const t = Date.parse("2026-09-28T10:00:00.123Z");
  assert.deepEqual(parseTrades({ status: 0, data: { list: [tr(t)] } }), [{ t, price: 100, size: 0.1, side: "BUY" }]);
  assert.deepEqual(parseTrades({ status: 5, messages: [] }), []);
  assert.equal(parseTrades({ status: 0, data: { list: [tr(t, "0")] } }), null);
  assert.equal(parseTrades({ status: 0, data: { list: [tr(t, "100", "0.1", "HOLD")] } }), null);
  assert.equal(parseTrades({ status: 0, data: { list: [{ ...tr(t), timestamp: "x" }] } }), null);
  assert.equal(parseTrades({ status: 0, data: { list: Array.from({ length: 101 }, (_, i) => tr(t + i)) } }), null);
});

test("History.trades: ページのずれの重複を除き、古い順・1,000件で止まる（04 R-28）", async () => {
  const base = Date.parse("2026-09-28T10:00:00Z");
  // 新しい順に 1500件。2ページ目を取る前に新しい約定が3件入り、ページが3件ずれる
  let extra = 0;
  const all = () => Array.from({ length: 1500 + extra }, (_, i) => tr(base + (1500 + extra - i) * 1000, String(100 + ((1500 + extra - i) % 7))));
  const pages = [];
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    pages.push(page);
    if (page === 2) extra = 3;
    const list = all().slice((page - 1) * 100, page * 100);
    return { ok: true, json: async () => ({ status: 0, data: { list } }) };
  };
  const h = new History({ relay: "https://relay.example", fetchImpl, now: () => base });
  const got = await h.trades("BTC");
  assert.ok(got.every((k, i) => i === 0 || k.t > got[i - 1].t)); // 重複なし・古い順
  assert.ok(got.length >= 997 && got.length <= 1000);
  assert.equal(pages.at(-1), 10);
  // 足りないページ（100件未満）で止まる
  const few = new History({ relay: "https://relay.example", now: () => base,
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 0, data: { list: [tr(base)] } }) }) });
  assert.equal((await few.trades("ETH")).length, 1);
});

test("ティック: N で束ねた区切りは約定が増えても動かず、5,000件で古い方を捨てる（04 R-30 R-31）", () => {
  const c = new Candles(null);
  const t0 = Date.parse("2026-09-28T10:00:00Z");
  c.seedTicks("BTC", Array.from({ length: 25 }, (_, i) => ({ t: t0 + i * 1000, price: 100 + i, size: 1, side: "BUY" })));
  const before = c.tickSeries("BTC", 10);
  assert.deepEqual(before.map((b) => [b.x, b.o, b.c]), [[0, 100, 109], [1, 110, 119], [2, 120, 124]]);
  c.onTrade("BTC", 90, 1, t0 + 30000, "SELL");
  const after = c.tickSeries("BTC", 10);
  assert.deepEqual(after.slice(0, 2), before.slice(0, 2)); // 前の足は変わらない
  assert.deepEqual([after[2].l, after[2].c], [90, 90]);
  assert.equal(c.tickSeries("BTC", 1).length, 26);
  // 過去の約定を取り直したとき、配信で先に来ていた同じ約定は重ねない
  c.seedTicks("BTC", Array.from({ length: 26 }, (_, i) => (i < 25 ? { t: t0 + i * 1000, price: 100 + i, size: 1, side: "BUY" } : { t: t0 + 30000, price: 90, size: 1, side: "SELL" })));
  assert.equal(c.tickSeries("BTC", 1).length, 26);
  for (let i = 0; i < 5100; i += 1) c.onTrade("BTC", 100, 1, t0 + 60000 + i, "BUY");
  const line = c.tickSeries("BTC", 1);
  assert.equal(line.length, 5000);
  assert.equal(line.at(-1).x, 26 + 5100 - 1); // 番号はそのまま
});
