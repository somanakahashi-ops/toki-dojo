// 振り返りの画面（外部設計 1.2・05 §4）: まとめ・偶然との比較・時間帯別・一覧（メモ）・書き出し。
import { MEMO_MAX } from "../config.js";
import { randomCompare, stats, toCsv } from "../review.js";
import { clear, el, pct, px, qty, signClass, yen } from "./dom.js";

const REASONS = { 手動: "手動", 損切り: "損切り", 利確: "利確", 強制決済: "強制決済", 逆指値: "逆指値", 指値: "指値" };

function holdText(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60}分`;
}

// 端末に保存させる（Blob の URL は一度きりで捨てる）
function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { attrs: { href: url, download: name } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class ReviewView {
  constructor(app) {
    this.app = app;
    this.body = el("div", { class: "settings" });
    this.root = el("div", {}, [this.body]);
    this.key = "";
    this.cmp = null;
    this.cmpKey = "";
  }

  // 取引が増えたとき・メモを書いたときだけ描き直す（入力中の文字を消さないため）
  update(force = false) {
    const trades = this.app.trades;
    const key = `${trades.length}|${trades.length ? trades[trades.length - 1].id : ""}|${this.app.account.s.initialCash}`;
    if (!force && key === this.key) return;
    if (!force && this.root.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA") return;
    this.key = key;
    this.render();
  }

  compare() {
    const trades = this.app.trades;
    const key = `${trades.length}|${trades.length ? trades[trades.length - 1].id : ""}`;
    if (key !== this.cmpKey) {
      this.cmp = randomCompare(trades, this.app.candles.allQuotes());
      this.cmpKey = key;
    }
    return this.cmp;
  }

  render() {
    const { app } = this;
    const trades = app.trades;
    const st = stats(trades, app.account.s.initialCash);
    clear(this.body);

    const stat = (label, value, cls = "") => el("div", { class: "stat" }, [el("span", { text: label }), el("b", { class: `num ${cls}`, text: value })]);
    this.body.append(el("section", { class: "card", attrs: { "aria-label": "まとめ" } }, [
      el("h2", { text: "まとめ（手数料・建玉管理料を引いた後）" }),
      el("div", { class: "stats" }, [
        stat("取引数", `${st.n}件`),
        stat("勝率", st.winRate === null ? "—" : pct(st.winRate, 0)),
        stat("合計損益", yen(st.total, { sign: true }), signClass(st.total)),
        stat("最大DD（確定損益）", st.n ? `${yen(-st.maxDdYen)}（${st.maxDdPct.toFixed(1)}%）` : "—"),
        stat("平均の勝ち", yen(st.avgWin, { sign: true }), "up"),
        stat("平均の負け", yen(st.avgLoss, { sign: true }), "down"),
        stat("手数料の合計", yen(st.fees)),
        stat("建玉管理料の合計", yen(st.carry)),
      ]),
    ]));

    const c = this.compare();
    let verdict;
    let detail;
    if (c.status !== "ok") {
      verdict = "まだ判定できない";
      detail = `比べられる取引が ${c.included}件（${c.minTrades}件から判定します）。`
        + (c.excluded ? `保有していた時間の気配（1分ごと）が揃っていないため比べられない取引が ${c.excluded}件あります（1分未満の取引・閉じていた時間をまたぐ取引など）。` : "");
    } else {
      verdict = `偶然の200通りの中で ${Math.round(c.percentile)}%点`;
      detail = `あなたの合計 ${yen(c.userTotal, { sign: true })}／偶然の中央値 ${yen(c.median, { sign: true })}`
        + `（下5% ${yen(c.p5, { sign: true })}・上5% ${yen(c.p95, { sign: true })}）。比べた取引 ${c.included}件`
        + (c.excluded ? `・気配が揃わず外した取引 ${c.excluded}件` : "")
        + "。同じ銘柄・向き・数量・保有時間で、入る時刻だけ無作為にした場合との比較です。95%点を超えて初めて「偶然では説明しにくい」と言えます。";
    }
    this.body.append(el("section", { class: "card", attrs: { "aria-label": "偶然との比較" } }, [
      el("h2", { text: "偶然との比較" }),
      el("div", { class: "verdict", text: verdict }),
      el("p", { class: "muted", text: detail }),
    ]));

    const maxAbs = Math.max(1, ...st.byHour.map((h) => Math.abs(h.pnl)));
    const hoursBlock = (from) => {
      const bars = el("div", { class: "hours" });
      const labels = el("div", { class: "hours-labels" });
      for (let h = from; h < from + 12; h += 1) {
        const b = st.byHour[h];
        const d = el("div", { class: b.pnl > 0 ? "pos" : b.pnl < 0 ? "neg" : "", attrs: { title: `${h}時台 ${b.n}件 ${yen(b.pnl, { sign: true })}` } });
        d.style.height = `${b.n ? Math.max(4, (Math.abs(b.pnl) / maxAbs) * 100) : 0}%`;
        bars.append(d);
        labels.append(el("span", { text: String(h) }));
      }
      return [bars, labels];
    };
    this.body.append(el("section", { class: "card", attrs: { "aria-label": "時間帯別" } }, [
      el("h2", { text: "時間帯別（日本時間・建てた時刻。緑は利益・赤は損失）" }),
      ...hoursBlock(0), ...hoursBlock(12),
    ]));

    const rows = [...trades].sort((a, b) => b.exitTime - a.exitTime).slice(0, 200).map((t) => {
      const memo = el("textarea", { class: "input memo", attrs: { rows: 1, maxlength: MEMO_MAX, placeholder: "メモ", "aria-label": "メモ" } });
      memo.value = t.memo || "";
      memo.addEventListener("change", () => {
        t.memo = memo.value.slice(0, MEMO_MAX);
        app.store.add("trades", t);
      });
      return el("tr", {}, [
        el("td", { class: t.side === "BUY" ? "buy" : "sell", text: `${t.inst} ${t.market === "lev" ? "レバ" : "現物"} ${t.side === "BUY" ? "買い" : "売り"}` }),
        el("td", { class: "r num", text: qty(t.inst, t.size) }),
        el("td", { class: "r num", text: `${px(t.inst, t.entryPrice)} → ${px(t.inst, t.exitPrice)}` }),
        el("td", { class: "r num", text: holdText(t.exitTime - t.entryTime) }),
        el("td", { class: `r num ${signClass(t.pnl)}`, text: yen(t.pnl, { sign: true }) }),
        el("td", { text: REASONS[t.exitReason] || t.exitReason }),
        el("td", {}, [memo]),
      ]);
    });
    const list = el("section", { class: "card", attrs: { "aria-label": "取引の一覧" } }, [el("h2", { text: `取引の一覧（新しい順・最大200件を表示）` })]);
    if (rows.length) {
      list.append(el("div", { class: "table-wrap" }, [el("table", {}, [
        el("thead", {}, [el("tr", {}, [["銘柄"], ["数量", 1], ["建値→決済値", 1], ["保有", 1], ["損益", 1], ["理由"], ["メモ"]]
          .map(([t, r]) => el("th", { class: r ? "r" : "", text: t })))]),
        el("tbody", {}, rows),
      ])]));
    } else {
      list.append(el("div", { class: "empty", text: "まだ取引がありません。決済すると1件ずつ増えます" }));
    }
    this.body.append(list);

    this.body.append(el("section", { class: "card", attrs: { "aria-label": "書き出し" } }, [
      el("h2", { text: "書き出し（端末に保存）" }),
      el("div", { class: "actions" }, [
        el("button", { class: "btn", text: "CSV", attrs: { type: "button" }, on: { click: () => download("toki-dojo-trades.csv", "text/csv;charset=utf-8", `﻿${toCsv(app.trades)}`) } }),
        el("button", { class: "btn", text: "JSON", attrs: { type: "button" }, on: { click: async () => {
          const fills = await app.store.all("fills");
          const body = { version: 1, exportedAt: new Date().toISOString(), account: app.account.s, trades: app.trades, fills };
          download("toki-dojo.json", "application/json", JSON.stringify(body, null, 1));
        } } }),
      ]),
    ]));
  }
}
