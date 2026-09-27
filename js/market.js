// 銘柄ごとの相場の状態（03 §1・05 §5）。
import { FRESH_MS, TAPE_KEEP } from "./config.js";

export class Market {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.state = new Map();
    this.serverOffset = 0; // サーバーの時刻 − 端末の時刻（最後に受け取った電文から）
  }

  get(sym) {
    if (!this.state.has(sym)) {
      this.state.set(sym, { asks: [], bids: [], bookAt: 0, bookT: 0, last: null, lastT: 0, ticker: null, tape: [] });
    }
    return this.state.get(sym);
  }

  update(msg) {
    const s = this.get(msg.symbol);
    const local = this.now();
    this.serverOffset = msg.t - local;
    if (msg.kind === "book") {
      s.asks = msg.asks;
      s.bids = msg.bids;
      s.bookAt = local;
      s.bookT = msg.t;
    } else if (msg.kind === "trade") {
      s.last = msg.price;
      s.lastT = msg.t;
      s.tape.unshift({ t: msg.t, price: msg.price, size: msg.size, side: msg.side });
      if (s.tape.length > TAPE_KEEP) s.tape.length = TAPE_KEEP;
    } else if (msg.kind === "ticker") {
      s.ticker = msg;
      if (s.last === null) s.last = msg.last;
    }
    return s;
  }

  bestBid(sym) {
    const s = this.get(sym);
    return s.bids.length ? s.bids[0].price : null;
  }

  bestAsk(sym) {
    const s = this.get(sym);
    return s.asks.length ? s.asks[0].price : null;
  }

  // 板がこれより古ければ注文しない（N-3）
  isFresh(sym, local = this.now()) {
    const s = this.get(sym);
    return s.bookAt > 0 && local - s.bookAt <= FRESH_MS && s.asks.length > 0 && s.bids.length > 0;
  }

  // 「今」のサーバーの時刻
  serverNow(local = this.now()) {
    return local + this.serverOffset;
  }
}
