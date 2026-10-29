// リールの予約（plan.js から毎朝）：毎週 水・土 の 19:00 に、同じ日に撮った写真8〜10枚の「ビートに合わせて切り替わる」動画
//   ・動画はクラウド（post.js）が作る。曲はインスタのアプリで付けて自分で投稿する（manual）。曲の候補とテンポは lib/reel-songs.js
//   ・見送りの写真を優先して使う（フィードに出ない写真の出番にもなる）。足りなければ予約中の写真も
//   ・一度リールにした日付は使わない
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { buildCaption } = require("./caption");
const { pickSongs, moodsFor } = require("./reel-songs");

const DAYS = [3, 6]; // 水・土
const TIME = "19:00";
const AHEAD = 4;
const PER = 10;
const MIN = 6;

const ymd = (d) => d.toISOString().slice(0, 10);
const jstToday = () => ymd(new Date(Date.now() + 9 * 3600e3));
const addDays = (day, n) => ymd(new Date(Date.parse(day + "T00:00:00Z") + n * 864e5));

function planReels({ root, queue, pool, specials, posted, cfg }) {
  const today = jstToday();
  const add = [];
  const files = [];
  const usedDates = new Set([...specials, ...posted].filter((x) => x.kind === "reel" && x.sourceDate).map((x) => x.sourceDate));
  for (let k = 0; k <= AHEAD; k++) {
    const day = addDays(today, k);
    const dow = new Date(day + "T00:00:00Z").getUTCDay();
    if (!DAYS.includes(dow)) continue;
    const id = `reel-${day}`;
    if (specials.some((s) => s.id === id) || posted.some((p) => p.id === id)) continue;
    // 同じ日付の写真をまとめる（見送りを先に）
    const groups = new Map();
    for (const [src, list] of [["pool", pool], ["queue", queue]])
      for (const x of list) {
        if (!x.date || usedDates.has(x.date) || x.images?.length > 1) continue;
        if (!groups.has(x.date)) groups.set(x.date, []);
        groups.get(x.date).push({ ...x, _src: src });
      }
    // 新しく撮った日を優先（季節やイベントに合いやすい）
    const best = [...groups.entries()].filter(([, g]) => g.length >= MIN).sort((a, b) => b[0].localeCompare(a[0]))[0];
    if (!best) continue;
    const [date, g] = best;
    // 点数の高い写真から（点数がなければ予約中＞見送り）。並びは撮った順
    g.sort((a, b) => (b.score ?? (b._src === "queue" ? 7 : 6)) - (a.score ?? (a._src === "queue" ? 7 : 6)));
    const chosen = g.slice(0, PER).sort((a, b) => String(a.takenAt).localeCompare(String(b.takenAt)));
    // 1枚目（タイトルを重ねる）は一番点数の高い写真
    const top = [...chosen].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    chosen.splice(chosen.indexOf(top), 1);
    chosen.unshift(top);
    const dir = `specials/${id}`;
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    const images = [];
    for (const [i, x] of chosen.entries()) {
      const rel = `${dir}/${i + 1}.jpg`;
      // Windows では fd に直接書くと空のファイルになることがあるので、いったん受け取ってから書く
      fs.writeFileSync(path.join(root, rel), execFileSync("git", ["show", `origin/main:${x.image || x.images[0]}`], { cwd: root, maxBuffer: 1 << 28 }));
      images.push(rel);
    }
    fs.writeFileSync(path.join(root, dir, "thumb.jpg"), execFileSync("git", ["show", `origin/main:${chosen[0].thumb || chosen[0].image || chosen[0].images[0]}`], { cwd: root, maxBuffer: 1 << 28 }));
    files.push(...images, `${dir}/thumb.jpg`);
    const first = chosen.find((x) => x.line) || chosen[0];
    const songs = pickSongs({ moods: moodsFor({ date, takenAt: first.takenAt, title: first.event || first.locationName }), measured: cfg.reelBpm || {} });
    const head = (first.caption || "").includes("東京フォトウォークサークル") ? first.caption.split("\n\n")[0] : "";
    add.push({
      id,
      kind: "reel",
      sourceDate: date,
      title: `リール：${+date.slice(5, 7)}/${+date.slice(8, 10)}の${first.locationName || "写真"}（${images.length}枚）`,
      postAt: `${day}T${TIME}:00+09:00`,
      images,
      thumb: `${dir}/thumb.jpg`,
      caption: buildCaption({ head, base: chosen.filter((x) => x.portrait).length > chosen.length / 2 ? cfg.hashtags.portrait : cfg.hashtags.default, extra: [first.locationName ? `#${first.locationName}` : null].filter(Boolean) }),
      head,
      portrait: chosen.filter((x) => x.portrait).length > chosen.length / 2,
      locationName: first.locationName || null,
      skipped: false,
      // 動画づくりの設定（アプリで変えられる）
      manual: cfg.reelManual !== false,
      reelTitle: (first.event ? first.event.replace(/^vol.d+s*/, "") : first.locationName) || "TOKYO",
      reelSub: date.replace(/-/g, "."),
      songs,
      bpm: songs.find((x) => x.bpm)?.bpm || 100,
      rebuild: true,
    });
    usedDates.add(date);
    console.log(`  ✓ リール予約 ${day} ${TIME}  ${date}の写真${images.length}枚`);
  }
  return { add, files };
}

module.exports = { planReels };
