// フォトウォークのフライヤー投稿を予約する（plan.js から毎朝呼ばれる）
//   ・開催の2週間前の夜（リーチが伸びやすい21:00）に、普段の投稿ペースとは別枠で1回
//   ・複数枚投稿：1枚目=サイトのフライヤー画像、2枚目以降=過去の回の写真（参加者の様子→作例→カフェ交流）
//   ・キャプション＝サイトの投稿文（tpw-site の build.mjs の instagramText）と同じ
//   ・すでにインスタに同じ回の告知が出ていたら作らない（手で投稿した回と二重にならないように）
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
sharp.cache(false);

const POST_TIME = "21:00"; // 夜はインスタを見る人が一番多い時間帯
const LEAD_DAYS = 14; // 何日前に告知するか
const MIN_DAYS = 3; // 開催まで3日を切っていたらもう告知しない
const CREATE_AHEAD_DAYS = 4; // 投稿予定日の何日前に予約を作るか（直前にサイトの文言が直っても反映されるように）

const pad = (n) => String(n).padStart(2, "0");
const jstNow = () => new Date(Date.now() + 9 * 3600e3);
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (day, n) => ymd(new Date(Date.parse(day + "T00:00:00Z") + n * 864e5));

// 過去の回の写真から、雰囲気が伝わる順に選ぶ（回ごとに違う組み合わせになるよう、開催日で回す）
function pickPastPhotos(tpwDir, seed, exceptDate) {
  const dir = path.join(tpwDir, "data", "logs");
  const all = [];
  for (const f of fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
    const l = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const p of l.photos || []) if (fs.existsSync(path.join(tpwDir, p.src)) && l.date !== exceptDate) all.push({ ...p, date: l.date });
  }
  const isCafe = (p) => /カフェ|交流|見せ合|乾杯/.test(p.alt);
  const isPeople = (p) => /参加者|構える|撮影する|集合/.test(p.alt) && !isCafe(p);
  let n = 0;
  for (const c of seed) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  const rot = (arr) => (arr.length ? [...arr.slice(n % arr.length), ...arr.slice(0, n % arr.length)] : arr);
  const out = [];
  const used = new Set();
  const take = (list, k) => {
    for (const p of rot(list)) {
      if (out.length >= 7 || k <= 0) break;
      if (used.has(p.date)) continue; // なるべく違う回から
      out.push(p);
      used.add(p.date);
      k--;
    }
  };
  take(all.filter(isPeople), 2);
  take(all.filter((p) => !isPeople(p) && !isCafe(p)), 3);
  take(all.filter(isCafe), 1);
  return out;
}

// 4:5（1440×1800）に揃える。横長の写真は大事な所を残して切る
async function to45(src, dest) {
  await sharp(fs.readFileSync(src))
    .rotate()
    .resize(1440, 1800, { fit: "cover", position: sharp.strategy.attention, withoutEnlargement: false })
    .toColorspace("srgb")
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toFile(dest);
}

// インスタに同じ回の告知がもう出ているか（キャプションの1行目にタイトルが入っている）
async function alreadyOnInstagram(igUserId, token, title) {
  if (!token) return false;
  try {
    const r = await fetch(`https://graph.facebook.com/v26.0/${igUserId}/media?fields=caption&limit=50&access_token=${token}`);
    const j = await r.json();
    return (j.data || []).some((m) => (m.caption || "").split("\n")[0].includes(title));
  } catch {
    return false;
  }
}

// 予約を作る。戻り値: { add: [新しい予約], files: [画像パス] }
async function planFlyers({ root, tpwDir, specials, postedIds, secrets, eventPlaceName }) {
  const { build, instagramText } = await import("file:///" + path.join(tpwDir, "scripts", "build.mjs").replace(/\\/g, "/"));
  const { events } = build({ write: false });
  const now = jstNow();
  const today = ymd(now);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const taken = new Set(specials.filter((s) => s.kind === "flyer").map((s) => s.postAt.slice(0, 10)));
  const add = [];
  const files = [];
  const upcoming = events
    .filter((e) => !e.ended && e.status !== "cancelled" && e.flyer && e.date >= addDays(today, MIN_DAYS))
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const e of upcoming) {
    const id = `flyer-${e.date}`;
    if (specials.some((s) => s.id === id) || postedIds.has(id)) continue;
    // 投稿日：2週間前の21:00。もう過ぎていたら次の21:00。フライヤー同士は同じ日に重ねない
    let day = addDays(e.date, -LEAD_DAYS);
    const late = nowMin > 20 * 60 + 30 ? addDays(today, 1) : today;
    if (day < late) day = late;
    while (taken.has(day)) day = addDays(day, 1);
    if (day > addDays(e.date, -MIN_DAYS)) continue;
    if (day > addDays(today, CREATE_AHEAD_DAYS)) continue; // まだ先 → 近くなったら作る
    if (await alreadyOnInstagram(secrets.igUserId, secrets.igToken, e.title)) {
      console.log(`  フライヤー ${e.date} ${e.title}: インスタに告知済みなので作りません`);
      continue;
    }
    const dir = `specials/${id}`;
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    const images = [];
    await to45(path.join(tpwDir, e.flyer), path.join(root, dir, "1.jpg"));
    images.push(`${dir}/1.jpg`);
    const past = pickPastPhotos(tpwDir, e.date, e.date);
    for (const [i, p] of past.entries()) {
      const f = `${dir}/${i + 2}.jpg`;
      await to45(path.join(tpwDir, p.src), path.join(root, f));
      images.push(f);
    }
    await sharp(fs.readFileSync(path.join(root, images[0]))).resize({ width: 480 }).jpeg({ quality: 78 }).toFile(path.join(root, dir, "thumb.jpg"));
    files.push(...images, `${dir}/thumb.jpg`);
    taken.add(day);
    add.push({
      id,
      kind: "flyer",
      eventDate: e.date,
      title: e.title,
      postAt: `${day}T${POST_TIME}:00+09:00`,
      images,
      thumb: `${dir}/thumb.jpg`,
      caption: instagramText(e),
      locationName: eventPlaceName(e),
      past: past.map((p) => p.alt),
      skipped: false,
    });
    console.log(`  ✓ フライヤー予約 ${day} ${POST_TIME}  ${e.title}（開催 ${e.date}・${images.length}枚）`);
  }
  return { add, files };
}

module.exports = { planFlyers, POST_TIME };
