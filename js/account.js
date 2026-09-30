// 口座・注文・建玉（03 §2〜3・05 §3）。DOM にも保存にも直接触らない（onEvent で外へ知らせる）。
import {
  LEVERAGE, LOSSCUT_RATIO, MAX_INSTRUMENTS, SPECS, parseInst,
} from "./config.js";
import {
  carryCount, carryYen, feeYen, floorStep, limitHit, marginRatio, pnlLevClose, pnlSpotClose,
  roundTick, stopHit, sweep, sweepLimit, unrealized,
} from "./engine.js";

const TINY = 1e-12;

export function newState(initialCash, serverNow) {
  return {
    version: 1, seq: 0, initialCash, cash: initialCash, locked: 0,
    spot: {}, lev: [], orders: [], history: [],
    reserved: { cash: 0, spot: {} },
    lastCarryAt: serverNow, createdAt: serverNow,
  };
}

function fmtYen(x) {
  return `${Math.round(x).toLocaleString("ja-JP")}円`;
}

export class Account {
  // market: Market。clock: 端末の時刻（ms）。latency: () => ms。onEvent: ({type, message, trade, fill}) => void
  constructor({ state, market, clock = () => Date.now(), latency = () => 300, onEvent = () => {} }) {
    this.s = state;
    this.market = market;
    this.clock = clock;
    this.latency = latency;
    this.onEvent = onEvent;
  }

  nextId(prefix) {
    this.s.seq += 1;
    return `${prefix}${this.s.seq}`;
  }

  emit(type, message, extra = {}) {
    this.onEvent({ type, message, ...extra });
  }

  // 注文・建玉がある銘柄（購読の対象・銘柄数の上限の判定に使う）
  activeInstruments() {
    const set = new Set();
    for (const o of this.s.orders) set.add(o.inst);
    for (const p of this.s.lev) set.add(p.inst);
    for (const [base, h] of Object.entries(this.s.spot)) if (h.qty > TINY) set.add(base);
    return set;
  }

  freeCash() {
    return this.s.cash - this.s.reserved.cash;
  }

  holding(base) {
    return this.s.spot[base] || { qty: 0, cost: 0, fees: 0, openedAt: null };
  }

  freeQty(base) {
    return this.holding(base).qty - (this.s.reserved.spot[base] || 0);
  }

  levUnrealized() {
    let sum = 0;
    let known = true;
    for (const p of this.s.lev) {
      const bid = this.market.bestBid(p.inst);
      const ask = this.market.bestAsk(p.inst);
      if (bid === null || ask === null) known = false;
      else sum += unrealized(p, bid, ask);
    }
    return { sum, known };
  }

  // 維持率（04 R-6）: (現金 + 押さえた証拠金 + レバの評価損益) / 必要証拠金。現物は数えない
  marginRatio() {
    const u = this.levUnrealized();
    return { ratio: marginRatio(this.s.cash, this.s.locked, u.sum, this.s.locked), known: u.known };
  }

  equity() {
    let spot = 0;
    for (const [base, h] of Object.entries(this.s.spot)) {
      const bid = this.market.bestBid(base);
      spot += h.qty * (bid ?? (h.qty > 0 ? h.cost / h.qty : 0));
    }
    return this.s.cash + this.s.locked + spot + this.levUnrealized().sum;
  }

  // ---------------------------------------------------------------- 受付
  // input: {inst, side, type, size, price?, intent, positionId?, sl?, tp?}
  place(input) {
    const inst = parseInst(input.inst);
    const spec = SPECS[input.inst];
    const reject = (message) => {
      this.emit("reject", message);
      return { ok: false, message };
    };
    if (!spec) return reject("この銘柄は扱えません");
    if (!["BUY", "SELL"].includes(input.side) || !["MARKET", "LIMIT", "STOP"].includes(input.type)) {
      return reject("注文の形が正しくありません");
    }
    const local = this.clock();
    if (!this.market.isFresh(input.inst, local)) return reject("値が届いていないため注文できません（再接続中）");
    let size = floorStep(Number(input.size), spec.step);
    if (!(size >= spec.min - TINY)) return reject(`数量が少なすぎます（最小 ${spec.min} ${inst.base}）`);
    if (size > spec.max) return reject(`数量が多すぎます（最大 ${spec.max} ${inst.base}）`);
    let price = null;
    if (input.type !== "MARKET") {
      const p = Number(input.price);
      if (!(p > 0)) return reject("値段を入れてください");
      const dir = input.type === "LIMIT" ? (input.side === "BUY" ? "down" : "up") : (input.side === "BUY" ? "up" : "down");
      price = roundTick(p, spec.tick, dir);
    }
    const intent = inst.market === "spot" ? (input.side === "BUY" ? "open" : "close") : (input.intent || "open");
    const active = this.activeInstruments();
    if (intent === "open" && !active.has(input.inst) && active.size >= MAX_INSTRUMENTS - 1) {
      return reject(`同時に扱えるのは${MAX_INSTRUMENTS}銘柄までです`);
    }
    const bestAsk = this.market.bestAsk(input.inst);
    const bestBid = this.market.bestBid(input.inst);
    const est = input.type === "MARKET" ? (input.side === "BUY" ? bestAsk : bestBid) : price;
    const order = {
      id: this.nextId("o"), inst: input.inst, market: inst.market, base: inst.base, side: input.side,
      type: input.type, intent, size, remaining: size, price, positionId: input.positionId || null,
      role: input.role || null, sl: input.sl || null, tp: input.tp || null,
      status: "pending", triggered: false, createdAt: local, executeAt: local + this.latency(),
      reservedCash: 0, reservedQty: 0, reason: "",
    };
    if (inst.market === "spot") {
      if (intent === "open") {
        const book = sweep(this.market.get(input.inst).asks, size);
        const unit = input.type === "MARKET" ? (book.avgPrice ?? est) : price;
        const need = size * unit + feeYen(size * unit, spec.taker);
        if (need > this.freeCash() + TINY) {
          return reject(`現金が足りません（必要 ${fmtYen(need)}・使える現金 ${fmtYen(this.freeCash())}）`);
        }
        order.reservedCash = need;
        this.s.reserved.cash += need;
      } else {
        if (size > this.freeQty(inst.base) + TINY) {
          return reject(`売れるのは保有している ${floorStep(Math.max(this.freeQty(inst.base), 0), spec.step)} ${inst.base} までです`);
        }
        order.reservedQty = size;
        this.s.reserved.spot[inst.base] = (this.s.reserved.spot[inst.base] || 0) + size;
      }
    } else if (intent === "open") {
      const unit = input.type === "MARKET" ? (sweep(input.side === "BUY" ? this.market.get(input.inst).asks
        : this.market.get(input.inst).bids, size).avgPrice ?? est) : price;
      const need = (size * unit) / LEVERAGE + feeYen(size * unit, spec.taker);
      if (need > this.freeCash() + TINY) {
        return reject(`証拠金が足りません（必要 ${fmtYen(need)}・余力 ${fmtYen(this.freeCash())}）`);
      }
      order.reservedCash = need;
      this.s.reserved.cash += need;
    } else {
      const pos = this.s.lev.find((p) => p.id === input.positionId);
      if (!pos) return reject("決済する建玉が見つかりません");
      const pendingClose = this.s.orders.filter((o) => o.positionId === pos.id && !o.role)
        .reduce((a, o) => a + o.remaining, 0);
      if (size > pos.size - pendingClose + TINY) return reject("決済の数量が建玉より多いです");
      order.side = pos.side === "BUY" ? "SELL" : "BUY";
    }
    this.s.orders.push(order);
    this.emit("accepted", `注文を受け付けました（${this.label(order)}）`, { order });
    return { ok: true, order };
  }

  label(o) {
    const kind = { MARKET: "成行", LIMIT: "指値", STOP: "逆指値" }[o.type];
    const side = o.market === "spot" ? (o.side === "BUY" ? "買い" : "売り")
      : (o.intent === "close" ? "決済" : (o.side === "BUY" ? "新規買い" : "新規売り"));
    return `${o.inst} ${side} ${kind} ${o.size}${o.price ? ` @${o.price}` : ""}`;
  }

  release(o, fraction = 1) {
    if (o.reservedCash > 0) {
      const r = o.reservedCash * fraction;
      this.s.reserved.cash = Math.max(0, this.s.reserved.cash - r);
      o.reservedCash -= r;
    }
    if (o.reservedQty > 0) {
      const q = o.reservedQty * fraction;
      this.s.reserved.spot[o.base] = Math.max(0, (this.s.reserved.spot[o.base] || 0) - q);
      o.reservedQty -= q;
    }
  }

  finish(o, status, reason = "") {
    this.release(o, 1);
    o.status = status;
    o.reason = reason;
    o.doneAt = this.clock();
    this.s.orders = this.s.orders.filter((x) => x !== o);
    this.s.history.unshift({ id: o.id, label: this.label(o), status, reason, at: o.doneAt });
    if (this.s.history.length > 50) this.s.history.length = 50;
  }

  cancel(id, reason = "取り消しました") {
    const o = this.s.orders.find((x) => x.id === id);
    if (!o) return false;
    this.finish(o, "canceled", reason);
    this.emit("cancel", `${reason}（${this.label(o)}）`);
    return true;
  }

  // ---------------------------------------------------------------- 時間の進行
  step(local = this.clock()) {
    for (const o of [...this.s.orders]) {
      if (o.status !== "pending" || o.executeAt > local) continue;
      if (!this.market.isFresh(o.inst, local)) {
        this.finish(o, "rejected", "値が古い");
        this.emit("reject", `値が古いため取り消しました（${this.label(o)}）`);
        continue;
      }
      if (o.type === "MARKET" || o.triggered) this.executeMarket(o, "成行");
      else if (o.type === "LIMIT") this.executeLimitNow(o);
      else o.status = "working";
    }
    this.checkCarry();
    this.checkLosscut();
  }

  executeMarket(o, reasonLabel, { fillRemainder = o.intent === "close" } = {}) {
    const book = this.market.get(o.inst);
    const levels = o.side === "BUY" ? book.asks : book.bids;
    let size = o.remaining;
    if (o.market === "spot" && o.intent === "open") {
      // 約定の直前に、押さえた現金で買える数量に収める（逆指値の滑りなど）
      const spec = SPECS[o.inst];
      const r = sweep(levels, size);
      if (r.avgPrice !== null) {
        const cap = this.freeCash() + o.reservedCash;
        const need = r.notional + feeYen(r.notional, spec.taker);
        if (need > cap + TINY) size = floorStep((cap / (r.avgPrice * (1 + spec.taker))) * 0.999, spec.step);
      }
      if (size < spec.min - TINY) {
        this.finish(o, "rejected", "現金不足");
        this.emit("reject", `約定の時点の値段では現金が足りませんでした（${this.label(o)}）`);
        return;
      }
    }
    const r = sweep(levels, size, { fillRemainder });
    if (!(r.filled > 0)) {
      this.finish(o, "rejected", "板が空");
      this.emit("reject", `板が空のため約定しませんでした（${this.label(o)}）`);
      return;
    }
    this.applyFill(o, r.filled, r.avgPrice, "taker", reasonLabel);
    if (o.status === "filled" || !this.s.orders.includes(o)) return;
    if (o.remaining > TINY) {
      const before = o.size;
      this.finish(o, "canceled", "板が足りない");
      this.emit("cancel", `板の厚みが足りず、${before} のうち ${floorStep(before - o.remaining, SPECS[o.inst].step)} だけ約定しました`);
    }
  }

  executeLimitNow(o) {
    const book = this.market.get(o.inst);
    const levels = o.side === "BUY" ? book.asks : book.bids;
    const r = sweepLimit(levels, o.remaining, o.price, o.side);
    if (r.filled > 0) this.applyFill(o, r.filled, r.avgPrice, "taker", "指値");
    if (this.s.orders.includes(o) && o.remaining > TINY) o.status = "working";
  }

  // ---------------------------------------------------------------- 配信のたびに
  onTrade(inst, price) {
    const local = this.clock();
    for (const o of [...this.s.orders]) {
      if (o.inst !== inst || o.status !== "working") continue;
      if (o.type === "STOP" && !o.triggered && stopHit(o.side, o.price, price)) {
        o.triggered = true;
        o.status = "pending";
        o.executeAt = local + this.latency();
        this.emit("info", `逆指値が発動しました（${this.label(o)}）`);
      } else if (o.type === "LIMIT" && limitHit(o.side, o.price, { trade: price })) {
        this.applyFill(o, o.remaining, o.price, "maker", o.role === "tp" ? "利確" : "指値");
      }
    }
  }

  onBook(inst) {
    const bid = this.market.bestBid(inst);
    const ask = this.market.bestAsk(inst);
    for (const o of [...this.s.orders]) {
      if (o.inst !== inst || o.status !== "working" || o.type !== "LIMIT") continue;
      if (limitHit(o.side, o.price, { bestBid: bid, bestAsk: ask })) {
        this.applyFill(o, o.remaining, o.price, "maker", o.role === "tp" ? "利確" : "指値");
      }
    }
    this.checkLosscut();
  }

  // ---------------------------------------------------------------- 約定の反映
  applyFill(o, size, price, liquidity, reasonLabel) {
    const spec = SPECS[o.inst];
    const t = this.market.serverNow(this.clock());
    const notional = size * price;
    const fee = feeYen(notional, liquidity === "maker" ? spec.maker : spec.taker);
    const fraction = o.remaining > 0 ? Math.min(1, size / o.remaining) : 1;
    this.release(o, fraction);
    o.remaining = Math.max(0, o.remaining - size);
    if (o.remaining < spec.step / 2) o.remaining = 0;
    const fill = { id: this.nextId("f"), orderId: o.id, inst: o.inst, market: o.market, intent: o.intent, side: o.side, size, price, fee, liquidity, time: t };
    this.emit("fill", `約定しました（${this.label(o)} → ${size} @${round(price)}・手数料 ${fee}円）`, { fill });
    if (o.market === "spot") {
      if (o.side === "BUY") this.spotBuy(o.base, size, notional, fee, t);
      else this.spotSell(o, size, price, fee, t, liquidity, reasonLabel);
    } else if (o.intent === "open") {
      this.levOpen(o, size, price, notional, fee, t, liquidity);
    } else {
      const reason = o.role === "sl" ? "損切り" : o.role === "tp" ? "利確" : reasonLabel === "強制決済" ? "強制決済" : "手動";
      this.levClose(o.positionId, size, price, fee, t, liquidity, reason, o);
    }
    if (o.remaining === 0 && this.s.orders.includes(o)) this.finish(o, "filled");
    if (o.role && o.remaining === 0) {
      for (const x of [...this.s.orders]) if (x.positionId === o.positionId && x.role && x !== o) this.finish(x, "canceled", "OCO");
    }
  }

  spotBuy(base, size, notional, fee, t) {
    const h = this.s.spot[base] || (this.s.spot[base] = { qty: 0, cost: 0, fees: 0, openedAt: null });
    if (h.qty <= TINY) {
      h.openedAt = t;
      h.fees = 0;
      h.cost = 0;
      h.qty = 0;
    }
    this.s.cash -= notional + fee;
    h.qty += size;
    h.cost += notional + fee;
    h.fees += fee;
  }

  spotSell(o, size, price, fee, t, liquidity, reasonLabel) {
    const h = this.holding(o.base);
    const avg = h.qty > 0 ? h.cost / h.qty : price;
    const share = h.qty > 0 ? size / h.qty : 1;
    const buyFees = (h.fees || 0) * share;
    const pnl = pnlSpotClose(size, price, fee, avg);
    this.s.cash += size * price - fee;
    h.cost -= avg * size;
    h.fees -= buyFees;
    h.qty -= size;
    if (h.qty < SPECS[o.inst].step / 2) {
      h.qty = 0;
      h.cost = 0;
      h.fees = 0;
    }
    this.record({
      inst: o.inst, market: "spot", side: "BUY", size, entryPrice: (avg * size - buyFees) / size, exitPrice: price,
      entryTime: h.openedAt, exitTime: t, fees: fee + buyFees, carry: 0, pnl,
      exitReason: o.type === "STOP" ? "逆指値" : o.type === "LIMIT" ? "指値" : reasonLabel === "成行" ? "手動" : reasonLabel,
      liquidity: { entry: "taker", exit: liquidity },
    });
  }

  levOpen(o, size, price, notional, fee, t, liquidity) {
    const margin = notional / LEVERAGE;
    this.s.cash -= margin + fee;
    this.s.locked += margin;
    const pos = {
      id: this.nextId("p"), inst: o.inst, side: o.side, size, entryPrice: price, entryNotional: notional,
      entryFee: fee, carry: 0, openedAt: t, liquidity,
    };
    this.s.lev.push(pos);
    if (o.sl) this.attach(pos, "sl", o.sl);
    if (o.tp) this.attach(pos, "tp", o.tp);
  }

  // 建玉に損切り（逆指値）・利確（指値）を付ける。同じ役割の古いものは取り消す
  attach(pos, role, price) {
    for (const x of [...this.s.orders]) if (x.positionId === pos.id && x.role === role) this.finish(x, "canceled", "付け替え");
    if (!(price > 0)) return;
    const spec = SPECS[pos.inst];
    const side = pos.side === "BUY" ? "SELL" : "BUY";
    const type = role === "sl" ? "STOP" : "LIMIT";
    const dir = type === "LIMIT" ? (side === "BUY" ? "down" : "up") : (side === "BUY" ? "up" : "down");
    const p = parseInst(pos.inst);
    this.s.orders.push({
      id: this.nextId("o"), inst: pos.inst, market: "lev", base: p.base, side, type, intent: "close",
      size: pos.size, remaining: pos.size, price: roundTick(price, spec.tick, dir), positionId: pos.id, role,
      status: "working", triggered: false, createdAt: this.clock(), executeAt: 0, reservedCash: 0, reservedQty: 0, reason: "",
    });
  }

  // current: いま約定している注文（建玉が無くなっても、これ自体は「約定」で終える）
  levClose(positionId, size, price, fee, t, liquidity, reason, current = null) {
    const pos = this.s.lev.find((p) => p.id === positionId);
    if (!pos) return;
    size = Math.min(size, pos.size);
    const share = size / pos.size;
    const pnl = pnlLevClose(pos, size, price, fee);
    const gross = (pos.side === "BUY" ? 1 : -1) * (price - pos.entryPrice) * size;
    const margin = (pos.entryPrice * size) / LEVERAGE;
    this.s.cash += margin + gross - fee;
    this.s.locked = Math.max(0, this.s.locked - margin);
    this.record({
      inst: pos.inst, market: "lev", side: pos.side, size, entryPrice: pos.entryPrice, exitPrice: price,
      entryTime: pos.openedAt, exitTime: t, fees: fee + pos.entryFee * share, carry: pos.carry * share, pnl,
      exitReason: reason, liquidity: { entry: pos.liquidity, exit: liquidity },
    });
    pos.entryFee -= pos.entryFee * share;
    pos.carry -= pos.carry * share;
    pos.entryNotional -= pos.entryNotional * share;
    pos.size -= size;
    const spec = SPECS[pos.inst];
    if (pos.size < spec.step / 2) {
      this.s.lev = this.s.lev.filter((p) => p !== pos);
      for (const x of [...this.s.orders]) if (x.positionId === pos.id && x !== current) this.finish(x, "canceled", "建玉が無くなった");
    } else {
      // 一部決済: 損切り・利確の数量を残りに合わせる（04 R-7）
      for (const x of this.s.orders) if (x.positionId === pos.id && x.role) { x.size = pos.size; x.remaining = pos.size; }
    }
  }

  record(tr) {
    const trade = { id: this.nextId("t"), memo: "", ...tr };
    this.emit("trade", `決済しました（損益 ${fmtYen(trade.pnl)}）`, { trade });
  }

  // ---------------------------------------------------------------- 建玉管理料・強制決済・空白
  checkCarry() {
    const now = this.market.serverNow(this.clock());
    const n = carryCount(this.s.lastCarryAt, now);
    if (n > 0) {
      for (const p of this.s.lev) {
        const c = carryYen(p.entryNotional) * n;
        this.s.cash -= c;
        p.carry += c;
      }
      if (this.s.lev.length) this.emit("info", `建玉管理料を引きました（${n}回ぶん）`);
    }
    if (now > this.s.lastCarryAt) this.s.lastCarryAt = now;
  }

  checkLosscut() {
    if (!this.s.lev.length) return;
    const { ratio, known } = this.marginRatio();
    if (!known || ratio >= LOSSCUT_RATIO) return;
    for (const x of [...this.s.orders]) if (x.market === "lev") this.finish(x, "canceled", "強制決済");
    for (const p of [...this.s.lev]) {
      const o = {
        id: this.nextId("o"), inst: p.inst, market: "lev", base: parseInst(p.inst).base, side: p.side === "BUY" ? "SELL" : "BUY",
        type: "MARKET", intent: "close", size: p.size, remaining: p.size, price: null, positionId: p.id, role: null,
        status: "pending", reservedCash: 0, reservedQty: 0,
      };
      this.s.orders.push(o);
      this.executeMarket(o, "強制決済", { fillRemainder: true });
    }
    this.emit("liquidation", "証拠金維持率が75%を下回ったため、レバレッジの建玉をすべて決済しました");
  }

  // 空白（閉じていた・切れていた）の後: 待機中の注文を取り消し、建玉管理料を追いつかせる
  onGap() {
    const n = this.s.orders.length;
    for (const x of [...this.s.orders]) this.finish(x, "canceled", "空白");
    if (n) this.emit("cancel", `アプリが閉じていた間の値動きが分からないため、待機中の注文 ${n}件を取り消しました`);
    this.checkCarry();
    return n;
  }
}

function round(x) {
  return Math.abs(x) >= 100 ? Math.round(x) : Number(x.toPrecision(6));
}
