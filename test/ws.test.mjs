// 配信の接続（05 §5）: 購読は間を空けて1件ずつ・ERR-5003 ではつなぎ直して全部を購読し直す。
import assert from "node:assert/strict";
import test from "node:test";

import { Feed } from "../js/ws.js";

class FakeWS {
  static all = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    FakeWS.all.push(this);
  }
  send(x) { this.sent.push(JSON.parse(x)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  recv(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

test("購読は1.1秒おきに1件ずつ、ERR-5003 でつなぎ直して購読し直す", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  FakeWS.all = [];
  const got = [];
  const feed = new Feed({ onMessage: (m) => got.push(m), onStatus: () => {}, WebSocketImpl: FakeWS });
  feed.setSymbols(["BTC"]);
  feed.connect();
  const ws = FakeWS.all[0];
  ws.open();
  t.mock.timers.tick(0);
  assert.equal(ws.sent.length, 1);
  t.mock.timers.tick(1000);
  assert.equal(ws.sent.length, 1); // 1秒では次を送らない
  t.mock.timers.tick(100);
  t.mock.timers.tick(1100);
  assert.deepEqual(ws.sent.map((s) => s.channel).sort(), ["orderbooks", "ticker", "trades"]);
  ws.recv({ error: "ERR-5003 Request too many." });
  assert.equal(got.at(-1).kind, "error");
  assert.equal(feed.sock, null); // つなぎ直しに入った
  t.mock.timers.tick(1000);
  const ws2 = FakeWS.all[1];
  assert.ok(ws2);
  ws2.open();
  // 間隔はつなぎ直しをまたいでも保つ（直前の送信から1.1秒は空ける）
  for (let i = 0; i < 4; i += 1) t.mock.timers.tick(1100);
  assert.equal(ws2.sent.length, 3); // 3つとも購読し直した
  // 値が届く前は再接続の待ちを伸ばしたまま、届いたら戻す
  assert.equal(feed.retry, 1);
  ws2.recv({ channel: "trades", symbol: "BTC", price: "100", side: "BUY", size: "0.1", timestamp: "2026-09-27T10:00:00.000Z" });
  assert.equal(feed.retry, 0);
  assert.equal(feed.status, "つながっている");
});
