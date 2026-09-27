// 約定から1分足、板から1分ごとの最良気配を作る（05 §6）。購読中の全銘柄について作る（04 R-1）。
const MIN = 60000;

export class Candles {
  constructor(store) {
    this.store = store;
    this.bars = new Map(); // inst -> Map(t -> candle)
    this.quotes = new Map(); // inst -> Map(t -> {inst,t,bid,ask})
    this.live = new Map(); // inst -> 進行中の分 {candle, quote}
    this.hist = new Map(); // `${inst}|${frame}` -> 過去の足（中継から。見るためだけ）
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

  onTrade(inst, price, size, t) {
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
