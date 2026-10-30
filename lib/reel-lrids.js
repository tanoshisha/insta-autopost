// リールの写真が、Lightroom Classic のどの写真か（カタログの id）を突き合わせる
//   ① sources の "lr:ID"（Lightroom から選んだ写真）
//   ② queue/pool の写真なら、その lrId
//   ③ どちらもなければ、撮影日の Lightroom プレビューと見た目（dHash）で照合
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { DatabaseSync } = require("node:sqlite");
const { dhash, dist } = require("./dedupe");
const CAT = "C:/Lightroom/Lightroom Catalog.lrcat";
const PREV = "C:/Lightroom/Lightroom Catalog Previews.lrdata";

async function previewsOfDay(day) {
  const db = new DatabaseSync(CAT, { readOnly: true });
  const rows = db.prepare("select id_local id, orientation o from Adobe_images where captureTime like ?").all(day + "%");
  const pdb = new DatabaseSync(path.join(PREV, "previews.db"), { readOnly: true });
  const ent = pdb.prepare("select uuid, digest from ImageCacheEntry where imageId = ?");
  const out = [];
  const tmp = path.join(__dirname, "..", ".work", "lrid-prev");
  fs.mkdirSync(tmp, { recursive: true });
  for (const r of rows) {
    const e = ent.get(r.id);
    if (!e) continue;
    const dir = path.join(PREV, e.uuid[0], e.uuid.slice(0, 4));
    if (!fs.existsSync(dir)) continue;
    const s = fs.readdirSync(dir).filter((f) => f.startsWith(`${e.uuid}-${e.digest}_`)).map((f) => ({ f, n: +f.split("_").pop() })).filter((x) => x.n > 0).sort((a, b) => a.n - b.n)[0];
    if (!s) continue;
    const f = path.join(tmp, `${r.id}.jpg`);
    try {
      if (!fs.existsSync(f)) await sharp(path.join(dir, s.f)).rotate({ AB: 0, BC: 90, CD: 180, DA: 270 }[r.o] || 0).resize(400).jpeg().toFile(f);
      out.push({ id: r.id, h: await dhash(f) });
    } catch {}
  }
  return out;
}

// x: specials の1件、files: 各写真のローカルファイル（x.images と同じ順）、pool: pool.json+queue.json の中身
async function resolveLrIds(x, files, pool = []) {
  const ids = [];
  const byImg = Object.fromEntries(pool.filter((p) => p.image && /^\d+$/.test(String(p.lrId))).map((p) => [p.image, p.lrId]));
  // 撮影日：sourceDate がなければ、sources の Lightroom 写真の撮影日
  let day = x.sourceDate;
  if (!day) {
    const lid = (x.sources || []).find((v) => String(v).startsWith("lr:"));
    if (lid) day = String(new DatabaseSync(CAT, { readOnly: true }).prepare("select captureTime t from Adobe_images where id_local = ?").get(+lid.slice(3))?.t || "").slice(0, 10) || null;
  }
  let prev = null;
  for (const [i, p] of x.images.entries()) {
    const src = (x.sources || [])[i];
    if (x.lrIds?.[i] && /^\d+$/.test(String(x.lrIds[i]))) ids.push(+x.lrIds[i]);
    else if (typeof src === "string" && src.startsWith("lr:") && (x.sources || []).length === x.images.length) ids.push(+src.slice(3));
    else if (byImg[p]) ids.push(+byImg[p]);
    else if (day && files[i]) {
      prev = prev || (await previewsOfDay(day));
      const h = await dhash(files[i]);
      let best = null;
      let bd = 1e9;
      for (const c of prev) {
        const d = dist(h, c.h);
        if (d < bd) (bd = d), (best = c.id);
      }
      ids.push(bd < 14 ? best : null);
    } else ids.push(null);
  }
  return ids;
}
module.exports = { resolveLrIds, previewsOfDay };
