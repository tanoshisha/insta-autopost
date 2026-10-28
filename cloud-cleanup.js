// cloud-cleanup.js — クラウド版Lightroomを「投稿予定の写真だけ」にするための一覧を作る（クラウドもカタログも変更しない）
//   残す: クラウドのアルバム「インスタ投稿」「ポートフォリオサイト」に入っている写真 ＋ まだ投稿していない予約・見送りの写真
//   外す: それ以外の同期写真（Classic側に元の写真ファイルがあるものだけ。無いものは外さない＝消えると困るので）
//   出力: classic-cloud-remove.tsv（Classicの写真のUUID）→ Classicのプラグイン「クラウド整理の準備」が目印のキーワードを付ける
//   node cloud-cleanup.js
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { connect, listAlbum } = require("./lib/lightroom");

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const KEEP_ALBUMS = [cfg.lightroom.albumName, "ポートフォリオサイト"];
const remote = (p, d) => {
  try {
    return JSON.parse(execFileSync("git", ["show", `origin/main:${p}`], { cwd: ROOT, encoding: "utf8" }));
  } catch {
    return d;
  }
};

(async () => {
  execFileSync("git", ["fetch", "-q", "origin", "main"], { cwd: ROOT });
  const keep = new Set();
  for (const x of [...remote("queue.json", []), ...remote("pool.json", [])]) if (x.lrId) keep.add(x.lrId);
  const fromQueue = keep.size;
  const lr = await connect(cfg.lightroom.configPath);
  for (const name of KEEP_ALBUMS) for (const a of (await listAlbum(lr, name)) || []) keep.add(a.id);
  console.log(`残す写真: ${keep.size}枚（予約・見送り ${fromQueue}枚＋アルバム ${KEEP_ALBUMS.join("・")}）`);

  const db = new DatabaseSync("C:/Lightroom/Lightroom Catalog.lrcat", { readOnly: true });
  const rows = db
    .prepare(
      `select i.id_global uuid, o.ozAssetId asset, r.absolutePath || d.pathFromRoot || f.baseName || '.' || f.extension p
       from AgLibraryImageOzAssetIds o join Adobe_images i on o.image = i.id_local
       join AgLibraryFile f on i.rootFile = f.id_local join AgLibraryFolder d on f.folder = d.id_local join AgLibraryRootFolder r on d.rootFolder = r.id_local
       where o.ozAssetId != 'pending'`
    )
    .all();
  const remove = [];
  let noLocal = 0;
  for (const r of rows) {
    if (keep.has(r.asset)) continue;
    if (!fs.existsSync(r.p)) {
      noLocal++;
      continue;
    }
    remove.push(r.uuid);
  }
  fs.writeFileSync(path.join(ROOT, "classic-cloud-remove.tsv"), remove.join("\n") + "\n");
  console.log(`クラウドの同期写真: ${rows.length}枚 → 外す ${remove.length}枚`);
  if (noLocal) console.log(`※ Classic側に元ファイルが見つからない ${noLocal}枚は外しません（クラウドにしか無い可能性）`);
})().catch((e) => {
  console.error("エラー: " + e.message);
  process.exit(1);
});
