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
       where (${process.argv.includes('--all') ? '1 = 1' : "(i.rating = 5 or i.pick = 1 or d.text like '%Highlights2012 = -%')"}) and fo.pathFromRoot not like '%スクールフォト%' and coalesce(i.pick, 0) >= 0 and lower(f.extension) in ('cr3', 'cr2', 'arw', 'dng', 'jpg', 'jpeg')
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
  // 現像後のプレビューがない写真は、カメラが一緒に保存した JPEG（同じ撮影時刻）を使う（現像前。過去の写真も候補にするため）
  const camJpeg = db.prepare(
    `select r.absolutePath || fo.pathFromRoot || f.baseName || '.' || f.extension p from Adobe_images i join AgLibraryFile f on f.id_local = i.rootFile join AgLibraryFolder fo on fo.id_local = f.folder join AgLibraryRootFolder r on r.id_local = fo.rootFolder where i.captureTime = ? and lower(f.extension) in ('jpg', 'jpeg')`
  );
  for (const r of rows) {
    const t = Date.parse(r.t) || 0;
    if (t && t - lastT < 20e3) continue;
    if (fs.existsSync(path.join(OUT, `${r.id}.jpg`)) && fs.existsSync(path.join(OUT, "thumbs", `${r.id}.jpg`))) {
      // 前に取り出した写真はそのまま（毎回作り直さない）
      const m = await sharp(path.join(OUT, `${r.id}.jpg`)).metadata();
      list.push({ id: r.id, t: r.t, name: r.name, dir: r.dir, w: m.width, h: m.height, star: r.r === 5 });
      lastT = t;
      continue;
    }
    const e = ent.get(r.id);
    let jpg = null;
    let ang = { AB: 0, BC: 90, CD: 180, DA: 270 }[r.o] || 0;
    let unedited = false;
    // カメラの中のJPEG（embedded）はレタッチ前なので、プレビューとしては使わない
    const py = e && pyr.get(e.uuid, e.digest);
    const dir = e && path.join(PREV, e.uuid[0], e.uuid.slice(0, 4));
    if (py && py.quality !== "embedded" && fs.existsSync(dir)) {
      const sizes = fs.readdirSync(dir).filter((f) => f.startsWith(`${e.uuid}-${e.digest}_`)).map((f) => ({ f, n: +f.split("_").pop() })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n);
      if (sizes.length) {
        const raw = fs.readFileSync(path.join(dir, sizes[0].f));
        jpg = raw[0] === 0xff && raw[1] === 0xd8 ? raw : biggestJpeg(raw);
      }
    }
    if (!jpg && (process.argv.includes("--wide") || process.argv.includes("--all"))) {
      const c = camJpeg.all(r.t).map((x) => x.p).find((p) => fs.existsSync(p));
      if (c) {
        jpg = await sharp(c).rotate().resize({ width: 2560, height: 2560, fit: "inside" }).jpeg({ quality: 93 }).toBuffer();
        ang = 0; // カメラの JPEG は向きの情報で回してある
        unedited = true;
      }
    }
    if (!jpg) continue;
    try {
      const m = await sharp(jpg).metadata();
      if (Math.max(m.width, m.height) < 1400) continue; // 小さすぎるプレビューは使わない
      // プレビューは回転前のまま入っているので、カタログの向きで回す（AB=そのまま／BC=右90°／CD=180°／DA=左90°）
      const fixed = ang ? await sharp(jpg).rotate(ang).jpeg({ quality: 95 }).toBuffer() : jpg;
      fs.writeFileSync(path.join(OUT, `${r.id}.jpg`), fixed);
      await sharp(fixed).resize(512, 512, { fit: "inside" }).jpeg({ quality: 70 }).toFile(path.join(OUT, "thumbs", `${r.id}.jpg`));
      list.push({ id: r.id, t: r.t, name: r.name, dir: r.dir, w: ang % 180 ? m.height : m.width, h: ang % 180 ? m.width : m.height, star: r.r === 5, unedited });
      lastT = t;
    } catch {}
  }
  fs.writeFileSync(path.join(OUT, "list.json"), JSON.stringify(list, null, 1));
  console.log(`集めた写真 ${list.length}枚（候補 ${rows.length}枚から、連写の重なりと小さいプレビューを除く）`);
})();
