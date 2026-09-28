// 約定から1分足、板から1分ごとの最良気配を作る（05 §6）。購読中の全銘柄について作る（04 R-1）。
import { TICK_KEEP } from "./config.js";

const MIN = 60000;

function tradeKey(k) {
  return `${k.t}|${k.price}|${k.size}|${k.side}`;
}

export class Candles {
  constructor(store) {
    this.store = store;
    this.bars = new Map(); // inst -> Map(t -> candle)
    this.quotes = new Map(); // inst -> Map(t -> {inst,t,bid,ask})
    this.live = new Map(); // inst -> 進行中の分 {candle, quote}
    this.hist = new Map(); // `${inst}|${frame}` -> 過去の足（中継から。見るためだけ）
    this.ticks = new Map(); // inst -> [{seq, t, price, size, side}]（記憶だけ・最大 TICK_KEEP）
    this.nextSeq = new Map();
  }

  load(candles, quotes) {
    for (const c of candles) this.map(this.bars, c.inst).set(c.t, c);
    for (const q of quotes) this.map(this.quotes, q.inst).set(q.t, q);
  }

  map(m, inst) {
    if (!m.has(inst)) m.set(inst, new Map());
    return m.get(inst);
  }

  cur(inst) {
    if (!this.live.has(inst)) this.live.set(inst, { candle: null, quote: null });
    return this.live.get(inst);
  }

  onTrade(inst, price, size, t, side = "BUY") {
    this.addTick(inst, { t, price, size, side });
    const m = Math.floor(t / MIN) * MIN;
    const c = this.cur(inst);
    if (c.candle && c.candle.t !== m) this.close(inst);
    if (!c.candle) c.candle = { inst, t: m, o: price, h: price, l: price, c: price, v: 0 };
    const k = c.candle;
    k.h = Math.max(k.h, price);
    k.l = Math.min(k.l, price);
    k.c = price;
    k.v += size;
    this.map(this.bars, inst).set(m, k);
  }

  onBook(inst, bid, ask, t) {
    if (bid === null || ask === null) return;
    const m = Math.floor(t / MIN) * MIN;
    const c = this.cur(inst);
    if (c.quote && c.quote.t !== m) {
      this.map(this.quotes, inst).set(c.quote.t, c.quote);
      this.store?.add("quotes", c.quote);
    }
    c.quote = { inst, t: m, bid, ask };
    this.map(this.quotes, inst).set(m, c.quote);
  }

  close(inst) {
    const c = this.cur(inst);
    if (c.candle) this.store?.add("candles", c.candle);
    c.candle = null;
  }

  // 画面を閉じる前に、進行中の分も保存しておく（閉じずに書くだけ。再開後も同じ分なら上書きされる）
  flush() {
    for (const c of this.live.values()) {
      if (c.candle) this.store?.add("candles", c.candle);
      if (c.quote) this.store?.add("quotes", c.quote);
    }
  }

  addTick(inst, k) {
    const arr = this.ticks.get(inst) || [];
    const seq = this.nextSeq.get(inst) || 0;
    arr.push({ seq, ...k });
    this.nextSeq.set(inst, seq + 1);
    if (arr.length > TICK_KEEP) arr.splice(0, arr.length - TICK_KEEP); // 番号はそのまま（04 R-31）
    this.ticks.set(inst, arr);
  }

  // 過去の約定（古い順）＋それ以降の配信の約定で作り直し、番号を振り直す（04 R-30）
  seedTicks(inst, list) {
    const seen = new Set(list.map(tradeKey));
    const last = list.length ? list[list.length - 1].t : -Infinity;
    const live = (this.ticks.get(inst) || []).filter((k) => k.t >= last && !seen.has(tradeKey(k)));
    const all = [...list, ...live].slice(-TICK_KEEP).map((k, seq) => ({ seq, t: k.t, price: k.price, size: k.size, side: k.side }));
    this.ticks.set(inst, all);
    this.nextSeq.set(inst, all.length);
  }

  // n=1 は約定ごとの点（線）。n>1 は floor(seq/n) で束ねたローソク足。x は横軸の番号
  tickSeries(inst, n) {
    const arr = this.ticks.get(inst) || [];
    if (n === 1) return arr.map((k) => ({ x: k.seq, t: k.t, o: k.price, h: k.price, l: k.price, c: k.price, v: k.size }));
    const out = [];
    let cur = null;
    for (const k of arr) {
      const g = Math.floor(k.seq / n);
      if (!cur || cur.x !== g) {
        cur = { x: g, t: k.t, o: k.price, h: k.price, l: k.price, c: k.price, v: 0 };
        out.push(cur);
      }
      cur.h = Math.max(cur.h, k.price);
      cur.l = Math.min(cur.l, k.price);
      cur.c = k.price;
      cur.v += k.size;
    }
    return out;
  }

  // いちばん新しい約定の値段（配信の最初の約定が来るまで、上の帯に出すため）
  lastPrice(inst) {
    const arr = this.ticks.get(inst);
    if (arr && arr.length) return arr[arr.length - 1].price;
    const bars = this.series(inst, 1);
    return bars.length ? bars[bars.length - 1].c : null;
  }

  seed(inst, frame, bars) {
    this.hist.set(`${inst}|${frame}`, bars);
  }

  // 過去の足と配信の足を重ねる（04 R-25）。同じ時刻は 始値＝過去・高安＝広い方・終値＝配信
  series(inst, frame) {
    const live = this.liveSeries(inst, frame);
    const hist = this.hist.get(`${inst}|${frame}`);
    if (!hist || !hist.length) return live;
    const byT = new Map(hist.map((b) => [b.t, { ...b, inst }]));
    for (const k of live) {
      const h = byT.get(k.t);
      byT.set(k.t, h ? { inst, t: k.t, o: h.o, h: Math.max(h.h, k.h), l: Math.min(h.l, k.l), c: k.c, v: Math.max(h.v, k.v) } : k);
    }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  }

  // frame 分の足に束ねる。欠けた分は作らない（チャートでは空白）
  liveSeries(inst, frame) {
    const src = [...this.map(this.bars, inst).values()].sort((a, b) => a.t - b.t);
    if (frame === 1) return src;
    const out = [];
    let cur = null;
    for (const k of src) {
      const t = Math.floor(k.t / (frame * MIN)) * frame * MIN;
      if (!cur || cur.t !== t) {
        cur = { inst, t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v };
        out.push(cur);
      } else {
        cur.h = Math.max(cur.h, k.h);
        cur.l = Math.min(cur.l, k.l);
        cur.c = k.c;
        cur.v += k.v;
      }
    }
    return out;
  }

  quoteSeries(inst) {
    return [...this.map(this.quotes, inst).values()].sort((a, b) => a.t - b.t);
  }

  allQuotes() {
    const out = {};
    for (const inst of this.quotes.keys()) out[inst] = this.quoteSeries(inst);
    return out;
  }
}
