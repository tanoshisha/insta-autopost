# insta-autopost

Lightroom で選んだ候補写真から AI が投稿する写真を選び、毎日インスタに自動投稿するツール。

## 普段の使い方

1. 投稿したい候補を Lightroom のアルバム「インスタ投稿」に入れる
   （Lightroom Classic から `inbox/` フォルダへ書き出しても OK。その場合はメタデータを「すべて」にし、位置情報を削除しない設定で書き出す）
2. PC が毎日自動で `plan.js` を実行し、以下を行う
   - AI が重複や失敗写真を外し、ポートレートかどうかを判定して投稿順を決める
   - フォトウォークの日に撮った写真は「東京フォトウォークサークル📷 / 第N回 ○○」を冒頭に付ける
   - 位置情報を付ける（フォトウォークの写真は開催場所、それ以外は写真の GPS から）
   - ハッシュタグをポートレート用とそれ以外で使い分ける
   - 4:5 に収まるようトリミングする（縦長の写真だけ・顔を避ける）
3. GitHub Actions が毎日 12:30 に投稿する。予約が10枚以上ある日は 20:00 にもう1枚投稿する

すぐ予約したい時は `インスタ予約.cmd` をダブルクリックする。

## 調整

| やりたいこと | 方法 |
|---|---|
| 予約一覧を見る | `npm run list` |
| 順番を変える・1枚外す | `queue.json` の並びを入れ替える・項目を消す（`queue/` の画像は残っていても害はない） |
| 一時停止 | `paused.json` に `{"paused": true}` と書いて push する |
| ハッシュタグ・投稿時刻 | `config.json`（時刻は `.github/workflows/post.yml` の cron が実体。UTC 表記） |
| 地名の呼び名 | `places.json` の `aliases`（例: 北沢→下北沢） |
| 位置情報を確実に付ける | `places.json` の `locationIds` に `"地名": "FacebookページID"` を書く |

## 秘密情報（git に入れない）
- `secrets.local.json` … インスタのトークン（`node setup-meta.js` で作成）。GitHub の Secrets には `IG_USER_ID` と `IG_TOKEN` を登録する
- Lightroom の認証は photo-publisher の `lr-cloud.config.json` を共有している。切れたら photo-publisher で `npm run lr:auth` を実行する
