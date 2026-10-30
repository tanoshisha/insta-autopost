// make-own-ref.js — 本人が自分で選んで載せた投稿（2025/1/23〜2026/10/10）を「点数の基準の参考」として、AIに見せる一覧画像を作る
//   本人の指示（2026-10-31）：「おれの投稿は2026年10月10日～2025年1月23日が点数の参考になる」
//   .work/igposted（ig-posted-fetch.js で保存したインスタの写真）から、各投稿の1枚目を、反応（いいね）の多い順に並べて6×6の一覧に
//   → .work/own-ref/ref-1.jpg …（上の一覧ほど反応が大きかった投稿）と posts.json
//   node make-own-ref.js
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const ROOT = __dirname;
const OUT = path.join(ROOT, ".work", "own-ref");
const FROM = "2025-01-23", TO = "2026-10-11";
const s = require("./secrets.local.json");
const G = "https://graph.facebook.com/v21.0";

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // いいね数（投稿ごと）
  const likes = {};
  let url = `${G}/${s.igUserId}/media?fields=id,like_count,timestamp,media_type&limit=100&access_token=${s.igToken}`;
  while (url) {
    const r = await (await fetch(url)).json();
    if (r.error) throw new Error(r.error.message);
    for (const m of r.data) if (m.media_type !== "VIDEO") likes[m.id] = m.like_count ?? 0;
    url = r.paging?.next;
    if (r.data.length && r.data[r.data.length - 1].timestamp < FROM) break;
  }
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, ".work", "igposted", "list.json"), "utf8"));
  const posts = list
    .filter((x) => x.n === 1 && x.at >= FROM && x.at < TO && likes[x.post] != null)
    .map((x) => ({ ...x, likes: likes[x.post], file: path.join(ROOT, ".work", "igposted", `${x.id}.jpg`) }))
    .filter((x) => fs.existsSync(x.file))
    .sort((a, b) => b.likes - a.likes);
  fs.writeFileSync(path.join(OUT, "posts.json"), JSON.stringify(posts.map(({ file, ...p }) => p), null, 1));
  // 6×6 の一覧（1コマ 300px・いいね数を小さく入れる）
  const N = 6, CELL = 300, PAD = 6;
  const W = N * (CELL + PAD) + PAD;
  for (const f of fs.readdirSync(OUT)) if (/^ref-\d+\.jpg$/.test(f)) fs.rmSync(path.join(OUT, f));
  let sheet = 0;
  for (let i = 0; i < posts.length; i += N * N) {
    const part = posts.slice(i, i + N * N);
    const rows = Math.ceil(part.length / N);
    const H = rows * (CELL + PAD) + PAD;
    const comp = [];
    for (const [k, p] of part.entries()) {
      const img = await sharp(p.file).resize(CELL, CELL, { fit: "cover" }).toBuffer();
      const x = PAD + (k % N) * (CELL + PAD), y = PAD + Math.floor(k / N) * (CELL + PAD);
      comp.push({ input: img, left: x, top: y });
      comp.push({ input: Buffer.from(`<svg width="${CELL}" height="28"><rect width="${CELL}" height="28" fill="#000" fill-opacity="0.55"/><text x="6" y="20" font-size="16" font-family="Arial" fill="#fff">#${i + k + 1}  ♥${p.likes}  ${p.at.slice(0, 10)}</text></svg>`), left: x, top: y + CELL - 28 });
    }
    sheet++;
    await sharp({ create: { width: W, height: H, channels: 3, background: "#1a1a1a" } }).composite(comp).jpeg({ quality: 82 }).toFile(path.join(OUT, `ref-${sheet}.jpg`));
  }
  console.log(`参考の投稿 ${posts.length}件 → 一覧 ${sheet}枚（${OUT}）。いいね 最多${posts[0]?.likes}・中央値${posts[posts.length >> 1]?.likes}`);
})();
