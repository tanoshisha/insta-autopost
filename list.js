// list.js — 投稿予定の一覧（順番を変えたい時は queue.json の並びを入れ替える／消したい時はその項目を削除）
const fs = require("fs");
const path = require("path");
const q = JSON.parse(fs.readFileSync(path.join(__dirname, "queue.json"), "utf8"));
if (!q.length) console.log("投稿予定はありません。");
q.forEach((it, i) => {
  const head = it.caption.split("\n\n")[0];
  console.log(`${String(i + 1).padStart(2)}. ${it.id}  ${it.portrait ? "ポートレート" : "スナップ"}  📍${it.locationName || "なし"}`);
  if (it.event) console.log(`    ${head.replace(/\n/g, " / ")}`);
});
