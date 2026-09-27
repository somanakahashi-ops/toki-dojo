// GMO の公開配信への接続（05 §5）。購読・解除は1.1秒おきに1つずつ（GMO は1秒1回まで）。
import { SUB_INTERVAL_MS, WS_URL } from "./config.js";
import { message } from "./validate.js";

const CHANNELS = ["orderbooks", "trades", "ticker"];

export class Feed {
  constructor({ onMessage, onStatus, WebSocketImpl = globalThis.WebSocket, now = () => Date.now() }) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.WS = WebSocketImpl;
    this.now = now;
    this.wanted = new Set(); // 購読したい銘柄
    this.subscribed = new Set(); // 購読済み（銘柄|channel）
    this.queue = [];
    this.sock = null;
    this.retry = 0;
    this.timer = null;
    this.lastMsgAt = 0;
    this.status = "未接続";
  }

  setStatus(s) {
    this.status = s;
    this.onStatus?.(s);
  }

  connect() {
    if (this.sock) return;
    this.setStatus(this.retry ? "再接続中" : "接続中");
    let ws;
    try {
      ws = new this.WS(WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.sock = ws;
    ws.onopen = () => {
      // retry は値が届いてから 0 に戻す（つながってすぐ断られるのを繰り返さないように、待ちを伸ばしていく）
      this.subscribed.clear();
      this.queue = [];
      for (const sym of this.wanted) for (const ch of CHANNELS) this.enqueue("subscribe", sym, ch);
      this.pump();
      this.setStatus("接続中");
    };
    ws.onmessage = (ev) => {
      this.lastMsgAt = this.now();
      const m = message(ev.data, this.wanted);
      if (m && m.kind === "error" && /ERR-5003/.test(m.error)) {
        // 購読が断られた（速すぎた）。どの購読が落ちたか分からないので、つなぎ直して全部を順に購読し直す
        this.onMessage(m);
        try {
          ws.close();
        } catch {
          /* onclose で拾う */
        }
        return;
      }
      if (m) this.onMessage(m);
      if (m && m.kind !== "error") {
        this.retry = 0;
        if (this.status !== "つながっている") this.setStatus("つながっている");
      }
    };
    ws.onclose = () => {
      this.sock = null;
      this.subscribed.clear();
      this.setStatus("切断中");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* 閉じられなくても onclose で拾う */
      }
    };
  }

  scheduleReconnect() {
    const wait = Math.min(30000, 1000 * 2 ** this.retry);
    this.retry += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  enqueue(command, sym, ch) {
    const key = `${command}|${sym}|${ch}`;
    if (this.queue.some((q) => q.key === key)) return;
    this.queue.push({ key, command, sym, ch });
  }

  pump() {
    if (this.timer) return;
    const tick = () => {
      this.timer = null;
      const ws = this.sock;
      if (!ws || ws.readyState !== 1 || !this.queue.length) return;
      const q = this.queue.shift();
      const id = `${q.sym}|${q.ch}`;
      const need = q.command === "subscribe" ? !this.subscribed.has(id) : this.subscribed.has(id);
      if (need) {
        ws.send(JSON.stringify({ command: q.command, channel: q.ch, symbol: q.sym }));
        if (q.command === "subscribe") this.subscribed.add(id);
        else this.subscribed.delete(id);
        this.timer = setTimeout(tick, SUB_INTERVAL_MS);
      } else {
        this.timer = setTimeout(tick, 0);
      }
    };
    this.timer = setTimeout(tick, 0);
  }

  // 購読する銘柄の集合を差し替える（差分だけ購読・解除）
  setSymbols(symbols) {
    const next = new Set(symbols);
    for (const sym of this.wanted) if (!next.has(sym)) for (const ch of CHANNELS) this.enqueue("unsubscribe", sym, ch);
    for (const sym of next) if (!this.wanted.has(sym)) for (const ch of CHANNELS) this.enqueue("subscribe", sym, ch);
    // 表示中の銘柄を先に購読したいので、先頭の銘柄の購読を前に出す
    const first = symbols[0];
    this.queue.sort((a, b) => (b.sym === first && b.command === "subscribe") - (a.sym === first && a.command === "subscribe"));
    this.wanted = next;
    this.pump();
  }
}
