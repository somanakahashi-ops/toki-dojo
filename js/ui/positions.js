// 建玉・保有・待機中の注文・最近の注文（外部設計 1.1・04 R-37）。
// ★建玉ごとの**カード**。カードは建玉が増減したときだけ作り、数字は**その場で書き換える**
// （丸ごと作り直すと、横の位置・入力中の値・指で押したボタンが描画のたびに消える）。
import { unrealized } from "../engine.js";
import { clear, el, hm, px, qty, signClass, yen } from "./dom.js";

const ARM_MS = 3000; // 決済・全部売るは2回押しで確定（押し間違いを防ぐ）

function cell(label) {
  const b = el("b", { class: "num", text: "—" });
  return { root: el("div", {}, [el("span", { text: label }), b]), b };
}

// 2回押しのボタン: 1回目で「もう一度押して◯◯」、3秒以内の2回目で実行
function armedButton(text, cls, run) {
  const btn = el("button", { class: `btn block ${cls}`, text, attrs: { type: "button" } });
  let timer = null;
  btn.addEventListener("click", () => {
    if (!timer) {
      btn.textContent = `もう一度押して${text}`;
      timer = setTimeout(() => { timer = null; btn.textContent = text; }, ARM_MS);
      return;
    }
    clearTimeout(timer);
    timer = null;
    btn.textContent = text;
    run();
  });
  return btn;
}

export class PositionsView {
  constructor(app) {
    this.app = app;
    this.spotList = el("div", { class: "pos-list" });
    this.levList = el("div", { class: "pos-list" });
    this.spotEmpty = el("div", { class: "empty", text: "保有はありません" });
    this.levEmpty = el("div", { class: "empty", text: "建玉はありません" });
    this.orders = el("div");
    this.hist = el("div");
    this.histHead = el("h2", { text: "最近の注文" });
    this.root = el("section", { class: "card", attrs: { "aria-label": "建玉と注文" } }, [
      el("h2", { text: "建玉・注文" }),
      el("h2", { text: "現物の保有" }), this.spotEmpty, this.spotList,
      el("h2", { text: "レバレッジの建玉" }), this.levEmpty, this.levList,
      el("h2", { text: "待機中の注文" }), this.orders,
      this.histHead, this.hist,
    ]);
    this.spotCards = new Map(); // base -> card
    this.levCards = new Map();  // position id -> card
    this.ordersSig = null;
    this.histSig = null;
  }

  table(head, rows) {
    return el("div", { class: "table-wrap" }, [el("table", {}, [
      el("thead", {}, [el("tr", {}, head.map(([t, r]) => el("th", { class: r ? "r" : "", text: t })))]),
      el("tbody", {}, rows),
    ])]);
  }

  // 並びの鍵に合わせてカードを足す・消す（残るカードは作り直さない）
  syncCards(map, list, keys, make) {
    const want = new Set(keys);
    for (const [k, c] of map) {
      if (!want.has(k)) { c.root.remove(); map.delete(k); }
    }
    for (const k of keys) {
      if (!map.has(k)) {
        const c = make(k);
        map.set(k, c);
        list.append(c.root);
      }
    }
  }

  // ---------------------------------------------------------------- 現物
  spotCard(base) {
    const { app } = this;
    const title = el("span", { class: "title" });
    const pnl = el("b", { class: "pnl num" });
    const avg = cell("平均取得");
    const cur = cell("現在値（売り）");
    const val = cell("評価額");
    const sell = armedButton("全部売る", "sell", () => {
      app.account.place({ inst: base, side: "SELL", type: "MARKET", size: app.account.freeQty(base) });
      app.render();
    });
    const root = el("div", { class: "pos-card" }, [
      el("div", { class: "pos-head" }, [title, pnl]),
      el("div", { class: "pos-grid" }, [avg.root, cur.root, val.root]),
      sell,
    ]);
    return { root, title, pnl, avg, cur, val };
  }

  updateSpot() {
    const { app } = this;
    const held = Object.entries(app.account.s.spot).filter(([, h]) => h.qty > 0);
    this.syncCards(this.spotCards, this.spotList, held.map(([b]) => b), (b) => this.spotCard(b));
    for (const [base, h] of held) {
      const c = this.spotCards.get(base);
      const bid = app.market.bestBid(base);
      const p = bid !== null ? h.qty * bid - h.cost : null;
      c.title.textContent = `${base} 現物 ${qty(base, h.qty)}`;
      c.pnl.textContent = yen(p, { sign: true });
      c.pnl.className = `pnl num ${signClass(p)}`;
      c.avg.b.textContent = px(base, h.cost / h.qty);
      c.cur.b.textContent = px(base, bid);
      c.val.b.textContent = yen(bid !== null ? h.qty * bid : null);
    }
    this.spotEmpty.hidden = held.length > 0;
  }

  // ---------------------------------------------------------------- レバ
  levCard(id) {
    const { app } = this;
    const pos = () => app.account.s.lev.find((p) => p.id === id);
    const title = el("span", { class: "title" });
    const pnl = el("b", { class: "pnl num" });
    const entry = cell("建値");
    const cur = cell("現在値（決済）");
    const set = cell("損切り／利確");
    const input = (label) => {
      const i = el("input", { class: "input num", attrs: { inputmode: "decimal", autocomplete: "off", placeholder: "なし", "aria-label": label } });
      i.addEventListener("input", () => { i.dataset.touched = "1"; });
      return { i, root: el("label", {}, [el("span", { text: label }), i]) };
    };
    const sl = input("損切り（逆指値）");
    const tp = input("利確（指値）");
    const apply = el("button", { class: "btn", text: "反映", attrs: { type: "button" }, on: { click: () => {
      const p = pos();
      if (!p) return;
      app.account.attach(p, "sl", Number(sl.i.value));
      app.account.attach(p, "tp", Number(tp.i.value));
      delete sl.i.dataset.touched;
      delete tp.i.dataset.touched;
      app.toast("info", "損切り・利確を反映しました（空にすると外れます）");
      app.render();
    } } });
    const close = armedButton("決済", "", () => {
      const p = pos();
      if (!p) return;
      app.account.place({ inst: p.inst, side: p.side === "BUY" ? "SELL" : "BUY", type: "MARKET", size: p.size, intent: "close", positionId: p.id });
      app.render();
    });
    const root = el("div", { class: "pos-card" }, [
      el("div", { class: "pos-head" }, [title, pnl]),
      el("div", { class: "pos-grid" }, [entry.root, cur.root, set.root]),
      el("div", { class: "pos-inputs" }, [sl.root, tp.root, apply]),
      close,
    ]);
    return { root, title, pnl, entry, cur, set, sl: sl.i, tp: tp.i };
  }

  updateLev() {
    const { app } = this;
    const acc = app.account;
    this.syncCards(this.levCards, this.levList, acc.s.lev.map((p) => p.id), (id) => this.levCard(id));
    for (const p of acc.s.lev) {
      const c = this.levCards.get(p.id);
      const bid = app.market.bestBid(p.inst);
      const ask = app.market.bestAsk(p.inst);
      const u = bid !== null && ask !== null ? unrealized(p, bid, ask) : null;
      const sl = acc.s.orders.find((o) => o.positionId === p.id && o.role === "sl");
      const tp = acc.s.orders.find((o) => o.positionId === p.id && o.role === "tp");
      c.title.textContent = `${p.inst} ${p.side === "BUY" ? "買い" : "売り"} ${qty(p.inst, p.size)}`;
      c.title.className = `title ${p.side === "BUY" ? "buy" : "sell"}`;
      c.pnl.textContent = yen(u, { sign: true });
      c.pnl.className = `pnl num ${signClass(u)}`;
      c.entry.b.textContent = px(p.inst, p.entryPrice);
      c.cur.b.textContent = px(p.inst, p.side === "BUY" ? bid : ask);
      c.set.b.textContent = `${sl ? px(p.inst, sl.price) : "なし"} ／ ${tp ? px(p.inst, tp.price) : "なし"}`;
      // 入力欄は、触る前だけ今の値で埋める（入力中・入力済みの値を描画で消さない）
      for (const [inp, o] of [[c.sl, sl], [c.tp, tp]]) {
        if (!inp.dataset.touched && document.activeElement !== inp) inp.value = o ? String(o.price) : "";
      }
    }
    this.levEmpty.hidden = acc.s.lev.length > 0;
  }

  // ---------------------------------------------------------------- 注文（中身が変わったときだけ作り直す）
  updateOrders() {
    const { app } = this;
    const acc = app.account;
    const sig = acc.s.orders.map((o) => `${o.id}:${o.status}:${o.price}:${o.remaining}`).join(",");
    if (sig !== this.ordersSig) {
      this.ordersSig = sig;
      clear(this.orders);
      const rows = acc.s.orders.map((o) => el("tr", {}, [
        el("td", { text: acc.label(o) }),
        el("td", { class: "muted", text: o.role === "sl" ? "損切り" : o.role === "tp" ? "利確" : o.status === "pending" ? "送信中" : "待機中" }),
        el("td", {}, [el("button", { class: "btn", text: "取消", attrs: { type: "button" }, on: { click: () => { acc.cancel(o.id); app.render(); } } })]),
      ]));
      this.orders.append(rows.length ? this.table([["注文"], ["状態"], [""]], rows) : el("div", { class: "empty", text: "待機中の注文はありません" }));
    }
    const hs = acc.s.history;
    const hsig = `${hs.length}:${hs.length ? hs[0].id + hs[0].status : ""}`;
    if (hsig !== this.histSig) {
      this.histSig = hsig;
      clear(this.hist);
      const rows = hs.slice(0, 8).map((h) => el("tr", {}, [
        el("td", { class: "num muted", text: hm(h.at + app.market.serverOffset) }), el("td", { text: h.label }),
        el("td", { class: "muted", text: { filled: "約定", canceled: "取消", rejected: "拒否" }[h.status] + (h.reason && h.status !== "filled" ? `（${h.reason}）` : "") }),
      ]));
      if (rows.length) this.hist.append(this.table([["時刻"], ["注文"], ["結果"]], rows));
      this.histHead.hidden = !rows.length;
    }
  }

  update() {
    this.updateSpot();
    this.updateLev();
    this.updateOrders();
  }
}
