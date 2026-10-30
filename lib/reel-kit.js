// リール用の写真セット（動画は作らない。本人が Edits で組む用）
//   縦 9:16（1080x1920）に切り抜き・メリハリのある色（vivid / vividNight）・使う順番の番号付き
//   layout: "side"（横位置を90°倒す）/ "frame"（白い紙に置く）にも対応
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { filmLook } = require("./film-look");
const W = 1080;
const H = 1920;

async function makeKit(items, kitDir, opts = {}) {
  fs.mkdirSync(kitDir, { recursive: true });
  // 前の写真（と iCloud の衝突コピー・前の完成動画）を消す
  for (const old of fs.readdirSync(kitDir)) if (/^\d+( ?\(\d+\))?\.jpg$/.test(old) || /^完成動画.*\.mp4$/.test(old)) fs.rmSync(path.join(kitDir, old), { force: true });
  // 色：最初の8枚の明るさで、夜（vividNight）か昼（vivid）か
  let look = opts.look || "auto";
  if (look === "auto") {
    const ls = [];
    for (const it of items.slice(0, 8)) {
      const st = await sharp(fs.readFileSync(it.src)).stats();
      ls.push(0.299 * st.channels[0].mean + 0.587 * st.channels[1].mean + 0.114 * st.channels[2].mean);
    }
    look = ls.filter((v) => v < 100).length >= ls.length / 2 ? "vividNight" : "vivid";
  }
  const out = [];
  for (const [i, it] of items.entries()) {
    let buf = await sharp(fs.readFileSync(it.src)).rotate().toBuffer();
    if (opts.layout === "side") {
      const m = await sharp(buf).metadata();
      if (m.width > m.height) buf = await sharp(buf).rotate(90).toBuffer();
    }
    const f = path.join(kitDir, `${String(i + 1).padStart(2, "0")}.jpg`);
    if (opts.layout === "frame") {
      const ph = await sharp(buf).resize(Math.round(W * 0.8), Math.round(H * 0.62), { fit: "inside" }).toBuffer();
      const g = await (await filmLook(ph, { look })).jpeg({ quality: 94 }).toBuffer();
      const gm = await sharp(g).metadata();
      await sharp({ create: { width: W, height: H, channels: 3, background: opts.frameColor || "#f4f2ee" } })
        .composite([{ input: g, left: Math.round((W - gm.width) / 2), top: Math.round((H - gm.height) / 2 - H * 0.02) }])
        .jpeg({ quality: 93 })
        .toFile(f);
    } else {
      const crop = await sharp(buf).resize(W, H, { fit: "cover", position: sharp.strategy.attention }).toBuffer();
      await (await filmLook(crop, { look })).jpeg({ quality: 93 }).toFile(f);
    }
    out.push(f);
  }
  return { files: out, look };
}
module.exports = { makeKit };
