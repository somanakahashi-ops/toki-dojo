# 過去の足の中継（Cloudflare Workers）

GMO の過去の足（公開データ）は、ブラウザから直接は読めません（CORS の許可が無い）。
`worker.js` は、それを**読むことだけ**取り次ぐ小さな中継です。

- 鍵を持ちません。書き込み・注文の道はありません。GET だけです
- 取り次ぐのは「15銘柄 × 1分・5分・15分・1時間 × 7日以内の日付」の過去の足だけで、ほかは断ります
- 読める元（CORS）は `https://somanakahashi-ops.github.io` だけです
- 無料枠は1日10万回です。使い切られても中継が止まるだけで、アプリは今まで通り（開いてからの約定で足を作る）動きます

## 置き方（最初の1回・5分ほど）

1. https://dash.cloudflare.com/sign-up で無料アカウントを作る（メールの確認まで）
2. 左の **Workers & Pages**（「Compute」の下にあることもある）→ **Create** → **Create Worker**（「Start with Hello World!」）
3. 名前を `toki-dojo-relay` にして **Deploy**
4. **Edit code** を開き、左のファイル（`worker.js`）の中身を**全部消して**、このフォルダの `worker.js` の中身を貼る → 右上の **Deploy**
5. 表示される URL（`https://toki-dojo-relay.<あなたの名前>.workers.dev`）を Claude に伝える

確かめ方: ブラウザで `https://toki-dojo-relay.<あなたの名前>.workers.dev/klines?symbol=BTC&interval=1hour&date=<今日の日付 例 20260928>` を開き、
`{"status":0,"data":[...]}` が出れば動いています（日付は日本時間の朝6時で変わります）。

`worker.js` を変えたら、同じ手順4で貼り直してください（Workers & Pages → `toki-dojo-relay` → Edit code → 全部消して貼る → Deploy）。

- 2026-09-28: 最近の約定（`/trades`・ティック足用）を足した。貼り直すまではティック足の過去の約定が出ない（開いてからの約定で作る）
