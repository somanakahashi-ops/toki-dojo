// 建玉・保有・待機中の注文・最近の注文（外部設計 1.1）。
import { SPECS } from "../config.js";
import { unrealized } from "../engine.js";
import { clear, el, hm, px, qty, signClass, yen } from "./dom.js";

export class PositionsView {
  constructor(app) {
    this.app = app;
    this.body = el("div");
    this.root = el("section", { class: "card", attrs: { "aria-label": "建玉と注文" } }, [el("h2", { text: "建玉・注文" }), this.body]);
    this.editing = null; // 入力中の損切り・利確が描き直しで消えないように
  }

  table(head, rows) {
    return el("div", { class: "table-wrap" }, [el("table", {}, [
      el("thead", {}, [el("tr", {}, head.map(([t, r]) => el("th", { class: r ? "r" : "", text: t })))]),
      el("tbody", {}, rows),
    ])]);
  }

  update() {
    if (this.editing && this.root.contains(document.activeElement)) return;
    const { app } = this;
    const acc = app.account;
    clear(this.body);
    const spotRows = Object.entries(acc.s.spot).filter(([, h]) => h.qty > 0).map(([base, h]) => {
      const bid = app.market.bestBid(base);
      const pnl = bid !== null ? h.qty * bid - h.cost : null;
      return el("tr", {}, [
        el("td", { text: `${base} 現物` }), el("td", { class: "r num", text: qty(base, h.qty) }),
        el("td", { class: "r num", text: px(base, h.cost / h.qty) }),
        el("td", { class: `r num ${signClass(pnl)}`, text: yen(pnl, { sign: true }) }),
        el("td", {}, [el("button", { class: "btn small", text: "全部売る", attrs: { type: "button" },
          on: { click: () => { acc.place({ inst: base, side: "SELL", type: "MARKET", size: acc.freeQty(base) }); app.render(); } } })]),
      ]);
    });
    this.body.append(el("h2", { text: "現物の保有" }));
    this.body.append(spotRows.length ? this.table([["銘柄"], ["数量", 1], ["平均取得", 1], ["評価損益", 1], [""]], spotRows)
      : el("div", { class: "empty", text: "保有はありません" }));

    const levRows = acc.s.lev.map((p) => {
      const bid = app.market.bestBid(p.inst);
      const ask = app.market.bestAsk(p.inst);
      const u = bid !== null && ask !== null ? unrealized(p, bid, ask) : null;
      const sl = acc.s.orders.find((o) => o.positionId === p.id && o.role === "sl");
      const tp = acc.s.orders.find((o) => o.positionId === p.id && o.role === "tp");
      const slIn = el("input", { class: "input num", attrs: { inputmode: "decimal", placeholder: "損切り", value: sl ? sl.price : "", "aria-label": "損切り" },
        on: { focus: () => { this.editing = p.id; } } });
      const tpIn = el("input", { class: "input num", attrs: { inputmode: "decimal", placeholder: "利確", value: tp ? tp.price : "", "aria-label": "利確" },
        on: { focus: () => { this.editing = p.id; } } });
      return el("tr", {}, [
        el("td", { class: p.side === "BUY" ? "buy" : "sell", text: `${p.inst} ${p.side === "BUY" ? "買い" : "売り"}` }),
        el("td", { class: "r num", text: qty(p.inst, p.size) }), el("td", { class: "r num", text: px(p.inst, p.entryPrice) }),
        el("td", { class: `r num ${signClass(u)}`, text: yen(u, { sign: true }) }),
        el("td", {}, [slIn]), el("td", {}, [tpIn]),
        el("td", {}, [el("div", { class: "actions" }, [
          el("button", { class: "btn small", text: "反映", attrs: { type: "button" }, on: { click: () => {
            acc.attach(p, "sl", Number(slIn.value));
            acc.attach(p, "tp", Number(tpIn.value));
            this.editing = null;
            app.toast("info", "損切り・利確を反映しました");
            app.render();
          } } }),
          el("button", { class: "btn small", text: "決済", attrs: { type: "button" }, on: { click: () => {
            acc.place({ inst: p.inst, side: p.side === "BUY" ? "SELL" : "BUY", type: "MARKET", size: p.size, intent: "close", positionId: p.id });
            app.render();
          } } }),
        ])]),
      ]);
    });
    this.body.append(el("h2", { text: "レバレッジの建玉" }));
    this.body.append(levRows.length ? this.table([["建玉"], ["数量", 1], ["建値", 1], ["評価損益", 1], ["損切り"], ["利確"], [""]], levRows)
      : el("div", { class: "empty", text: "建玉はありません" }));

    const orders = acc.s.orders.map((o) => el("tr", {}, [
      el("td", { text: acc.label(o) }),
      el("td", { class: "muted", text: o.role === "sl" ? "損切り" : o.role === "tp" ? "利確" : o.status === "pending" ? "送信中" : "待機中" }),
      el("td", {}, [el("button", { class: "btn small", text: "取消", attrs: { type: "button" }, on: { click: () => { acc.cancel(o.id); app.render(); } } })]),
    ]));
    this.body.append(el("h2", { text: "待機中の注文" }));
    this.body.append(orders.length ? this.table([["注文"], ["状態"], [""]], orders) : el("div", { class: "empty", text: "待機中の注文はありません" }));

    const hist = acc.s.history.slice(0, 8).map((h) => el("tr", {}, [
      el("td", { class: "num muted", text: hm(h.at + app.market.serverOffset) }), el("td", { text: h.label }),
      el("td", { class: "muted", text: { filled: "約定", canceled: "取消", rejected: "拒否" }[h.status] + (h.reason && h.status !== "filled" ? `（${h.reason}）` : "") }),
    ]));
    if (hist.length) {
      this.body.append(el("h2", { text: "最近の注文" }));
      this.body.append(this.table([["時刻"], ["注文"], ["結果"]], hist));
    }
    this.editing = null;
    void SPECS;
  }
}
