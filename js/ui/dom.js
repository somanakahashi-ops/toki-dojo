// 画面の組み立ての道具。★textContent と createElement だけを使う（N-2: HTML の文字列を解釈させる書き方をしない）。
import { SPECS } from "../config.js";
import { decimals } from "../engine.js";

export function el(tag, opts = {}, children = []) {
  const e = document.createElement(tag);
  if (opts.class) e.className = opts.class;
  if (opts.text !== undefined && opts.text !== null) e.textContent = String(opts.text);
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : String(v));
  if (opts.on) for (const [k, fn] of Object.entries(opts.on)) e.addEventListener(k, fn);
  for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function yen(x, { sign = false } = {}) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const r = Math.round(x);
  return `${sign && r > 0 ? "+" : ""}${r.toLocaleString("ja-JP")}円`;
}

export function px(inst, p) {
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  const d = decimals(SPECS[inst]?.tick ?? 1);
  return p.toLocaleString("ja-JP", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function qty(inst, q) {
  if (q === null || q === undefined || !Number.isFinite(q)) return "—";
  const d = decimals(SPECS[inst]?.step ?? 1);
  return q.toLocaleString("ja-JP", { minimumFractionDigits: 0, maximumFractionDigits: d });
}

export function pct(x, digits = 2) {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

export function hm(ms) {
  if (!ms) return "";
  const d = new Date(ms + 9 * 3600000);
  const p = (v) => String(v).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function signClass(x) {
  return x > 0 ? "up" : x < 0 ? "down" : "";
}
