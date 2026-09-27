// 上の帯（銘柄・現物/レバ・価格・接続・スプレッド）と口座の帯（外部設計 1.1）。
import { BASES, hasLeverage, LOSSCUT_RATIO } from "../config.js";
import { el, pct, px, signClass, yen } from "./dom.js";

export class Header {
  constructor(app) {
    this.app = app;
    const sel = el("select", { class: "select", attrs: { id: "sym", "aria-label": "銘柄" },
      on: { change: (e) => app.setView({ base: e.target.value }) } },
    BASES.map((b) => el("option", { text: b, attrs: { value: b } })));
    this.sel = sel;
    this.spot = el("button", { text: "現物", attrs: { type: "button" }, on: { click: () => app.setView({ market: "spot" }) } });
    this.lev = el("button", { text: "レバ", attrs: { type: "button" }, on: { click: () => app.setView({ market: "lev" }) } });
    this.conn = el("span", { class: "pill", text: "未接続" });
    this.price = el("span", { class: "price num", text: "—" });
    this.spread = el("span", { class: "kv num" });
    this.hl = el("span", { class: "kv num muted" });
    this.root = el("header", { class: "topbar" }, [
      el("div", { class: "topbar-row" }, [el("span", { class: "brand", text: "TOKI 道場" }), this.conn]),
      el("div", { class: "topbar-row" }, [sel, el("div", { class: "seg" }, [this.spot, this.lev]), this.price]),
      el("div", { class: "topbar-row" }, [this.spread, this.hl]),
    ]);
    this.cells = {};
    const cell = (k, label) => {
      const b = el("b", { class: "num", text: "—" });
      this.cells[k] = b;
      return el("div", {}, [el("span", { text: label }), b]);
    };
    this.acct = el("section", { class: "acct", attrs: { "aria-label": "口座" } },
      [cell("equity", "資産"), cell("cash", "使える現金"), cell("pnl", "評価損益"), cell("margin", "維持率")]);
  }

  update() {
    const { app } = this;
    const inst = app.inst();
    this.sel.value = app.view.base;
    this.spot.classList.toggle("on", app.view.market === "spot");
    this.lev.classList.toggle("on", app.view.market === "lev");
    this.lev.disabled = !hasLeverage(app.view.base);
    this.lev.title = this.lev.disabled ? "この銘柄にはレバレッジ取引がありません" : "";
    const st = app.feed.status;
    this.conn.textContent = st;
    this.conn.className = `pill ${st === "つながっている" ? "ok" : st === "切断中" ? "bad" : "warn"}`;
    const s = app.market.get(inst);
    this.price.textContent = px(inst, s.last);
    const bid = app.market.bestBid(inst);
    const ask = app.market.bestAsk(inst);
    if (bid !== null && ask !== null) {
      const sp = ask - bid;
      this.spread.textContent = `買 ${px(inst, bid)} ／ 売 ${px(inst, ask)} ／ スプレッド ${px(inst, sp)}（${pct(sp / ((ask + bid) / 2), 3)}）`;
    } else {
      this.spread.textContent = "板を待っています";
    }
    const tk = s.ticker;
    this.hl.textContent = tk ? `24h 高 ${px(inst, tk.high)} 安 ${px(inst, tk.low)}` : "";
    const acc = app.account;
    const eq = acc.equity();
    this.cells.equity.textContent = yen(eq);
    this.cells.cash.textContent = yen(acc.freeCash());
    let unreal = acc.levUnrealized().sum;
    for (const [base, h] of Object.entries(acc.s.spot)) {
      const b = app.market.bestBid(base);
      if (h.qty > 0 && b !== null) unreal += h.qty * b - h.cost;
    }
    this.cells.pnl.textContent = yen(unreal, { sign: true });
    this.cells.pnl.className = `num ${signClass(unreal)}`;
    const m = acc.marginRatio();
    this.cells.margin.textContent = acc.s.lev.length ? (m.known ? pct(m.ratio, 0) : "判定できない") : "—";
    this.cells.margin.className = `num ${acc.s.lev.length && m.known && m.ratio < LOSSCUT_RATIO * 1.3 ? "down" : ""}`;
  }
}
