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

test("接続先は GMO の公開配信だけ", () => {
  for (const p of own.filter((x) => x.endsWith(".js"))) {
    const s = readFileSync(p, "utf8");
    assert.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon|EventSource/.test(s), `${p} が通信している`);
    for (const m of s.matchAll(/(?:wss?|https?):\/\/[^\s"'`)]+/g)) {
      assert.equal(m[0], "wss://api.coin.z.com/ws/public/v1", `${p} に ${m[0]}`);
    }
  }
});

test("index.html に CSP があり、外部のスクリプトを読まず、同梱のチャートに SRI が合う", () => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, "CSP の meta が無い");
  for (const d of ["default-src 'none'", "script-src 'self'", "connect-src wss://api.coin.z.com", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(csp[1].includes(d), `CSP に ${d} が無い`);
  }
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp[1]));
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
