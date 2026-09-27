// 設定の画面（外部設計 1.3）: 仮想資金とリセット（ページ内の確認）・通信の遅れ・表示・このアプリについて。
import { CAPITAL_CHOICES, LATENCY_CHOICES, SPECS_FETCHED_AT } from "../config.js";
import { rejected } from "../validate.js";
import { clear, el, yen } from "./dom.js";

export class SettingsView {
  constructor(app) {
    this.app = app;
    this.body = el("div", { class: "settings" });
    this.root = el("div", {}, [this.body]);
    this.confirming = false;
    this.capital = app.settings.capital;
    this.keepTrades = true;
  }

  select(id, label, choices, value, fmt, onChange) {
    const s = el("select", { class: "select", attrs: { id } }, choices.map((c) => el("option", { text: fmt(c), attrs: { value: String(c) } })));
    s.value = String(value);
    s.addEventListener("change", () => onChange(Number(s.value)));
    return el("div", { class: "field" }, [el("label", { text: label, attrs: { for: id } }), s]);
  }

  check(id, label, value, onChange) {
    const c = el("input", { attrs: { id, type: "checkbox" } });
    c.checked = !!value;
    c.addEventListener("change", () => onChange(c.checked));
    return el("label", { attrs: { for: id } }, [c, ` ${label}`]);
  }

  update() {
    const { app } = this;
    const s = app.settings;
    clear(this.body);

    const capital = el("section", { class: "card", attrs: { "aria-label": "仮想資金" } }, [
      el("h2", { text: "仮想資金" }),
      el("p", { class: "muted", text: `いまの口座は ${yen(app.account.s.initialCash)} から始めたものです。選び直すと口座を作り直します（保有・建玉・待機中の注文は消えます）。` }),
      this.select("capital", "始める金額", CAPITAL_CHOICES, this.capital, (c) => yen(c), (v) => { this.capital = v; this.confirming = false; this.update(); }),
    ]);
    if (!this.confirming) {
      capital.append(el("button", { class: "btn", text: "この金額でリセットする", attrs: { type: "button" }, on: { click: () => { this.confirming = true; this.update(); } } }));
    } else {
      capital.append(el("div", { class: "confirm" }, [
        el("span", { text: `${yen(this.capital)} で口座を作り直します。よろしいですか？` }),
        this.check("keep", "取引の記録（振り返り）は残す", this.keepTrades, (v) => { this.keepTrades = v; }),
        el("div", { class: "actions" }, [
          el("button", { class: "btn primary", text: "リセットする", attrs: { type: "button" }, on: { click: async () => {
            this.confirming = false;
            await app.reset(this.capital, this.keepTrades);
            this.update();
          } } }),
          el("button", { class: "btn", text: "やめる", attrs: { type: "button" }, on: { click: () => { this.confirming = false; this.update(); } } }),
        ]),
      ]));
    }
    this.body.append(capital);

    this.body.append(el("section", { class: "card", attrs: { "aria-label": "通信と表示" } }, [
      el("h2", { text: "通信と表示" }),
      this.select("latency", "通信の遅れ（注文してから約定の判定までの待ち）", LATENCY_CHOICES, s.latency, (c) => `${c.toLocaleString("ja-JP")}ms${c === 300 ? "（既定）" : ""}`,
        (v) => { s.latency = v; app.saveSettings(); }),
      this.select("levels", "板の段数", [10, 20], s.levels, (c) => `${c}段`, (v) => { s.levels = v; app.saveSettings(); app.render(); }),
      this.check("ma", "チャートに MA 20/75 を出す", s.ma, (v) => { s.ma = v; app.saveSettings(); app.chart.reset(); }),
      this.check("confirm", "注文の前に確認を出す", s.confirm, (v) => { s.confirm = v; app.saveSettings(); }),
    ]));

    this.body.append(el("section", { class: "card about", attrs: { "aria-label": "このアプリについて" } }, [
      el("h2", { text: "このアプリについて" }),
      el("p", { text: "TOKI 道場は、GMOコインの公開配信（リアルタイムの板・約定）を使った仮想の売買の練習場です。実際の注文は一切出しません。APIキーも使いません。" }),
      el("p", { text: "取引・足・設定はこの端末のブラウザの中だけに保存します。どこにも送りません。" }),
      el("p", { text: `約定は GMO の規約に合わせています（最小数量・刻み・手数料と円未満の扱い・板を食う成行・レバレッジ2倍・建玉管理料・維持率75%の強制決済）。銘柄の仕様は ${SPECS_FETCHED_AT} 時点の値です。` }),
      el("p", { text: "練習の約定は本物の板を食いません。自分の注文で板が動くことはないので、大きな数量では本物より有利に出ます。" }),
      el("p", { text: `保存: ${app.store.available ? "使える" : "使えない（このページを閉じると記録が消えます）"}・捨てた電文: ${rejected.count}件` }),
      el("p", { class: "muted", text: "チャートは TradingView Lightweight Charts™（Apache-2.0）を同梱して使っています。" }),
    ]));
  }
}
