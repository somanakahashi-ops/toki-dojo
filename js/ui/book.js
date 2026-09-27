// 板と約定の流れ（外部設計 1.1）。板の値段を押すと注文の値段に入る。
// ★量の横棒の幅は CSSOM（el.style.width）で入れる（属性ではないので CSP の対象外。04 R-10）
import { clear, el, hm, px, qty } from "./dom.js";

export class BookView {
  constructor(app) {
    this.app = app;
    this.tab = "book";
    this.bookBtn = el("button", { text: "板", attrs: { type: "button" }, on: { click: () => { this.tab = "book"; this.update(); } } });
    this.tapeBtn = el("button", { text: "約定", attrs: { type: "button" }, on: { click: () => { this.tab = "tape"; this.update(); } } });
    this.book = el("div", { class: "book", attrs: { "aria-label": "板" } });
    this.tape = el("div", { class: "tape", attrs: { "aria-label": "約定の流れ" } });
    this.bookCard = el("div", {}, [this.book]);
    this.tapeCard = el("div", {}, [this.tape]);
    this.root = el("section", { class: "card" }, [
      el("div", { class: "card-head" }, [el("h2", { text: "板・約定" }), el("div", { class: "seg" }, [this.bookBtn, this.tapeBtn])]),
      el("div", { class: "both" }, [this.bookCard, this.tapeCard]),
    ]);
    this.wide = globalThis.matchMedia ? globalThis.matchMedia("(min-width: 900px)") : { matches: false };
  }

  row(inst, side, lv, max) {
    const bar = el("span", { class: "bar" });
    bar.style.width = `${max > 0 ? Math.min(100, (lv.size / max) * 100) : 0}%`;
    return el("button", {
      class: `book-row ${side}`, attrs: { type: "button", title: "この値段を注文に入れる" },
      on: { click: () => this.app.ticket.setPrice(lv.price) },
    }, [bar, el("span", { class: "px num", text: px(inst, lv.price) }), el("span", { class: "size num", text: qty(inst, lv.size) })]);
  }

  update() {
    const inst = this.app.inst();
    const s = this.app.market.get(inst);
    const n = this.app.settings.levels || 10;
    const asks = s.asks.slice(0, n);
    const bids = s.bids.slice(0, n);
    const max = Math.max(1e-12, ...asks.map((l) => l.size), ...bids.map((l) => l.size));
    clear(this.book);
    if (!asks.length && !bids.length) this.book.append(el("div", { class: "empty", text: "板を待っています" }));
    for (const lv of [...asks].reverse()) this.book.append(this.row(inst, "ask", lv, max));
    if (asks.length && bids.length) {
      const sp = asks[0].price - bids[0].price;
      this.book.append(el("div", { class: "book-mid num", text: `スプレッド ${px(inst, sp)}` }));
    }
    for (const lv of bids) this.book.append(this.row(inst, "bid", lv, max));
    clear(this.tape);
    const rows = s.tape.slice(0, 30);
    if (!rows.length) this.tape.append(el("div", { class: "empty", text: "約定を待っています" }));
    for (const t of rows) {
      this.tape.append(el("div", { class: "tape-row" }, [
        el("span", { class: "num muted", text: hm(t.t) }),
        el("span", { class: `num ${t.side === "BUY" ? "buy" : "sell"}`, text: px(inst, t.price) }),
        el("span", { class: "size num", text: qty(inst, t.size) }),
      ]));
    }
    const wide = this.wide.matches;
    this.bookCard.hidden = !wide && this.tab !== "book";
    this.tapeCard.hidden = !wide && this.tab !== "tape";
    this.bookBtn.classList.toggle("on", this.tab === "book");
    this.tapeBtn.classList.toggle("on", this.tab === "tape");
  }
}
