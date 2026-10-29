// 似ている写真を見分ける（見た目の指紋 dHash で比べる）
//   ほぼ同じ写真は1枚だけ残し、似ている写真は続かないように並べ替える（リールで同じような写真が2連続にならないように）
const fs = require("fs");
const sharp = require("sharp");

async function dhash(src) {
  const { data } = await sharp(fs.readFileSync(src)).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const bits = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(data[y * 9 + x] > data[y * 9 + x + 1] ? 1 : 0);
  // 色も少し見る（同じ構図でも色がまったく違えば別の写真）
  const st = await sharp(fs.readFileSync(src)).resize(16, 16, { fit: "fill" }).stats();
  return { bits, col: st.channels.slice(0, 3).map((c) => c.mean) };
}
function dist(a, b) {
  let d = 0;
  for (let i = 0; i < 64; i++) d += a.bits[i] !== b.bits[i];
  const cd = Math.hypot(...a.col.map((v, i) => v - b.col[i])) / 20; // 色の差（20 で 1 ぶん）
  return d + cd;
}

// items: [{ src, ... }]。 same（これより近い＝ほぼ同じ）・near（これより近い＝似ている）
async function dedupe(items, { same = 12, near = 18 } = {}) {
  const hs = [];
  for (const it of items) hs.push(await dhash(it.src).catch(() => null));
  const keep = [];
  const kh = [];
  for (const [i, it] of items.entries()) {
    const h = hs[i];
    if (h && kh.some((k) => k && dist(k, h) < same)) continue; // ほぼ同じ → 外す
    keep.push(it);
    kh.push(h);
  }
  // 並べ替え：直前と似ていない写真を先に（1枚目と最後は動かさない）
  const out = [keep[0]];
  const oh = [kh[0]];
  const rest = keep.slice(1).map((it, i) => ({ it, h: kh[i + 1] }));
  while (rest.length) {
    const last = oh[oh.length - 1];
    let j = rest.findIndex((r) => !r.h || !last || dist(r.h, last) >= near);
    if (j === -1 || (rest.length > 1 && j === rest.length - 1 && rest.length !== 1)) j = j === -1 ? 0 : j;
    const [r] = rest.splice(j, 1);
    out.push(r.it);
    oh.push(r.h);
  }
  return { items: out, removed: items.length - keep.length };
}

module.exports = { dedupe, dhash, dist };
