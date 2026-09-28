// チャート（外部設計 1.1・05 §7・7.2）。lightweight-charts（同梱・SRI）を使う。
// 足の長さは 約定の回数で区切る Tick・10T・30T・100T と、時間で区切る 1分〜1時間。
import { SPECS } from "../config.js";
import { decimals } from "../engine.js";
import { el, px } from "./dom.js";

const JST = 9 * 3600; // 時間の足は、秒の時刻に9時間を足して渡す（軸を日本時間で見せるため）
export const FRAMES = Object.freeze([
  ["tick", "Tick"], ["t10", "10T"], ["t30", "30T"], ["t100", "100T"],
  [1, "1分"], [5, "5分"], [15, "15分"], [60, "1時間"],
]);
export const FRAME_KEYS = Object.freeze(FRAMES.map(([f]) => f));
const TICK_N = Object.freeze({ tick: 1, t10: 10, t30: 30, t100: 100 });

function isTick(frame) {
  return Object.prototype.hasOwnProperty.call(TICK_N, frame);
}

function sma(bars, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    sum += bars[i].c;
    if (i >= n) sum -= bars[i - n].c;
    if (i >= n - 1) out.push({ time: bars[i].time, value: sum / n });
  }
  return out;
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const pad = (x) => String(x).padStart(2, "0");

// 日本時間の表示。sec=true で秒まで、date=true で月/日を前に付ける
function jstLabel(ms, { sec = false, date = false } = {}) {
  const d = new Date(ms + JST * 1000);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${sec ? `:${pad(d.getUTCSeconds())}` : ""}`;
  return date ? `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hm}` : hm;
}

export class ChartView {
  constructor(app) {
    this.app = app;
    this.frame = FRAME_KEYS.includes(app.settings.frame) ? app.settings.frame : 1;
    this.box = el("div", { class: "chart-box" });
    this.note = el("div", { class: "chart-note" });
    this.box.append(this.note);
    this.chips = FRAMES.map(([f, label]) => el("button", { class: "chip", text: label, attrs: { type: "button" },
      on: { click: () => { this.frame = f; app.settings.frame = f; app.saveSettings(); this.reset(); } } }));
    this.maBtn = el("button", { class: "chip", text: "MA 20/75", attrs: { type: "button" },
      on: { click: () => { app.settings.ma = !app.settings.ma; app.saveSettings(); this.reset(); } } });
    this.root = el("section", { class: "card", attrs: { "aria-label": "チャート" } }, [
      el("div", { class: "card-head" }, [el("h2", { text: "チャート" }), el("div", { class: "chips" }, [...this.chips, this.maBtn])]),
      this.box,
    ]);
    this.chart = null;
    this.key = "";
    this.xTime = new Map(); // ティックの横軸の番号 → 約定の時刻（ms）
  }

  // 軸と十字線の時刻。ティックは横軸が通し番号なので、約定の時刻に引き直す（04 R-29）
  label(time, full) {
    if (isTick(this.frame)) {
      const ms = this.xTime.get(time);
      return ms === undefined ? "" : jstLabel(ms, { sec: true, date: full });
    }
    const ms = (time - JST) * 1000;
    if (full) return jstLabel(ms, { date: true });
    const d = new Date(ms + JST * 1000);
    return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : jstLabel(ms);
  }

  ensure() {
    if (this.chart || !globalThis.LightweightCharts) return;
    const LC = globalThis.LightweightCharts;
    this.chart = LC.createChart(this.box, {
      autoSize: true,
      layout: { background: { color: css("--panel") }, textColor: css("--muted"), attributionLogo: true },
      grid: { vertLines: { color: css("--line") }, horzLines: { color: css("--line") } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: css("--line"), tickMarkFormatter: (t) => this.label(t, false) },
      rightPriceScale: { borderColor: css("--line") },
      crosshair: { mode: 0 },
      // 端末の言語設定に左右されない（変わった言語タグで落ちるのを防ぐ）。値段は板と同じ桁区切り
      localization: { locale: "ja-JP", priceFormatter: (p) => px(this.app.inst(), p), timeFormatter: (t) => this.label(t, true) },
    });
    this.candle = this.chart.addCandlestickSeries({
      upColor: css("--buy"), downColor: css("--sell"), borderVisible: false,
      wickUpColor: css("--buy"), wickDownColor: css("--sell"),
    });
    this.line = this.chart.addLineSeries({ color: css("--text"), lineWidth: 1, lastValueVisible: true, priceLineVisible: true });
    this.ma20 = this.chart.addLineSeries({ color: css("--accent"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    this.ma75 = this.chart.addLineSeries({ color: css("--muted"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  }

  // 銘柄・足の長さが変わったら過去の足（ティックは過去の約定）を取る。中継が無い・失敗したときは今まで通り
  loadHistory(inst) {
    const tick = isTick(this.frame);
    const hk = tick ? `${inst}|ticks` : `${inst}|${this.frame}`;
    if (!this.app.history.enabled || this.hk === hk) return;
    this.hk = hk;
    this.hist = "loading";
    const frame = this.frame;
    const job = tick
      ? this.app.history.trades(inst).then((list) => { if (list) this.app.candles.seedTicks(inst, list); })
      : this.app.history.load(inst, frame).then((bars) => { if (bars) this.app.candles.seed(inst, frame, bars); });
    job.then(() => {
      if (this.hk === hk) this.hist = "ok";
    }).catch(() => {
      if (this.hk === hk) this.hist = "fail";
    }).finally(() => {
      if (this.hk === hk) this.reset();
    });
  }

  // 空白から戻ったとき: 取り置きを捨てて、いま見ている足を取り直す
  refreshHistory() {
    this.app.history.clear();
    this.hk = "";
    this.reset();
  }

  reset() {
    this.key = "";
    this.update();
  }

  // 描く足（time 付き）。ティックは time = 番号 + 1、時間の足は time = 秒 + 9時間
  bars(inst) {
    if (isTick(this.frame)) {
      const out = this.app.candles.tickSeries(inst, TICK_N[this.frame]).map((b) => ({ ...b, time: b.x + 1 }));
      this.xTime = new Map(out.map((b) => [b.time, b.t]));
      return out;
    }
    return this.app.candles.series(inst, this.frame).map((b) => ({ ...b, time: b.t / 1000 + JST }));
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
    this.loadHistory(inst);
    const bars = this.bars(inst);
    const lineMode = this.frame === "tick";
    const point = (b) => (lineMode ? { time: b.time, value: b.c } : { time: b.time, open: b.o, high: b.h, low: b.l, close: b.c });
    const main = lineMode ? this.line : this.candle;
    const ma = () => {
      this.ma20.setData(this.app.settings.ma ? sma(bars, 20) : []);
      this.ma75.setData(this.app.settings.ma ? sma(bars, 75) : []);
    };
    const key = `${inst}|${this.frame}|${this.app.settings.ma}`;
    const lastTime = bars.length ? bars[bars.length - 1].time : null;
    if (key !== this.key) {
      const tick = SPECS[inst].tick;
      const priceFormat = { type: "price", precision: decimals(tick), minMove: tick };
      this.candle.applyOptions({ priceFormat });
      this.line.applyOptions({ priceFormat });
      (lineMode ? this.candle : this.line).setData([]);
      main.setData(bars.map(point));
      ma();
      // 銘柄・足の長さを変えたら、縦軸は自動に戻し、横の拡大も戻す（04 R-33。
      // 縦軸をつまむ・引くと自動が切れ、前の銘柄の値段の幅のまま残るため）
      this.chart.priceScale("right").applyOptions({ autoScale: true });
      this.chart.timeScale().applyOptions({ secondsVisible: isTick(this.frame) });
      this.chart.timeScale().resetTimeScale();
      this.chart.timeScale().scrollToRealTime();
      this.key = key;
      this.lastTime = lastTime;
    } else if (bars.length) {
      // 前に描いた最後の足から先を全部足す（描く間に何件も約定が来るため。最後の1本だけだと線が欠ける）
      let i = bars.length - 1;
      while (i > 0 && bars[i - 1].time >= this.lastTime) i -= 1;
      for (let j = i; j < bars.length; j += 1) main.update(point(bars[j]));
      if (lastTime !== this.lastTime) ma();
      this.lastTime = lastTime;
    }
    const tick = isTick(this.frame);
    this.note.textContent = this.hist === "loading" ? (tick ? "過去の約定を読み込んでいます" : "過去の足を読み込んでいます")
      : this.hist === "fail" && bars.length < 20 ? (tick ? "過去の約定を取れませんでした（開いてからの約定で作ります）" : "過去の足を取れませんでした（開いてからの約定で作ります）")
        : bars.length < 20 ? (tick ? `約定を待っています（${bars.length}本）` : `開いてからの約定で足を作っています（${bars.length}本）。閉じていた時間は空白になります`) : "";
  }
}
