// setup-meta.js — インスタ投稿用の「期限なしトークン」とアカウントIDを取得して secrets.local.json に保存する。
//   node setup-meta.js <アプリID> <app secret> <グラフAPIエクスプローラーで出した短期トークン>
const fs = require("fs");
const path = require("path");
const GRAPH = "https://graph.facebook.com/v23.0";
const [appId, appSecret, shortToken] = process.argv.slice(2);
if (!shortToken) {
  console.log("使い方: node setup-meta.js <アプリID> <app secret> <短期トークン>");
  process.exit(1);
}
const get = async (p, q) => {
  const r = await fetch(`${GRAPH}${p}?${new URLSearchParams(q)}`);
  const j = await r.json();
  if (j.error) throw new Error(`${p}: ${j.error.message}`);
  return j;
};

(async () => {
  // 短期 → 長期（60日）ユーザートークン
  const long = await get("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortToken,
  });
  // 長期ユーザートークンから取ったページトークンは期限なし
  const pages = await get("/me/accounts", { fields: "id,name,access_token,instagram_business_account{id,username}", access_token: long.access_token });
  const page = (pages.data || []).find((p) => p.instagram_business_account);
  if (!page) throw new Error("インスタと連携したFacebookページが見つかりません（トークン作成時にページとインスタを選びましたか？）");
  const ig = page.instagram_business_account;
  const secrets = { igUserId: ig.id, igUsername: ig.username, pageName: page.name, igToken: page.access_token };
  fs.writeFileSync(path.join(__dirname, "secrets.local.json"), JSON.stringify(secrets, null, 2) + "\n");
  const dbg = await get("/debug_token", { input_token: page.access_token, access_token: `${appId}|${appSecret}` });
  console.log(`✅ @${ig.username}（ページ: ${page.name}）`);
  console.log(`   トークン期限: ${dbg.data.expires_at ? new Date(dbg.data.expires_at * 1000).toLocaleString("ja-JP") : "なし"}`);

  // 位置ID検索が使えるか確認
  const s = await fetch(`${GRAPH}/pages/search?q=${encodeURIComponent("下北沢")}&fields=id,name,location&access_token=${page.access_token}`).then((r) => r.json());
  console.log(s.error ? `   位置ID検索: 使えません（${s.error.message.slice(0, 80)}）` : `   位置ID検索: OK（例: ${s.data?.[0]?.name}）`);
  console.log("\nsecrets.local.json に保存しました。");
})().catch((e) => {
  console.error("エラー: " + e.message);
  process.exit(1);
});
