// リールの予約（plan.js から毎朝）：毎週 水・土 の 19:00 に、同じ日に撮った写真6枚のスライドショー
//   ・見送りの写真を優先して使う（フィードに出ない写真の出番にもなる）。足りなければ予約中の写真も
//   ・一度リールにした日付は使わない
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { buildCaption } = require("./caption");

const DAYS = [3, 6]; // 水・土
const TIME = "19:00";
const AHEAD = 4;
const PER = 6;

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
    const best = [...groups.entries()].filter(([, g]) => g.length >= 5).sort((a, b) => b[0].localeCompare(a[0]))[0];
    if (!best) continue;
    const [date, g] = best;
    g.sort((a, b) => (a._src === b._src ? 0 : a._src === "pool" ? -1 : 1));
    const chosen = g.slice(0, PER).sort((a, b) => String(a.takenAt).localeCompare(String(b.takenAt)));
    const dir = `specials/${id}`;
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    const images = [];
    for (const [i, x] of chosen.entries()) {
      const rel = `${dir}/${i + 1}.jpg`;
      execFileSync("git", ["show", `origin/main:${x.image}`], { cwd: root, stdio: ["ignore", fs.openSync(path.join(root, rel), "w"), "pipe"] });
      images.push(rel);
    }
    execFileSync("git", ["show", `origin/main:${chosen[0].thumb || chosen[0].image}`], { cwd: root, stdio: ["ignore", fs.openSync(path.join(root, dir, "thumb.jpg"), "w"), "pipe"] });
    files.push(...images, `${dir}/thumb.jpg`);
    const first = chosen.find((x) => x.line) || chosen[0];
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
    });
    usedDates.add(date);
    console.log(`  ✓ リール予約 ${day} ${TIME}  ${date}の写真${images.length}枚`);
  }
  return { add, files };
}

module.exports = { planReels };
