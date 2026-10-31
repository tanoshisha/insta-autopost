// find-stuck-sync.js — クラウド同期が止まっている写真（カタログで ozAssetId が pending のまま）を探して classic-resync.txt に書く
//   → Classic のメニュー「同期が止まった写真をやり直す」が、コレクションから外して入れ直す
//   node find-stuck-sync.js
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("C:/Lightroom/Lightroom Catalog.lrcat", { readOnly: true });
const rows = db
  .prepare(
    `select i.id_global u, f.baseName || '.' || f.extension n from AgLibraryImageOzAssetIds o join Adobe_images i on o.image = i.id_local
     join AgLibraryFile f on f.id_local = i.rootFile where o.ozAssetId = 'pending'`
  )
  .all();
fs.writeFileSync(path.join(__dirname, "classic-resync.txt"), rows.map((r) => `${r.u}\t${r.n}`).join("\n") + "\n");
console.log(`同期が止まっている写真 ${rows.length}枚：${rows.map((r) => r.n).join("・")}`);
