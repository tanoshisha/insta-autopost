// make-retouch-list.js — 過去の写真を AI でレタッチし直す順番の一覧を作る（Lightroom Classic のプラグインが読む）
//   本人の指示（2026-10-31）：過去の写真も全部レタッチし直してよい・上書きOK・載せた写真はトリミング/ジオメトリを変えない
//   順番：① インスタ・サイトに載せた写真（トリミング固定あり）② リール候補（点数6以上・人なし）③ 残り（点数の高い順）
//   出力：classic-retouch-list.tsv  … uuid \t 優先 \t CropLeft \t CropTop \t CropRight \t CropBottom \t CropAngle \t ジオメトリ(k=v;k=v)
//   node make-retouch-list.js
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const ROOT = __dirname;
const db = new DatabaseSync("C:/Lightroom/Lightroom Catalog.lrcat", { readOnly: true });
const uuidOf = db.prepare("select id_global u from Adobe_images where id_local = ?");
const judged = Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, ".work", "lrpick", "judged.json"), "utf8")));
const lock = fs.existsSync(path.join(ROOT, "crop-lock.json")) ? JSON.parse(fs.readFileSync(path.join(ROOT, "crop-lock.json"), "utf8")) : [];
const done = new Set(fs.existsSync(path.join(ROOT, "classic-retouch-done.txt")) ? fs.readFileSync(path.join(ROOT, "classic-retouch-done.txt"), "utf8").split(/\r?\n/).filter(Boolean) : []);

const rows = new Map(); // id_local → row
const posted = new Set(lock.filter((r) => r.lr?.id).map((r) => String(r.lr.id)));
const add = (id, pri, crop, geom, toCloud) => {
  if (rows.has(id)) return;
  const u = uuidOf.get(Number(id))?.u;
  if (!u || done.has(u)) return;
  const c = crop ? [crop.left, crop.top, crop.right, crop.bottom, crop.angle].map((v) => (v == null ? "" : v)) : ["", "", "", "", ""];
  const g = geom ? Object.entries(geom).filter(([k]) => /^(PerspectiveUpright|PerspectiveVertical|PerspectiveHorizontal|PerspectiveRotate|PerspectiveScale|PerspectiveAspect|PerspectiveX|PerspectiveY|UprightTransform_\d|UprightVersion|UprightCenterMode|UprightCenterNormX|UprightCenterNormY|UprightFocalMode|UprightFocalLength35mm|UprightFourSegmentsCount|UprightPreview|UprightTransformCount|UprightDependent|LensProfileEnable|LensManualDistortionAmount|AutoLateralCA)$/.test(k)).map(([k, v]) => `${k}=${v}`).join(";") : "";
  // 9列目：レタッチ後に Classic の「インスタ投稿」コレクションへ入れる（＝クラウドの「インスタ投稿」に投稿の候補として入る）。載せたことのある写真は入れない
  rows.set(id, [u, pri, ...c, g, toCloud && !posted.has(String(id)) ? "1" : ""].join("\t"));
};
// ⓪ 投稿予定（queue）の写真：新しい基準で先にレタッチして、クラウド経由で予約の画像に反映する（本人の指示 2026-11-01）
try {
  const q = JSON.parse(require("child_process").execSync("git show origin/main:queue.json", { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 }));
  const byAsset = db.prepare("select image id from AgLibraryImageOzAssetIds where ozAssetId = ?");
  let n = 0;
  for (const x of q) {
    const r = x.lrId ? byAsset.get(String(x.lrId)) : null;
    if (r) add(r.id, 0, null, null), n++;
  }
  console.log(`投稿予定 ${q.length}件のうち Classic にある ${n}件を先頭に`);
} catch (e) {
  console.log("投稿予定の一覧が読めませんでした：" + e.message.slice(0, 80));
}
// ①' 点数がとても高い写真（9点以上。本人「点数めちゃくちゃ高いやつとか」2026-11-01）。Fable の採点が途中の間は前の採点（judged.sonnet.json）も見る
try {
  const old = fs.existsSync(path.join(ROOT, ".work", "lrpick", "judged.sonnet.json")) ? Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, ".work", "lrpick", "judged.sonnet.json"), "utf8"))) : [];
  const top = [...judged, ...old].filter((j) => j.score >= 9).sort((a, b) => b.score - a.score);
  for (const x of top) add(x.id, 1, null, null, true);
  console.log(`9点以上 ${new Set(top.map((x) => x.id)).size}枚を次に`);
} catch {}
// ① 載せた写真（トリミング固定）。人が写っていてもレタッチし直す（トリミングは変えない）
for (const r of lock) if (r.lr?.crop) add(r.lr.id, 1, r.lr.crop, r.lr.geom || null);
// ② リール候補（点数6以上・人なし）
for (const x of judged.filter((j) => !j.people && j.score >= 6).sort((a, b) => b.score - a.score)) add(x.id, 2, null, null);
// ③ 残り（点数の高い順。人あり含む）
for (const x of judged.sort((a, b) => (b.score || 0) - (a.score || 0))) add(x.id, 3, null, null);
const out = [...rows.values()].sort((a, b) => a.split("\t")[1] - b.split("\t")[1]);
fs.writeFileSync(path.join(ROOT, "classic-retouch-list.tsv"), out.join("\n") + "\n");
const n = (p) => out.filter((l) => l.split("\t")[1] == p).length;
console.log(`レタッチし直しの一覧 ${out.length}枚（① 載せた写真 ${n(1)}・② リール候補 ${n(2)}・③ 残り ${n(3)}）→ classic-retouch-list.tsv`);
