// lr-reels.js — Lightroom Classic の写真（人なし・AIの点数つき）からテーマごとのリールを作って予約する
//   node lr-reels.js [本数=5]
//   写真は .work/lrpick（lr-pick.js → lr-ai-pick.js）。予約は 水・土 の空いている 19:00 に入れる
//   動画はこのPCの After Effects が作る（reel-pc.js が10分以内に）
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { execFileSync } = require("child_process");
const { makeSync } = require("./lib/sync");
const { buildCaption } = require("./lib/caption");
const { pickSongs } = require("./lib/reel-songs");
sharp.cache(false);

const ROOT = __dirname;
const DIR = path.join(ROOT, ".work", "lrpick");
const COUNT = +process.argv.find((a) => /^[0-9]+$/.test(a)) || 5;
const REPLACE = process.argv.includes("--replace"); // Lightroom から作ったまだ投稿していないリールを作り直す
const { spawn } = require("child_process");

// AI（いちばん賢いモデル）がテーマごとに選び直す：人がまったく写っていない・テーマに合う・似た写真は1枚・流れのある順番
function curate(theme, cands, session = false) {
  const lines = cands.map((x) => `- thumbs/${x.id}.jpg`).join("\n");
  const prompt = `カレントフォルダの次の写真を Read ツールで全部見てください。写真家のインスタのリール（縦の動画・写真を曲に合わせて切り替える）を1本作ります。テーマは「${theme}」の候補です。

${lines}

次の条件で 14〜18枚を選び、見せる順番に並べてください（曲に合わせて1枚0.5秒ほどで切り替える写真まとめの動画です）:
- 人が1人でも写っている写真は入れない（小さな人影・後ろ姿・お面やコスプレの人も含めて、人の姿が分かるものは全部なし）
- ${session ? "同じ日・同じ場所で撮った写真です。時間の流れ（夕方→夜など）や歩いた順に、ストーリーのある並びにする" : "テーマに合わない写真は入れない（迷ったら入れない）"}
- 色味・雰囲気がそろうこと（1本の作品に見えるように）。色味や雰囲気が浮く写真は入れない
- ほぼ同じ構図・同じ場面の写真は1枚だけ
- 1枚目は、いちばん指が止まる強い写真
- 並びは、明るさ・色・寄り引きに流れがあるように（似た写真が続かない）
条件に合う写真が14枚に満たなければ、ある分だけ。

つかみの一言（最初の1秒に大きく出す文字）も1つ。短く自然に、写真好きが思わずコメントしたくなる問いかけ（例「東京タワー、何枚目が好き？」）。AIっぽい言い回し・絵文字は使わない。
ハッシュタグを1つ（このテーマで人気のもの）。

出力は次のJSONだけ:
{"ids":["123","456"],"hook":"…","tag":"#…","theme":"短いテーマ名"}`;
  return new Promise((resolve, reject) => {
    const p = spawn("claude", ["-p", "--allowedTools", "Read", "--output-format", "json", "--model", "opus"], { cwd: DIR, shell: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => {
      try {
        resolve(JSON.parse(JSON.parse(out).result.match(/\{[\s\S]*\}/)[0]));
      } catch (e) {
        reject(new Error("AIの選び直しに失敗: " + out.slice(0, 200)));
      }
    });
    p.stdin.end(prompt);
  });
}
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const remote = (f, d) => {
  try {
    return JSON.parse(execFileSync("git", ["show", `origin/main:${f}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 }));
  } catch {
    return d;
  }
};
// テーマごとのつかみの一言・ハッシュタグ・曲の雰囲気
const THEME = {
  "ネオン・看板": { hook: "ネオンの東京、何枚目が好き？", tag: "#ネオン", mood: ["night"] },
  東京タワー: { hook: "東京タワー、何枚目が好き？", tag: "#東京タワー", mood: ["night", "emo"] },
  "夜景・ビル": { hook: "東京の夜、何枚目が好き？", tag: "#東京夜景", mood: ["night", "chill"] },
  "電車・線路・駅": { hook: "電車のある風景、何枚目が好き？", tag: "#電車のある風景", mood: ["emo", "chill"] },
  "夕焼け・マジックアワー": { hook: "東京の夕暮れ、何枚目が好き？", tag: "#マジックアワー", mood: ["emo"] },
  "雨・反射": { hook: "雨の東京、何枚目が好き？", tag: "#雨の日", mood: ["chill", "night"] },
  "路地・横丁": { hook: "路地裏、何枚目が好き？", tag: "#路地裏", mood: ["night", "emo"] },
  "神社・和": { hook: "和の景色、何枚目が好き？", tag: "#和の景色", mood: ["chill", "day"] },
  "花・植物": { hook: "花のある景色、何枚目が好き？", tag: "#花のある風景", mood: ["day", "emo"] },
  "海・水辺": { hook: "水辺の景色、何枚目が好き？", tag: "#水辺", mood: ["chill", "day"] },
  "空・雲": { hook: "空のある風景、何枚目が好き？", tag: "#空のある風景", mood: ["day", "emo"] },
  "車・道路": { hook: "東京の道、何枚目が好き？", tag: "#東京の夜", mood: ["night"] },
  "建物・建築": { hook: "建物の写真、何枚目が好き？", tag: "#建築写真", mood: ["day", "chill"] },
};

(async () => {
  execFileSync("git", ["fetch", "-q", "origin", "main"], { cwd: ROOT });
  const judged = Object.values(JSON.parse(fs.readFileSync(path.join(DIR, "judged.json"), "utf8")));
  const all0 = remote("specials.json", []);
  const mine = (x) => x.kind === "reel" && (x.sources || [])[0]?.startsWith("lr:");
  const dropped = REPLACE ? all0.filter(mine) : [];
  const specials = all0.filter((x) => !dropped.includes(x));
  const posted = remote("posted.json", []);
  const used = new Set([...specials, ...posted].filter((x) => x.kind === "reel").flatMap((x) => x.sources || []));
  const ok = judged.filter((x) => !x.people && x.score >= 7 && !used.has(`lr:${x.id}`)).sort((a, b) => b.score - a.score);
  // テーマの束（7枚以上）→ 点数の高い順
  const groups = {};
  for (const x of ok) (groups[x.theme] = groups[x.theme] || []).push(x);
  // 同じ日の撮影（同じ場所・同じ光で色味がそろい、撮った順でストーリーになる）。6点以上・人なし・12枚以上
  const usedDays = new Set([...specials, ...posted].filter((x) => x.kind === "reel" && x.sourceDate).map((x) => x.sourceDate)); // ほかのリールで使った日（10/31のハロウィンなど）
  const byDay = {};
  for (const x of judged.filter((x) => !x.people && x.score >= 6 && !used.has(`lr:${x.id}`))) (byDay[String(x.t).slice(0, 10)] = byDay[String(x.t).slice(0, 10)] || []).push(x);
  const sessions = Object.entries(byDay)
    .filter(([d, g]) => g.length >= 12 && !usedDays.has(d))
    .map(([d, g]) => [d, g.sort((a, b) => String(a.t).localeCompare(String(b.t)))])
    .sort((a, b) => b[1].reduce((s, x) => s + x.score, 0) / b[1].length - a[1].reduce((s, x) => s + x.score, 0) / a[1].length);
  console.log("同じ日の撮影：" + sessions.map(([d, g]) => `${d}（${g.length}枚）`).join("・"));
  const themes = Object.entries(groups)
    .filter(([t, g]) => THEME[t] && g.length >= 12)
    .sort((a, b) => b[1].slice(0, 8).reduce((s, x) => s + x.score, 0) - a[1].slice(0, 8).reduce((s, x) => s + x.score, 0));
  // 空いている 水・土 19:00
  const taken = new Set([...specials, ...posted].filter((x) => x.kind === "reel").map((x) => x.postAt.slice(0, 10)));
  const slots = [];
  for (let d = 1; slots.length < COUNT && d < 60; d++) {
    const day = new Date(Date.now() + 9 * 3600e3 + d * 864e5).toISOString().slice(0, 10);
    if ([3, 6].includes(new Date(day + "T00:00:00Z").getUTCDay()) && !taken.has(day)) slots.push(day);
  }
  const add = [];
  const files = [];
  // 「撮影データ」の回も1本（点数が高く、データのある写真から）
  const plans = [];
  const usedIds = new Set();
  for (const [d, g] of sessions) {
    if (plans.length >= COUNT - 1) break;
    try {
      const cands = g.slice(0, 40);
      const top = (k) => Object.entries(cands.reduce((m, x) => ((m[x[k]] = (m[x[k]] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1])[0]?.[0];
      const r = await curate(`${d} の撮影（${top("place") || top("theme")}）`, cands, true);
      const items = r.ids.map((id) => cands.find((x) => String(x.id) === String(id))).filter(Boolean);
      if (items.length < 12) {
        console.log(`  （${d}：条件に合う写真が${items.length}枚だけなので見送り）`);
        continue;
      }
      for (const x of items) usedIds.add(x.id);
      plans.push({ format: "dump", theme: THEME[top("theme")] ? top("theme") : "夜景・ビル", items, pool: cands, hook: r.hook, tag: r.tag, label: r.theme, place: top("place") });
      console.log(`  AI：${d} → ${items.length}枚（${r.theme}）`);
    } catch (e) {
      console.log("  ⚠ " + e.message);
    }
  }
  for (const [t, g0] of themes) {
    const g = g0.filter((x) => !usedIds.has(x.id));
    if (plans.length >= COUNT - 1) break;
    try {
      const r = await curate(t, g.slice(0, 36));
      const items = r.ids.map((id) => g.find((x) => String(x.id) === String(id))).filter(Boolean);
      if (items.length < 12) {
        console.log(`  （${t}：条件に合う写真が${items.length}枚だけなので見送り）`);
        continue;
      }
      plans.push({ format: "dump", theme: t, items, pool: g, hook: r.hook, tag: r.tag, label: r.theme });
      console.log(`  AI：${t} → ${items.length}枚「${r.hook}」`);
    } catch (e) {
      console.log("  ⚠ " + e.message);
    }
  }
  const shotCands = ok.filter((x) => x.shot && x.tone === "dark" && !plans.some((p) => p.items.includes(x))).slice(0, 24);
  if (shotCands.length >= 8 && plans.length < COUNT) {
    try {
      const r = await curate("夜の写真（撮影データを1枚ずつ見せる回）", shotCands);
      const items = r.ids.map((id) => shotCands.find((x) => String(x.id) === String(id))).filter(Boolean);
      if (items.length >= 6) plans.push({ format: "settings", theme: "夜景・ビル", items, hook: "この夜、この設定で撮ってます", tag: r.tag });
    } catch (e) {
      console.log("  ⚠ " + e.message);
    }
  }
  for (const [n, plan] of plans.entries()) {
    const day = slots[n];
    if (!day) break;
    const id = `reel-${day}`;
    const dir = `specials/${id}`;
    fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
    // 並べ方：いちばん点数の高い写真を1枚目（つかみ）に、あとは暗い・明るいが続かないように
    const items = [...plan.items];
    const images = [];
    for (const [i, x] of items.entries()) {
      const rel = `${dir}/${i + 1}.jpg`;
      await sharp(path.join(DIR, `${x.id}.jpg`)).rotate().resize({ width: 2560, height: 2560, fit: "inside" }).jpeg({ quality: 90 }).toFile(path.join(ROOT, rel));
      images.push(rel);
    }
    // 差し替え候補（同じ束で選ばれなかった写真）も置いておく（iPhoneの音ハメ画面で入れ替えられるように）
    const cands = [];
    for (const [j, x] of (plan.pool || []).filter((y) => !items.includes(y)).slice(0, 12).entries()) {
      const rel = `${dir}/c${j + 1}.jpg`;
      await sharp(path.join(DIR, `${x.id}.jpg`)).rotate().resize({ width: 2560, height: 2560, fit: "inside" }).jpeg({ quality: 88 }).toFile(path.join(ROOT, rel));
      cands.push(rel);
    }
    files.push(...cands);
    fs.copyFileSync(path.join(ROOT, images[0]), path.join(ROOT, dir, "thumb.jpg"));
    files.push(...images, `${dir}/thumb.jpg`);
    const th = THEME[plan.theme];
    const songs = pickSongs({ moods: th.mood, measured: cfg.reelBpm || {} });
    const place = plan.items.map((x) => x.place).filter(Boolean)[0] || null;
    add.push({
      id,
      kind: "reel",
      format: plan.format,
      style: plan.format === "dump" ? "oto" : "mv",
      title: `リール（${plan.format === "settings" ? "撮影データ" : plan.label || plan.theme}）`,
      postAt: `${day}T19:00:00+09:00`,
      images,
      thumb: `${dir}/thumb.jpg`,
      cands,
      shots: items.map((x) => x.shot || null),
      places: items.map((x) => x.place || null),
      sources: items.map((x) => `lr:${x.id}`),
      hook: plan.hook || th.hook,
      reelSub: "HAYATO NAOE",
      answer: null,
      caption: `${plan.format === "settings" ? "保存して、撮るときの参考にどうぞ📷" : "何枚目が好きか、コメントで教えてください📷"}\n\n${buildCaption({ head: "", base: cfg.hashtags.default, extra: [plan.tag || th.tag] })}`,
      head: "",
      portrait: false,
      locationName: place,
      skipped: false,
      manual: true,
      songs,
      bpm: songs.find((x) => x.bpm)?.bpm || 100,
      rebuild: true,
      rebuildAt: new Date().toISOString(),
    });
    console.log(`  ✓ ${day} 19:00  ${plan.format === "settings" ? "撮影データ" : plan.theme}（${images.length}枚）「${add[add.length - 1].hook}」 曲: ${songs.map((s) => s.t).join(" / ")}`);
  }
  if (!add.length) return console.log("作れるテーマがありませんでした");
  makeSync(ROOT)(`リール：Lightroom の写真からテーマ別に +${add.length}`, files, (rm) => {
    const cur = rm("specials.json", []).filter((x) => !dropped.some((d) => d.id === x.id));
    for (const a of add) if (!cur.some((x) => x.id === a.id)) cur.push(a);
    cur.sort((a, b) => a.postAt.localeCompare(b.postAt));
    const out = { "specials.json": cur };
    for (const d of dropped) for (const f of [...(d.images || []), d.thumb, d.video, d.cover].filter(Boolean)) if (!files.includes(f)) out[f] = null;
    return out;
  });
  console.log(`✅ ${add.length}本を予約しました（動画は10分以内にPCの After Effects が作ります）`);
})().catch((e) => {
  console.error("エラー: " + e.message);
  process.exit(1);
});
