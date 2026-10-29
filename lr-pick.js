// lr-pick.js — Lightroom Classic のカタログから、リールに使える写真（レタッチ済み・★5、人の顔なし）を集める
//   レタッチ後の見た目は Lightroom のプレビュー（Previews.lrdata の .lrprev の中の JPEG）から取り出す（Lightroom を開いていても読める）
//   対象：★5・採用の旗（P）・レタッチ済み の写真
//   node lr-pick.js      → .work/lrpick/<id>.jpg（大）と thumbs/<id>.jpg（AIが見る用）と list.json
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const sharp = require("sharp");
sharp.cache(false);

const CAT = "C:/Lightroom/Lightroom Catalog.lrcat";
const PREV = "C:/Lightroom/Lightroom Catalog Previews.lrdata";
const OUT = path.join(__dirname, ".work", "lrpick");

// .lrprev の中の JPEG を全部探して、いちばん大きいものを返す
function biggestJpeg(buf) {
  let best = null;
  let i = 0;
  while ((i = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]), i)) !== -1) {
    const end = buf.indexOf(Buffer.from([0xff, 0xd9]), i + 3);
    if (end === -1) break;
    // 次の JPEG の始まりまでを1つとみなす（中に FFD9 が出てくることがあるので、最後の FFD9 を探す）
    const next = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]), i + 3);
    const stop = next === -1 ? buf.length : next;
    const last = buf.lastIndexOf(Buffer.from([0xff, 0xd9]), stop);
    const piece = buf.subarray(i, last + 2);
    if (!best || piece.length > best.length) best = piece;
    i = stop;
  }
  return best;
}

(async () => {
  fs.mkdirSync(path.join(OUT, "thumbs"), { recursive: true });
  const db = new DatabaseSync(CAT, { readOnly: true });
  const rows = db
    .prepare(
      `select i.id_local id, i.captureTime t, i.rating r, i.orientation o, f.baseName name, fo.pathFromRoot dir
       from Adobe_images i join Adobe_imageDevelopSettings d on d.image = i.id_local
       join AgLibraryFile f on f.id_local = i.rootFile join AgLibraryFolder fo on fo.id_local = f.folder
       where (i.rating = 5 or i.pick = 1 or d.text like '%Highlights2012 = -%') and fo.pathFromRoot not like '%スクールフォト%'
       and not exists (select 1 from AgLibraryFace fa where fa.image = i.id_local)
       order by i.captureTime`
    )
    .all();
  const pdb = new DatabaseSync(path.join(PREV, "previews.db"), { readOnly: true });
  const ent = pdb.prepare("select uuid, digest from ImageCacheEntry where imageId = ?");
  const pyr = pdb.prepare("select quality from Pyramid where uuid = ? and digest = ?");
  // 連写の似た写真は1枚に（20秒以内に続いた写真は、最初の1枚だけ）
  const list = [];
  let lastT = 0;
  for (const r of rows) {
    const t = Date.parse(r.t) || 0;
    if (t && t - lastT < 20e3) continue;
    const e = ent.get(r.id);
    if (!e) continue;
    // カメラの中のJPEG（embedded）はレタッチ前なので使わない
    const py = pyr.get(e.uuid, e.digest);
    if (!py || py.quality === "embedded") continue;
    const dir = path.join(PREV, e.uuid[0], e.uuid.slice(0, 4));
    if (!fs.existsSync(dir)) continue;
    const sizes = fs.readdirSync(dir).filter((f) => f.startsWith(`${e.uuid}-${e.digest}_`)).map((f) => ({ f, n: +f.split("_").pop() })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n);
    if (!sizes.length) continue;
    const raw = fs.readFileSync(path.join(dir, sizes[0].f));
    const jpg = raw[0] === 0xff && raw[1] === 0xd8 ? raw : biggestJpeg(raw);
    if (!jpg) continue;
    try {
      const m = await sharp(jpg).metadata();
      if (Math.max(m.width, m.height) < 1400) continue; // 小さすぎるプレビューは使わない
      // プレビューは回転前のまま入っているので、カタログの向きで回す（AB=そのまま／BC=右90°／CD=180°／DA=左90°）
      const ang = { AB: 0, BC: 90, CD: 180, DA: 270 }[r.o] || 0;
      const fixed = ang ? await sharp(jpg).rotate(ang).jpeg({ quality: 95 }).toBuffer() : jpg;
      fs.writeFileSync(path.join(OUT, `${r.id}.jpg`), fixed);
      await sharp(fixed).resize(512, 512, { fit: "inside" }).jpeg({ quality: 70 }).toFile(path.join(OUT, "thumbs", `${r.id}.jpg`));
      list.push({ id: r.id, t: r.t, name: r.name, dir: r.dir, w: ang % 180 ? m.height : m.width, h: ang % 180 ? m.width : m.height, star: r.r === 5 });
      lastT = t;
    } catch {}
  }
  fs.writeFileSync(path.join(OUT, "list.json"), JSON.stringify(list, null, 1));
  console.log(`集めた写真 ${list.length}枚（候補 ${rows.length}枚から、連写の重なりと小さいプレビューを除く）`);
})();
