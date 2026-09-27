// 組み立て（03 §1）: 保存から読み込み → 相場・足・口座・配信をつなぐ → 画面を描く。
import {
  BASES, CAPITAL_CHOICES, CAPITAL_DEFAULT, GAP_MS, LATENCY_CHOICES, LATENCY_MS, MAX_INSTRUMENTS, hasLeverage, instKey,
} from "./config.js";
import { Account, newState } from "./account.js";
import { Candles } from "./candles.js";
import { Market } from "./market.js";
import { Store } from "./store.js";
import { Feed } from "./ws.js";
import { el } from "./ui/dom.js";
import { Toasts } from "./ui/toast.js";
import { Header } from "./ui/header.js";
import { ChartView } from "./ui/chart.js";
import { BookView } from "./ui/book.js";
import { Ticket } from "./ui/ticket.js";
import { PositionsView } from "./ui/positions.js";
import { ReviewView } from "./ui/reviewView.js";
import { SettingsView } from "./ui/settings.js";

const TICK_MS = 250;
const SAVE_MS = 1000;
const RENDER_MS = 200;

// よそのページに埋め込まれたら描かない（N-2。Pages では frame-ancestors を送れないため）
function framed() {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

function cleanSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    capital: CAPITAL_CHOICES.includes(s.capital) ? s.capital : CAPITAL_DEFAULT,
    latency: LATENCY_CHOICES.includes(s.latency) ? s.latency : LATENCY_MS,
    levels: [10, 20].includes(s.levels) ? s.levels : 10,
    ma: s.ma !== false,
    confirm: s.confirm === true,
  };
}

function cleanView(raw) {
  const v = raw && typeof raw === "object" ? raw : {};
  const base = BASES.includes(v.base) ? v.base : "BTC";
  const market = v.market === "lev" && hasLeverage(base) ? "lev" : "spot";
  return { base, market, tab: ["trade", "review", "settings"].includes(v.tab) ? v.tab : "trade" };
}

// 保存された口座が壊れていたら作り直す（外から書き換えられる場所なので形を確かめる）
function validState(s) {
  return s && typeof s === "object" && s.version === 1 && Number.isFinite(s.cash) && Number.isFinite(s.initialCash)
    && Array.isArray(s.lev) && Array.isArray(s.orders) && Array.isArray(s.history) && s.spot && s.reserved;
}

class App {
  constructor(rootEl) {
    this.rootEl = rootEl;
    this.store = new Store();
    this.market = new Market();
    this.candles = new Candles(this.store);
    this.trades = [];
    this.dirty = false;
    this.renderQueued = false;
    this.lastRender = 0;
    this.pointerDown = false;
    this.gapped = false;
    this.lastTick = Date.now();
    this.hiddenAt = null;
    this.symKey = "";
    this.banner = el("div", { class: "banner", attrs: { hidden: true, role: "alert" } });
  }

  async start() {
    await this.store.open();
    this.settings = cleanSettings(await this.store.get("settings"));
    this.view = cleanView(await this.store.get("view"));
    await this.store.prune(Date.now());
    this.candles.load(await this.store.all("candles"), await this.store.all("quotes"));
    this.trades = (await this.store.all("trades")).sort((a, b) => a.exitTime - b.exitTime);
    const saved = await this.store.get("account");
    const state = validState(saved) ? saved : newState(this.settings.capital, Date.now());
    this.account = new Account({
      state, market: this.market, latency: () => this.settings.latency, onEvent: (e) => this.onEvent(e),
    });
    this.feed = new Feed({ onMessage: (m) => this.onMessage(m), onStatus: () => this.render() });
    this.build();
    // 前に閉じたときの待機中の注文は、その間の値動きが分からないので取り消す（外部設計 2-6）
    if (this.account.s.orders.length) this.account.onGap();
    this.dirty = true;
    this.updateSymbols();
    this.feed.connect();
    setInterval(() => this.tick(), TICK_MS);
    setInterval(() => this.save(), SAVE_MS);
    document.addEventListener("visibilitychange", () => this.onVisibility());
    window.addEventListener("pagehide", () => this.save(true));
    document.addEventListener("pointerdown", () => { this.pointerDown = true; }, true);
    const up = () => { this.pointerDown = false; this.render(); };
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    this.render();
  }

  inst() {
    return instKey(this.view.base, this.view.market);
  }

  build() {
    this.toasts = new Toasts(document.body);
    this.header = new Header(this);
    this.chart = new ChartView(this);
    this.book = new BookView(this);
    this.ticket = new Ticket(this);
    this.positions = new PositionsView(this);
    this.review = new ReviewView(this);
    this.settingsView = new SettingsView(this);
    this.tradeEl = el("div", { class: "trade" }, [
      el("div", { class: "col-left" }, [this.chart.root, this.positions.root]),
      el("div", { class: "col-right" }, [this.book.root, this.ticket.root]),
    ]);
    this.tabBtns = [["trade", "取引"], ["review", "振り返り"], ["settings", "設定"]].map(([k, label]) =>
      el("button", { text: label, attrs: { type: "button" }, on: { click: () => this.setTab(k) } }));
    this.rootEl.append(
      this.header.root, this.banner, this.header.acct, this.tradeEl, this.review.root, this.settingsView.root,
      el("nav", { class: "tabs", attrs: { "aria-label": "画面" } }, this.tabBtns),
    );
    this.showTab();
  }

  setTab(tab) {
    this.view.tab = tab;
    this.store.set("view", this.view);
    this.showTab();
    if (tab === "review") this.review.update(true);
    if (tab === "settings") this.settingsView.update();
    this.render();
  }

  showTab() {
    const t = this.view.tab;
    this.tradeEl.hidden = t !== "trade";
    this.review.root.hidden = t !== "review";
    this.settingsView.root.hidden = t !== "settings";
    for (const [i, k] of ["trade", "review", "settings"].entries()) this.tabBtns[i].classList.toggle("on", k === t);
  }

  setView({ base, market }) {
    if (base !== undefined && BASES.includes(base)) {
      this.view.base = base;
      if (!hasLeverage(base)) this.view.market = "spot";
    }
    if (market !== undefined && (market === "spot" || (market === "lev" && hasLeverage(this.view.base)))) this.view.market = market;
    this.store.set("view", this.view);
    this.updateSymbols();
    this.chart.reset();
    this.ticket.update();
    this.render();
  }

  // 表示中の銘柄を先頭に、注文・建玉のある銘柄を購読する（最大6。外部設計 3.1）
  updateSymbols() {
    const cur = this.inst();
    const list = [cur, ...[...this.account.activeInstruments()].filter((x) => x !== cur)].slice(0, MAX_INSTRUMENTS);
    const key = list.join(",");
    if (key === this.symKey) return;
    this.symKey = key;
    this.feed.setSymbols(list);
  }

  saveSettings() {
    this.store.set("settings", this.settings);
  }

  toast(type, message) {
    this.toasts.show(type, message);
  }

  onEvent(e) {
    this.dirty = true;
    if (e.type === "trade") {
      this.trades.push(e.trade);
      this.store.add("trades", e.trade);
    }
    if (e.type === "fill") this.store.add("fills", e.fill);
    const kind = { fill: "fill", reject: "reject", cancel: "reject", liquidation: "reject", info: "info", accepted: "info" }[e.type];
    if (kind && e.message) this.toast(kind, e.message);
    this.render();
  }

  onMessage(m) {
    if (m.kind === "error") {
      const text = /ERR-5003/.test(m.error) ? "配信の購読が混み合ったため、つなぎ直しています" : `配信からの知らせ: ${m.error}`;
      this.showBanner(text, 10000);
      return;
    }
    this.market.update(m);
    if (m.kind === "trade") {
      this.candles.onTrade(m.symbol, m.price, m.size, m.t);
      this.account.onTrade(m.symbol, m.price);
    } else if (m.kind === "book") {
      this.candles.onBook(m.symbol, this.market.bestBid(m.symbol), this.market.bestAsk(m.symbol), m.t);
      this.account.onBook(m.symbol);
    }
    if (this.gapped) {
      this.gapped = false;
      this.showBanner("");
    }
    this.render();
  }

  // ms を渡すと、その時間が過ぎたら消す（配信の知らせは一時的なもの。出しっぱなしにしない）
  showBanner(text, ms = 0) {
    this.banner.textContent = text;
    this.banner.hidden = !text;
    clearTimeout(this.bannerTimer);
    if (text && ms) this.bannerTimer = setTimeout(() => this.showBanner(""), ms);
  }

  gap(why) {
    if (this.gapped) return;
    this.gapped = true;
    this.account.onGap();
    this.showBanner(why);
    this.dirty = true;
  }

  tick() {
    const now = Date.now();
    // 端末が眠っていた（タイマーが止まっていた）
    if (now - this.lastTick > GAP_MS) this.gap("しばらく止まっていたため、待機中の注文を取り消しました");
    this.lastTick = now;
    // 配信が途切れている
    if (this.feed.lastMsgAt && now - this.feed.lastMsgAt > GAP_MS) this.gap("配信が30秒以上届いていません。つながり直すまで注文できません");
    const before = this.account.s.orders.length + this.account.s.lev.length;
    this.account.step(now);
    if (this.account.s.orders.length + this.account.s.lev.length !== before) this.dirty = true;
    this.updateSymbols();
    this.render();
  }

  onVisibility() {
    if (document.hidden) {
      this.hiddenAt = Date.now();
      this.save(true);
      return;
    }
    if (this.hiddenAt && Date.now() - this.hiddenAt > GAP_MS) this.gap("アプリが閉じていた間の値動きが分からないため、待機中の注文を取り消しました");
    this.hiddenAt = null;
    this.lastTick = Date.now();
    if (!this.feed.sock) this.feed.connect();
  }

  save(force = false) {
    if (!this.dirty && !force) return;
    this.dirty = false;
    this.store.set("account", this.account.s);
    if (force) this.candles.flush();
  }

  async reset(capital, keepTrades) {
    this.settings.capital = capital;
    this.saveSettings();
    this.account.s = newState(capital, this.market.serverNow());
    if (!keepTrades) {
      await this.store.clear("trades");
      await this.store.clear("fills");
      this.trades = [];
    }
    this.save(true);
    this.updateSymbols();
    this.review.update(true);
    this.toast("info", "口座を作り直しました");
    this.render();
  }

  // 描画は RENDER_MS に1回まで（スマホで重くしない。N-4）。
  // 指を置いている間は板・注文・建玉を描き直さない（押したボタンが差し替わって押せなくなるのを防ぐ）
  render() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    const wait = Math.max(0, this.lastRender + RENDER_MS - Date.now());
    setTimeout(() => requestAnimationFrame(() => this.draw()), wait);
  }

  draw() {
    this.renderQueued = false;
    this.lastRender = Date.now();
    this.header.update();
    if (this.view.tab === "trade") {
      this.chart.update();
      if (!this.pointerDown) {
        this.ticket.update();
        this.book.update();
        this.positions.update();
      }
    } else if (this.view.tab === "review") {
      this.review.update();
    }
  }
}

const root = document.getElementById("app");
if (framed()) {
  root.append(el("div", { class: "framed", text: "TOKI 道場は、ほかのページに埋め込んで使うことはできません。" }));
} else {
  new App(root).start().catch(() => {
    root.append(el("div", { class: "framed", text: "起動できませんでした。ページを読み込み直してください。" }));
  });
}
