// ローソク足のチャート（外部設計 1.1・05 §7）。lightweight-charts（同梱・SRI）を使う。
import { SPECS } from "../config.js";
import { decimals } from "../engine.js";
import { el, px } from "./dom.js";

const JST = 9 * 3600; // 軸を日本時間で見せるため、秒の時刻に9時間を足して渡す
const FRAMES = [[1, "1分"], [5, "5分"], [15, "15分"], [60, "1時間"]];

function sma(bars, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    sum += bars[i].c;
    if (i >= n) sum -= bars[i - n].c;
    if (i >= n - 1) out.push({ time: bars[i].t / 1000 + JST, value: sum / n });
  }
  return out;
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class ChartView {
  constructor(app) {
    this.app = app;
    this.frame = 1;
    this.box = el("div", { class: "chart-box" });
    this.note = el("div", { class: "chart-note" });
    this.box.append(this.note);
    this.chips = FRAMES.map(([f, label]) => el("button", { class: "chip", text: label, attrs: { type: "button" },
      on: { click: () => { this.frame = f; this.reset(); } } }));
    this.maBtn = el("button", { class: "chip", text: "MA 20/75", attrs: { type: "button" },
      on: { click: () => { app.settings.ma = !app.settings.ma; app.saveSettings(); this.reset(); } } });
    this.root = el("section", { class: "card", attrs: { "aria-label": "チャート" } }, [
      el("div", { class: "card-head" }, [el("h2", { text: "チャート" }), el("div", { class: "chips" }, [...this.chips, this.maBtn])]),
      this.box,
    ]);
    this.chart = null;
    this.key = "";
  }

  ensure() {
    if (this.chart || !globalThis.LightweightCharts) return;
    const LC = globalThis.LightweightCharts;
    this.chart = LC.createChart(this.box, {
      autoSize: true,
      layout: { background: { color: css("--panel") }, textColor: css("--muted"), attributionLogo: true },
      grid: { vertLines: { color: css("--line") }, horzLines: { color: css("--line") } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: css("--line") },
      rightPriceScale: { borderColor: css("--line") },
      crosshair: { mode: 0 },
      // 端末の言語設定に左右されない（変わった言語タグで落ちるのを防ぐ）。値段は板と同じ桁区切り
      localization: { locale: "ja-JP", priceFormatter: (p) => px(this.app.inst(), p) },
    });
    this.candle = this.chart.addCandlestickSeries({
      upColor: css("--buy"), downColor: css("--sell"), borderVisible: false,
      wickUpColor: css("--buy"), wickDownColor: css("--sell"),
    });
    this.ma20 = this.chart.addLineSeries({ color: css("--accent"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    this.ma75 = this.chart.addLineSeries({ color: css("--muted"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  }

  reset() {
    this.key = "";
    this.update();
  }

  update() {
    this.ensure();
    const inst = this.app.inst();
    for (const [i, [f]] of FRAMES.entries()) this.chips[i].classList.toggle("on", f === this.frame);
    this.maBtn.classList.toggle("on", !!this.app.settings.ma);
    if (!this.chart) {
      this.note.textContent = "チャートを読み込んでいます";
      return;
    }
    const bars = this.app.candles.series(inst, this.frame);
    const key = `${inst}|${this.frame}|${this.app.settings.ma}`;
    const data = bars.map((b) => ({ time: b.t / 1000 + JST, open: b.o, high: b.h, low: b.l, close: b.c }));
    if (key !== this.key) {
      const tick = SPECS[inst].tick;
      this.candle.applyOptions({ priceFormat: { type: "price", precision: decimals(tick), minMove: tick } });
      this.candle.setData(data);
      this.ma20.setData(this.app.settings.ma ? sma(bars, 20) : []);
      this.ma75.setData(this.app.settings.ma ? sma(bars, 75) : []);
      this.key = key;
      this.count = data.length;
    } else if (data.length) {
      this.candle.update(data[data.length - 1]);
      if (data.length !== this.count) {
        this.ma20.setData(this.app.settings.ma ? sma(bars, 20) : []);
        this.ma75.setData(this.app.settings.ma ? sma(bars, 75) : []);
        this.count = data.length;
      }
    }
    this.note.textContent = bars.length < 20 ? `開いてからの約定で足を作っています（${bars.length}本）。閉じていた時間は空白になります` : "";
  }
}
