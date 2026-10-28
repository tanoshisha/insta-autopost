// post.js — 予約の先頭1枚をインスタに投稿する（GitHub Actions が毎日実行）。
//   必要な環境変数: IG_USER_ID, IG_TOKEN, GITHUB_REPOSITORY（Actionsが自動で入れる）
//   SLOT=2 のときは、予約が secondSlotMinQueue 枚以上ある日だけ投稿（在庫が多い時は1日2枚）
const fs = require("fs");
const path = require("path");
const { makeSync } = require("./lib/sync");

const ROOT = __dirname;
const GRAPH = "https://graph.facebook.com/v26.0";
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const read = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
  } catch {
    return d;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const syncCommit = makeSync(ROOT);

async function graph(method, p, params) {
  const body = new URLSearchParams({ ...params, access_token: process.env.IG_TOKEN });
  const url = method === "GET" ? `${GRAPH}${p}?${body}` : `${GRAPH}${p}`;
  const r = await fetch(url, method === "GET" ? {} : { method, body });
  const j = await r.json();
  if (j.error) throw new Error(`${p}: ${j.error.message}`);
  return j;
}

// 投稿した1枚を予約から外して記録（最新の予約に対して行う）
function record(item, rec) {
  syncCommit(`posted ${item.id}`, [], (remote) => {
    const q = remote("queue.json", []).filter((x) => x.id !== item.id);
    const posted = remote("posted.json", []);
    if (rec && !posted.some((p) => p.id === item.id)) posted.push(rec);
    const out = { "queue.json": q, "posted.json": posted, [item.image]: null };
    if (item.thumb) out[item.thumb] = null;
    return out;
  });
}

async function main() {
  const queue = read("queue.json", []);
  const posted = read("posted.json", []);
  const slot = process.env.SLOT || "1";
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

  if (read("paused.json", null)?.paused) return console.log("一時停止中（paused.json）");
  if (!queue.length) return console.log("予約が空です");
  if (slot === "2" && queue.length < cfg.schedule.secondSlotMinQueue)
    return console.log(`予約 ${queue.length}枚 < ${cfg.schedule.secondSlotMinQueue}枚 なので2枠目はお休み`);
  if (posted.some((p) => p.day === today && p.slot === slot)) return console.log("この枠は投稿済み");

  const item = queue[0];
  // 前回、投稿後の記録だけ失敗していた場合は記録だけ直す（二重投稿しない）
  if (posted.some((p) => p.id === item.id)) {
    console.log("投稿済みの写真が予約に残っていたので外します: " + item.id);
    return record(item, null);
  }

  const imageUrl = `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/main/${item.image}`;
  console.log(`投稿: ${item.id}\n${imageUrl}`);

  const params = { image_url: imageUrl, caption: item.caption };
  if (item.locationId) params.location_id = item.locationId;
  let container;
  try {
    container = await graph("POST", `/${process.env.IG_USER_ID}/media`, params);
  } catch (e) {
    // 位置IDが原因で失敗した時は位置情報なしで再挑戦
    if (!params.location_id) throw e;
    console.log("位置情報つきで失敗 → 位置なしで再挑戦: " + e.message);
    delete params.location_id;
    container = await graph("POST", `/${process.env.IG_USER_ID}/media`, params);
  }
  for (let i = 0; i < 30; i++) {
    const s = await graph("GET", `/${container.id}`, { fields: "status_code" });
    if (s.status_code === "FINISHED") break;
    if (s.status_code === "ERROR") throw new Error("インスタ側で画像の処理に失敗");
    await sleep(5000);
  }
  const pub = await graph("POST", `/${process.env.IG_USER_ID}/media_publish`, { creation_id: container.id });
  const info = await graph("GET", `/${pub.id}`, { fields: "permalink,media_url" }).catch(() => ({}));

  const { image, thumb, ...rest } = item;
  record(item, { ...rest, mediaId: pub.id, permalink: info.permalink, mediaUrl: info.media_url, postedAt: new Date().toISOString(), day: today, slot });
  console.log(`✅ 投稿しました ${info.permalink || pub.id}`);
}

main().catch((e) => {
  console.error("エラー: " + e.message);
  process.exit(1);
});
