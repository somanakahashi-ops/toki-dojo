// 構造のテスト（05 §8・N-1 N-2）: 公開物に鍵・非公開 API・危険な描画・外部のスクリプトが無いこと。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".git")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

const own = files(ROOT).filter((p) => /\.(js|mjs|html|css|json|webmanifest)$/.test(p) && !p.includes("/vendor/") && !p.includes("/test/"));

test("自前のコードに鍵・非公開 API・危険な描画が無い", () => {
  const banned = [/\/private/, /apiKey/i, /API-KEY/, /API-SIGN/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/,
    /document\.write/, /\beval\(/, /new Function/, /setTimeout\(\s*["'`]/];
  for (const p of own) {
    const s = readFileSync(p, "utf8");
    for (const re of banned) assert.ok(!re.test(s), `${p} に ${re} がある`);
  }
});

test("接続先は GMO の公開配信と中継だけ。HTTP で取りに行くのは history.js だけ", async () => {
  const { RELAY_URL, WS_URL } = await import("../js/config.js");
  const allowed = [WS_URL, RELAY_URL].filter(Boolean);
  for (const p of own.filter((x) => x.endsWith(".js") && !x.includes("/relay/"))) {
    const s = readFileSync(p, "utf8");
    assert.ok(!/XMLHttpRequest|sendBeacon|EventSource|importScripts/.test(s), `${p} が通信している`);
    if (!p.endsWith("/js/history.js")) assert.ok(!/\bfetch\b/.test(s), `${p} が fetch している`);
    for (const m of s.matchAll(/(?:wss?|https?):\/\/[^\s"'`)]+/g)) assert.ok(allowed.includes(m[0]), `${p} に ${m[0]}`);
  }
});

test("中継は GMO の過去の足だけに取り次ぎ、読める元は Pages だけ", () => {
  const s = readFileSync(join(ROOT, "relay/worker.js"), "utf8");
  const urls = [...s.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(urls)].sort(), ["https://api.coin.z.com/public/v1/klines", "https://somanakahashi-ops.github.io"]);
});

test("index.html に CSP があり、外部のスクリプトを読まず、同梱のチャートに SRI が合う", async () => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, "CSP の meta が無い");
  for (const d of ["default-src 'none'", "script-src 'self'", "connect-src wss://api.coin.z.com", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(csp[1].includes(d), `CSP に ${d} が無い`);
  }
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp[1]));
  // connect-src は配信と中継の origin だけ
  const { RELAY_URL } = await import("../js/config.js");
  const connect = csp[1].match(/connect-src ([^;]+)/)[1].trim().split(/\s+/);
  assert.deepEqual(connect, ["wss://api.coin.z.com", ...(RELAY_URL ? [new URL(RELAY_URL).origin] : [])]);
  assert.ok(!/<script[^>]+src="https?:/.test(html), "外部のスクリプトがある");
  assert.ok(!/<script>(?!\s*<\/script>)/.test(html), "インラインのスクリプトがある");
  const sri = html.match(/src="(vendor\/[^"]+)" integrity="sha256-([^"]+)"/);
  assert.ok(sri, "vendor に SRI が無い");
  const digest = createHash("sha256").update(readFileSync(join(ROOT, sri[1]))).digest("base64");
  assert.equal(digest, sri[2]);
});

test("ワークフロー（自動で動くもの）を置かない", () => {
  assert.ok(!files(ROOT).some((p) => p.includes("/.github/workflows/")));
});
