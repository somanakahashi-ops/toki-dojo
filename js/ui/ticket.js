// 注文（外部設計 1.1）: 買い/売り・種類・数量（枚か円）・値段・見込み・（レバの新規は損切り・利確）。
import { LEVERAGE, SPECS } from "../config.js";
import { feeYen, floorStep, sweep } from "../engine.js";
import { el, px, qty, yen } from "./dom.js";

export class Ticket {
  constructor(app) {
    this.app = app;
    this.side = "BUY";
    this.type = "MARKET";
    this.unit = "qty";
    this.pending = null;
    const segBtn = (text, on) => el("button", { text, attrs: { type: "button" }, on: { click: on } });
    this.buyBtn = segBtn("買い", () => { this.side = "BUY"; this.update(); });
    this.sellBtn = segBtn("売り", () => { this.side = "SELL"; this.update(); });
    this.buyBtn.classList.add("b");
    this.sellBtn.classList.add("s");
    this.typeBtns = [["MARKET", "成行"], ["LIMIT", "指値"], ["STOP", "逆指値"]].map(([t, label]) =>
      segBtn(label, () => { this.type = t; this.update(); }));
    this.size = el("input", { class: "input num", attrs: { id: "size", inputmode: "decimal", autocomplete: "off", "aria-label": "数量" },
      on: { input: () => this.update() } });
    this.unitBtn = el("button", { class: "btn small", attrs: { type: "button" }, on: { click: () => { this.unit = this.unit === "qty" ? "yen" : "qty"; this.update(); } } });
    this.price = el("input", { class: "input num", attrs: { id: "price", inputmode: "decimal", autocomplete: "off", "aria-label": "値段" },
      on: { input: () => this.update() } });
    this.sl = el("input", { class: "input num", attrs: { id: "sl", inputmode: "decimal", autocomplete: "off", placeholder: "任意" } });
    this.tp = el("input", { class: "input num", attrs: { id: "tp", inputmode: "decimal", autocomplete: "off", placeholder: "任意" } });
    this.priceField = el("div", { class: "field" }, [el("label", { text: "値段", attrs: { for: "price" } }), this.price]);
    this.slTp = el("div", { class: "row2" }, [
      el("div", { class: "field" }, [el("label", { text: "損切り（逆指値）", attrs: { for: "sl" } }), this.sl]),
      el("div", { class: "field" }, [el("label", { text: "利確（指値）", attrs: { for: "tp" } }), this.tp]),
    ]);
    this.est = el("div", { class: "est" });
    this.submit = el("button", { class: "btn", attrs: { type: "button" }, on: { click: () => this.onSubmit() } });
    this.confirmBox = el("div", { class: "confirm", attrs: { hidden: true } });
    this.root = el("section", { class: "card ticket", attrs: { "aria-label": "注文" } }, [
      el("div", { class: "card-head" }, [el("h2", { text: "注文" }), el("div", { class: "seg buy-sell" }, [this.buyBtn, this.sellBtn])]),
      el("div", { class: "seg" }, this.typeBtns),
      el("div", { class: "field" }, [el("label", { text: "数量", attrs: { for: "size" } }), el("div", { class: "input-unit" }, [this.size, this.unitBtn])]),
      this.priceField, this.slTp, this.est, this.submit, this.confirmBox,
    ]);
  }

  setPrice(p) {
    if (this.type === "MARKET") this.type = "LIMIT";
    this.price.value = String(p);
    this.update();
  }

  // 入力から注文を組む（枚数は刻みに切り下げ）
  build() {
    const app = this.app;
    const inst = app.inst();
    const spec = SPECS[inst];
    const raw = Number(this.size.value);
    const price = Number(this.price.value);
    let size = 0;
    if (raw > 0) {
      if (this.unit === "qty") size = floorStep(raw, spec.step);
      else {
        const ref = this.type === "MARKET" ? (this.side === "BUY" ? app.market.bestAsk(inst) : app.market.bestBid(inst)) : price;
        size = ref > 0 ? floorStep(raw / ref, spec.step) : 0;
      }
    }
    const input = { inst, side: this.side, type: this.type, size, intent: "open" };
    if (this.type !== "MARKET") input.price = price;
    if (app.view.market === "lev") {
      const sl = Number(this.sl.value);
      const tp = Number(this.tp.value);
      if (sl > 0) input.sl = sl;
      if (tp > 0) input.tp = tp;
    }
    return input;
  }

  estimate(input) {
    const app = this.app;
    const spec = SPECS[input.inst];
    const lines = [];
    let warn = "";
    if (!(input.size > 0)) return { lines: [`最小 ${spec.min}・刻み ${spec.step}`], warn: "" };
    let unit = input.price;
    if (input.type === "MARKET") {
      const s = app.market.get(input.inst);
      const r = sweep(input.side === "BUY" ? s.asks : s.bids, input.size);
      unit = r.avgPrice;
      if (r.remainder > 0) warn = "板の厚みが足りません（約定するのは一部だけです）";
    }
    if (!(unit > 0)) return { lines: ["値段を入れてください"], warn };
    const notional = unit * input.size;
    const fee = feeYen(notional, input.type === "LIMIT" ? spec.maker : spec.taker);
    lines.push(`${qty(input.inst, input.size)} ${app.view.base} × ${px(input.inst, unit)} ＝ ${yen(notional)}`);
    lines.push(`手数料 ${yen(fee)}${input.type === "LIMIT" ? "（待機して約定したとき。すぐ約定するぶんは Taker）" : ""}`);
    if (app.view.market === "lev") lines.push(`必要な証拠金 ${yen(notional / LEVERAGE)}（${LEVERAGE}倍）`);
    else if (input.side === "BUY") lines.push(`必要な現金 ${yen(notional + Math.max(fee, 0))}`);
    if (input.size < spec.min) warn = `最小 ${spec.min} ${app.view.base} です`;
    return { lines, warn };
  }

  onSubmit() {
    const input = this.build();
    if (this.app.settings.confirm) {
      this.pending = input;
      this.update();
      return;
    }
    this.send(input);
  }

  send(input) {
    const r = this.app.account.place(input);
    this.pending = null;
    if (r.ok) {
      this.sl.value = "";
      this.tp.value = "";
    }
    this.app.render();
  }

  update() {
    const app = this.app;
    const lev = app.view.market === "lev";
    this.buyBtn.textContent = lev ? "新規 買い" : "買い";
    this.sellBtn.textContent = lev ? "新規 売り" : "売り";
    this.buyBtn.classList.toggle("on", this.side === "BUY");
    this.sellBtn.classList.toggle("on", this.side === "SELL");
    for (const [i, t] of ["MARKET", "LIMIT", "STOP"].entries()) this.typeBtns[i].classList.toggle("on", this.type === t);
    this.unitBtn.textContent = this.unit === "qty" ? app.view.base : "円";
    this.priceField.hidden = this.type === "MARKET";
    this.slTp.hidden = !lev;
    const input = this.build();
    const est = this.estimate(input);
    this.est.replaceChildren(...est.lines.map((t) => el("span", { text: t })), ...(est.warn ? [el("span", { class: "warn", text: est.warn })] : []));
    const fresh = app.market.isFresh(input.inst);
    this.submit.disabled = !fresh;
    this.submit.className = `btn ${this.side === "BUY" ? "buy" : "sell"}`;
    this.submit.textContent = fresh ? `${this.side === "BUY" ? (lev ? "新規 買い" : "買う") : (lev ? "新規 売り" : "売る")}（${{ MARKET: "成行", LIMIT: "指値", STOP: "逆指値" }[this.type]}）`
      : "値が届いていないため注文できません";
    this.confirmBox.hidden = !this.pending;
    if (this.pending) {
      const p = this.pending;
      this.confirmBox.replaceChildren(
        el("span", { text: `${p.inst} ${p.side === "BUY" ? "買い" : "売り"} ${qty(p.inst, p.size)}${p.price ? ` @${px(p.inst, p.price)}` : ""}（${{ MARKET: "成行", LIMIT: "指値", STOP: "逆指値" }[p.type]}）で注文します` }),
        el("div", { class: "actions" }, [
          el("button", { class: "btn primary", text: "確定", attrs: { type: "button" }, on: { click: () => this.send(p) } }),
          el("button", { class: "btn", text: "やめる", attrs: { type: "button" }, on: { click: () => { this.pending = null; this.update(); } } }),
        ]),
      );
    }
  }
}
