// 中継（relay/worker.js・05 §7.1・04 R-22）
import assert from "node:assert/strict";
import test from "node:test";

import { handle } from "../relay/worker.js";

const NOW = Date.parse("2026-09-27T23:00:00Z"); // GMO の 20260928
const R = "https://relay.example";

function run(path, { method = "GET" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response('{"status":0,"data":[]}', { status: 200 });
  };
  return handle(new Request(R + path, { method }), { now: NOW, fetchImpl }).then((res) => ({ res, calls }));
}

test("許可した組み合わせだけを、決まった取り次ぎ先へ", async () => {
  const { res, calls } = await run("/klines?symbol=BTC_JPY&interval=5min&date=20260928");
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.coin.z.com/public/v1/klines?symbol=BTC_JPY&interval=5min&date=20260928");
  assert.equal(calls[0].init.cf.cacheTtl, 30); // 今日は30秒
  assert.equal(res.headers.get("access-control-allow-origin"), "https://somanakahashi-ops.github.io");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const past = await run("/klines?symbol=BTC&interval=1hour&date=20260922");
  assert.equal(past.calls[0].init.cf.cacheTtl, 86400);
});

test("それ以外は取り次がずに断る", async () => {
  const bad = [
    "/", "/klines/x?symbol=BTC&interval=1min&date=20260928", "/public/v1/klines?symbol=BTC&interval=1min&date=20260928",
    "/klines?symbol=FOO&interval=1min&date=20260928", "/klines?symbol=BTC&interval=4hour&date=20260928",
    "/klines?symbol=BTC&interval=1min&date=2026", "/klines?symbol=BTC&interval=1min&date=20260901",
    "/klines?symbol=BTC&interval=1min&date=20261005", "/klines?symbol=BTC&interval=1min&date=20260928&x=1",
    "/klines?symbol=BTC%26x%3D1&interval=1min&date=20260928", "/klines?symbol=BTC&interval=1min",
  ];
  for (const p of bad) {
    const { res, calls } = await run(p);
    assert.ok(res.status === 400 || res.status === 404, `${p} → ${res.status}`);
    assert.equal(calls.length, 0, p);
  }
  const post = await run("/klines?symbol=BTC&interval=1min&date=20260928", { method: "POST" });
  assert.equal(post.res.status, 405);
  assert.equal(post.calls.length, 0);
  const opt = await run("/klines", { method: "OPTIONS" });
  assert.equal(opt.res.status, 204);
});

test("取り次ぎ先の失敗は中身を出さずに 502", async () => {
  const res = await handle(new Request(`${R}/klines?symbol=BTC&interval=1min&date=20260928`), {
    now: NOW, fetchImpl: async () => new Response("secret upstream error", { status: 500 }),
  });
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "upstream");
  const thrown = await handle(new Request(`${R}/klines?symbol=BTC&interval=1min&date=20260928`), {
    now: NOW, fetchImpl: async () => { throw new Error("net"); },
  });
  assert.equal(thrown.status, 502);
});
