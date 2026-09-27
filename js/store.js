// IndexedDB の読み書き（03 §5）。すべて try/catch。使えなければ記憶だけで動く（available=false）。
import { DB_NAME, FILLS_MAX, KEEP_DAYS, TRADES_MAX } from "./config.js";

const VERSION = 1;

export class Store {
  constructor() {
    this.db = null;
    this.available = false;
    this.mem = { kv: new Map(), trades: new Map(), fills: new Map(), candles: new Map(), quotes: new Map() };
  }

  async open() {
    try {
      if (typeof indexedDB === "undefined") return false;
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore("kv");
          db.createObjectStore("trades", { keyPath: "id" });
          db.createObjectStore("fills", { keyPath: "id" });
          db.createObjectStore("candles", { keyPath: ["inst", "t"] });
          db.createObjectStore("quotes", { keyPath: ["inst", "t"] });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      this.available = true;
    } catch {
      this.db = null;
      this.available = false;
    }
    return this.available;
  }

  async tx(name, mode, fn) {
    if (!this.db) return null;
    try {
      return await new Promise((resolve, reject) => {
        const t = this.db.transaction(name, mode);
        const st = t.objectStore(name);
        let out = null;
        const r = fn(st);
        if (r && "onsuccess" in r) r.onsuccess = () => { out = r.result; };
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } catch {
      return null;
    }
  }

  async get(key) {
    if (!this.db) return this.mem.kv.get(key) ?? null;
    return this.tx("kv", "readonly", (st) => st.get(key));
  }

  async set(key, value) {
    if (!this.db) return this.mem.kv.set(key, value);
    return this.tx("kv", "readwrite", (st) => st.put(value, key));
  }

  async add(name, row) {
    if (!this.db) return this.mem[name].set(row.id ?? `${row.inst}|${row.t}`, row);
    return this.tx(name, "readwrite", (st) => st.put(row));
  }

  async all(name) {
    if (!this.db) return [...this.mem[name].values()];
    return (await this.tx(name, "readonly", (st) => st.getAll())) || [];
  }

  async clear(name) {
    if (!this.db) return this.mem[name].clear();
    return this.tx(name, "readwrite", (st) => st.clear());
  }

  // 上限を超えたぶんを古いものから消す（N-5）
  async prune(nowMs) {
    const cutoff = nowMs - KEEP_DAYS * 86400000;
    for (const name of ["candles", "quotes"]) {
      const rows = await this.all(name);
      const old = rows.filter((r) => r.t < cutoff);
      for (const r of old) {
        if (!this.db) this.mem[name].delete(`${r.inst}|${r.t}`);
        else await this.tx(name, "readwrite", (st) => st.delete([r.inst, r.t]));
      }
    }
    for (const [name, max, key] of [["trades", TRADES_MAX, "exitTime"], ["fills", FILLS_MAX, "time"]]) {
      const rows = await this.all(name);
      if (rows.length <= max) continue;
      rows.sort((a, b) => a[key] - b[key]);
      for (const r of rows.slice(0, rows.length - max)) {
        if (!this.db) this.mem[name].delete(r.id);
        else await this.tx(name, "readwrite", (st) => st.delete(r.id));
      }
    }
  }
}
