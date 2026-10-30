// Lightroom Classic のカタログの写真を「トリミングなしの全体・向きを直した」画像で取り出す
//   カメラが一緒に保存した JPEG（同じ撮影時刻）があればそれ、なければ RAW の中の大きい JPEG
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const sharp = require("sharp");
sharp.cache(false);
const CAT = "C:/Lightroom/Lightroom Catalog.lrcat";
let db = null;
const open = () => (db ||= new DatabaseSync(CAT, { readOnly: true }));
const FILE = `select i.id_local id, i.captureTime t, i.orientation o, f.baseName name, lower(f.extension) ext, r.absolutePath || fo.pathFromRoot || f.baseName || '.' || f.extension p
  from Adobe_images i join AgLibraryFile f on f.id_local = i.rootFile join AgLibraryFolder fo on fo.id_local = f.folder join AgLibraryRootFolder r on r.id_local = fo.rootFolder`;

// RAW の中の JPEG を大きい順に（CR2 は RAW のデータ自体も JPEG の形なので、開けるものを探す）
function jpegs(buf) {
  const out = [];
  let i = 0;
  const SOI = Buffer.from([0xff, 0xd8, 0xff]), EOI = Buffer.from([0xff, 0xd9]);
  while ((i = buf.indexOf(SOI, i)) !== -1) {
    const next = buf.indexOf(SOI, i + 3);
    const stop = next === -1 ? buf.length : next;
    const last = buf.lastIndexOf(EOI, stop);
    if (last > i) out.push(buf.subarray(i, last + 2));
    i = stop;
  }
  return out.sort((a, b) => b.length - a.length);
}
function biggestJpeg(buf) {
  let best = null, i = 0;
  const SOI = Buffer.from([0xff, 0xd8, 0xff]), EOI = Buffer.from([0xff, 0xd9]);
  while ((i = buf.indexOf(SOI, i)) !== -1) {
    const next = buf.indexOf(SOI, i + 3);
    const stop = next === -1 ? buf.length : next;
    const last = buf.lastIndexOf(EOI, stop);
    if (last > i) {
      const piece = buf.subarray(i, last + 2);
      if (!best || piece.length > best.length) best = piece;
    }
    i = stop;
  }
  return best;
}
const ANG = { AB: 0, BC: 90, CD: 180, DA: 270 };

const byId = (id) => open().prepare(`${FILE} where i.id_local = ?`).get(id);
const byName = (name) => open().prepare(`${FILE} where f.baseName = ?`).all(name);
const near = (t, sec) => {
  const ms = Date.parse(t);
  if (!isFinite(ms)) return []; // 撮影時刻がない写真
  return open()
    .prepare(`${FILE} where i.captureTime between ? and ?`)
    .all(new Date(ms - sec * 1e3).toISOString().slice(0, 19), new Date(ms + sec * 1e3).toISOString().slice(0, 19).replace(/$/, ".999"));
};

// 全体の画像（Buffer）。取り出せなければ null
async function fullFrame(row) {
  if (!row) return null;
  const jp = ["jpg", "jpeg"].includes(row.ext) ? row : open().prepare(`${FILE} where i.captureTime = ? and lower(f.extension) in ('jpg','jpeg')`).all(row.t).find((x) => fs.existsSync(x.p));
  if (jp && fs.existsSync(jp.p)) return sharp(jp.p).rotate().resize({ width: 2400, height: 2400, fit: "inside" }).jpeg({ quality: 90 }).toBuffer();
  if (!fs.existsSync(row.p)) return null;
  const a = ANG[row.o] || 0;
  for (const j of jpegs(fs.readFileSync(row.p)).slice(0, 4)) {
    try {
      const m = await sharp(j).metadata();
      if (Math.max(m.width, m.height) < 1200) continue;
      return await sharp(j).rotate(a).resize({ width: 2400, height: 2400, fit: "inside" }).jpeg({ quality: 90 }).toBuffer();
    } catch {}
  }
  return null;
}
module.exports = { fullFrame, byId, byName, near };
