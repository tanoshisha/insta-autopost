// リールの予約（plan.js から毎朝）：毎週 水・土 の 19:00。最新の投稿に関係なく「いちばん伸びそうなリール」を作る
//   形式を順番に回す：
//     dump     … これまでの投稿で反応が良かった写真（いいね順）9枚。つかみ「〇〇、何枚目が好き？」→ コメントが増える
//     settings … 撮影データのある写真8枚。1枚ずつ「85mm f/1.8 1/125s ISO3200」→ 保存・シェアされやすい
//     quiz     … 同じ場所の写真7枚。ぼかした1枚目に「ここ、どこか分かる？」→ 最後に答え → コメント・見返し
//   写真：インスタの投稿は高画質（2049×2564）で取り直す。予約・見送りの写真は投稿用の画像を使う
//   動画はクラウド（post.js）が lib/reel.js で作る。曲はインスタのアプリで付けて自分で投稿する（manual）
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { execFileSync } = require("child_process");
const { buildCaption } = require("./caption");
const { pickSongs, moodsFor } = require("./reel-songs");

const DAYS = [3, 6]; // 水・土
const TIME = "19:00";
const AHEAD = 4;
const FORMATS = ["dump", "settings", "quiz"];
const G = "https://graph.facebook.com/v21.0";

const ymd = (d) => d.toISOString().slice(0, 10);
const jstToday = () => ymd(new Date(Date.now() + 9 * 3600e3));
const addDays = (day, n) => ymd(new Date(Date.parse(day + "T00:00:00Z") + n * 864e5));

// インスタの全投稿（いいね数つき）。フライヤー・告知は除く
async function igMedia(igUserId, token) {
  const out = [];
  let url = `${G}/${igUserId}/media?fields=id,caption,media_type,media_url,like_count,timestamp,children{media_url,media_type}&limit=100&access_token=${token}`;
  for (let i = 0; i < 8 && url; i++) {
    const j = await fetch(url).then((r) => r.json());
    out.push(...(j.data || []));
    url = j.paging?.next;
  }
  return out
    .filter((m) => !/｜東京フォトウォークサークル|開催|参加者募集|予約/.test((m.caption || "").split("\n")[0]))
    .map((m) => {
      const img = m.media_type === "IMAGE" ? m.media_url : m.media_type === "CAROUSEL_ALBUM" ? m.children?.data?.find((c) => c.media_type === "IMAGE")?.media_url : null;
      return img ? { id: m.id, img, likes: m.like_count || 0, head: (m.caption || "").split(/\n/)[0].replace(/[⁡]/g, "").trim() } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.likes - a.likes);
}

async function save(buf, file) {
  await sharp(buf).rotate().resize({ width: 2560, height: 2560, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toFile(file);
}
const lum = async (file) => {
  const s = await sharp(file).stats();
  return 0.299 * s.channels[0].mean + 0.587 * s.channels[1].mean + 0.114 * s.channels[2].mean;
};
const gitBuf = (root, p) => execFileSync("git", ["show", `origin/main:${p}`], { cwd: root, maxBuffer: 1 << 28 });

async function planReels({ root, queue, pool, specials, posted, cfg, secrets }) {
  const today = jstToday();
  const add = [];
  const files = [];
  const reels = [...posted, ...specials].filter((x) => x.kind === "reel");
  const used = new Set(reels.flatMap((x) => x.sources || []));
  let media = null;
  let n = reels.filter((x) => x.format).length;
  for (let k = 0; k <= AHEAD; k++) {
    const day = addDays(today, k);
    if (!DAYS.includes(new Date(day + "T00:00:00Z").getUTCDay())) continue;
    const id = `reel-${day}`;
    if (specials.some((s) => s.id === id) || posted.some((p) => p.id === id)) continue;
    const dir = `specials/${id}`;
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    let plan = null;
    for (let tries = 0; tries < FORMATS.length && !plan; tries++) {
      const format = FORMATS[(n + tries) % FORMATS.length];
      if (format === "dump") {
        if (!media) media = secrets?.igToken ? await igMedia(secrets.igUserId, secrets.igToken).catch(() => []) : [];
        const pick = media.filter((m) => !used.has(`ig:${m.id}`)).slice(0, 9);
        if (pick.length < 7) continue;
        const items = [];
        for (const [i, m] of pick.entries()) {
          const rel = `${dir}/${i + 1}.jpg`;
          await save(Buffer.from(await fetch(m.img).then((r) => r.arrayBuffer())), path.join(root, rel));
          items.push({ image: rel, src: `ig:${m.id}`, likes: m.likes });
        }
        // いちばん反応の良い1枚を最初に（つかみ）。夜の写真が多ければ「東京の夜」
        const lums = await Promise.all(items.map((x) => lum(path.join(root, x.image))));
        const dark = lums.filter((v) => v < 95).length >= items.length / 2;
        // 1枚目（つかみ）は、いいねの多い夜の写真（夜景・ネオンの方が指が止まる）
        const fi = dark ? lums.findIndex((v) => v < 95) : 0;
        if (fi > 0) {
          const [a] = items.splice(fi, 1);
          items.unshift(a);
          items.forEach((x, i) => {
            const rel = `${dir}/${i + 1}.jpg`;
            if (x.image !== rel) fs.renameSync(path.join(root, x.image), path.join(root, rel + ".tmp")), (x.image = rel);
          });
          for (const x of items) if (fs.existsSync(path.join(root, x.image + ".tmp"))) fs.renameSync(path.join(root, x.image + ".tmp"), path.join(root, x.image));
        }
        plan = { format, items, hook: dark ? "東京の夜、何枚目が好き？" : "東京で撮った写真、何枚目が好き？", sub: "HAYATO NAOE", moods: dark ? ["night", "emo"] : ["day"], place: "東京" };
      } else {
        const all = [...queue, ...pool].filter((x) => !x.images?.length || x.images.length === 1).filter((x) => !used.has(`q:${x.id}`));
        let pick = [];
        let answer = null;
        if (format === "settings") {
          pick = all.filter((x) => x.shot).sort((a, b) => (b.score ?? 7) - (a.score ?? 7) || (a.lum ?? 0) - (b.lum ?? 0)).slice(0, 8);
          if (pick.length < 6) continue;
        } else {
          const groups = new Map();
          for (const x of all) if (x.locationName) groups.set(x.locationName, [...(groups.get(x.locationName) || []), x]);
          const best = [...groups.entries()].filter(([, g]) => g.length >= 6).sort((a, b) => b[1].length - a[1].length)[0];
          if (!best) continue;
          answer = best[0];
          pick = best[1].sort((a, b) => (b.score ?? 7) - (a.score ?? 7)).slice(0, 7);
        }
        const items = [];
        for (const [i, x] of pick.entries()) {
          const rel = `${dir}/${i + 1}.jpg`;
          await save(gitBuf(root, x.image || x.images[0]), path.join(root, rel));
          items.push({ image: rel, src: `q:${x.id}`, shot: x.shot || null, place: x.locationName || null, date: x.date });
        }
        const first = pick[0];
        const dark = (await Promise.all(items.map((x) => lum(path.join(root, x.image))))).filter((v) => v < 95).length >= items.length / 2;
        plan =
          format === "settings"
            ? { format, items, hook: dark ? "この夜、この設定で撮ってます" : "この写真、この設定で撮ってます", sub: "HAYATO NAOE", moods: moodsFor({ date: first.date, takenAt: first.takenAt }), place: first.locationName }
            : { format, items, hook: "ここ、どこか分かる？", answer, moods: moodsFor({ date: first.date, takenAt: first.takenAt }), place: answer };
      }
    }
    if (!plan) continue;
    n++;
    const images = plan.items.map((x) => x.image);
    fs.copyFileSync(path.join(root, images[0]), path.join(root, dir, "thumb.jpg"));
    files.push(...images, `${dir}/thumb.jpg`);
    for (const x of plan.items) used.add(x.src);
    const songs = pickSongs({ moods: plan.moods, measured: cfg.reelBpm || {} });
    const tags = buildCaption({ head: "", base: cfg.hashtags.default, extra: [plan.place ? `#${plan.place.replace(/\s+/g, "")}` : null].filter(Boolean) });
    // キャプションの1行目は、動画のつかみと同じ問いかけ（コメントのきっかけ）
    const ask = { dump: "何枚目が好きか、コメントで教えてください📷", settings: "保存して、撮るときの参考にどうぞ📷", quiz: "分かったらコメントで📷（答えは最後に）" }[plan.format];
    add.push({
      id,
      kind: "reel",
      format: plan.format,
      style: plan.format === "dump" ? "oto" : "mv", // 人気の写真は音ハメ、撮影データ・クイズはゆったりMV
      title: `リール（${{ dump: "人気の写真", settings: "撮影データ", quiz: "場所クイズ" }[plan.format]}）`,
      postAt: `${day}T${TIME}:00+09:00`,
      images,
      thumb: `${dir}/thumb.jpg`,
      shots: plan.items.map((x) => x.shot || null),
      places: plan.items.map((x) => x.place || null),
      sources: plan.items.map((x) => x.src),
      hook: plan.hook,
      reelSub: plan.sub || "",
      answer: plan.answer || null,
      caption: `${ask}\n\n${tags}`,
      head: "",
      portrait: false,
      locationName: plan.place || null,
      skipped: false,
      manual: cfg.reelManual !== false,
      songs,
      bpm: songs.find((x) => x.bpm)?.bpm || 100,
      rebuild: true,
    });
    console.log(`  ✓ リール予約 ${day} ${TIME}  ${plan.format}（${images.length}枚）「${plan.hook}」`);
  }
  return { add, files };
}

module.exports = { planReels };
