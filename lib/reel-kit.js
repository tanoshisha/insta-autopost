// リール用の写真セット（動画は作らない。本人が Edits で組む用）
//   縦 9:16（1080x1920）に切り抜き・メリハリのある色（vivid / vividNight）・使う順番の番号付き
//   layout: "side"（横位置を90°倒す）/ "frame"（白い紙に置く）にも対応
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { filmLook } = require("./film-look");
const W = 1080;
const H = 1920;

// 縦長に切り抜く位置：主役（AIが答えた四角）が欠けないように。真ん中の構図は対称軸をぴったり真ん中に
//   主役の幅（高さ）の85%以上が残らない時は null（その写真は使わない＝本人の指示 2026-10-31。差し替え候補から選び直す）
async function coverCrop(buf, subj) {
  const m = await sharp(buf).metadata();
  const sc = Math.max(W / m.width, H / m.height);
  const sw = Math.round(m.width * sc), sh = Math.round(m.height * sc);
  const big = await sharp(buf).resize(sw, sh).toBuffer();
  if (!subj) return sharp(big).extract({ left: ((sw - W) / 2) | 0, top: ((sh - H) / 2) | 0, width: W, height: H }).toBuffer();
  const [l, t, r, b] = subj.box;
  let cx = (l + r) / 2, cy = (t + b) / 2;
  if (subj.centered && sw > W) {
    try {
      const a = (await require("./level").centerAxis(buf)).axis;
      if (Math.abs(a - cx) < 0.08) cx = a;
    } catch {}
  }
  const left = Math.round(Math.min(Math.max(cx * sw - W / 2, 0), sw - W));
  const top = Math.round(Math.min(Math.max(cy * sh - H / 2, 0), sh - H));
  const keep = (a0, a1, w0, w1) => Math.max(0, Math.min(a1, w1) - Math.max(a0, w0)) / Math.max(1e-6, a1 - a0);
  const kx = keep(l * sw, r * sw, left, left + W), ky = keep(t * sh, b * sh, top, top + H);
  // 景色全体が主役（四角が幅・高さの75%以上）の写真は、切り抜いても「見切れ」にならないので、そのまま縦に切る
  const scene = r - l >= 0.75 && b - t >= 0.75;
  if (!scene && Math.min(kx, ky) < 0.85) return null;
  return sharp(big).extract({ left, top, width: W, height: H }).toBuffer();
}

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
  // 主役の位置（見切れさせないため）。差し替え候補（opts.spares：[{src}]）も一緒に
  const spares = [...(opts.spares || [])];
  let subj = {};
  if (opts.layout !== "frame") {
    try {
      subj = await require("./subject-box").boxes([...items, ...spares].map((it) => it.src));
    } catch {}
  }
  // 差し替える時は、ほかの写真と同じテーマ（CLIPで似ている）で、似すぎていない（0.93未満）候補を選ぶ
  let M = null;
  const all = [...items, ...spares].map((it) => it.src);
  const pickSpare = () => {
    if (!spares.length) return null;
    try {
      M ||= require("./similar").matrix(all);
    } catch {
      return spares.shift();
    }
    const usedIdx = used.map((u) => all.indexOf(u)).concat(items.slice(out.length + 1).map((it) => all.indexOf(it.src))).filter((k) => k >= 0);
    let best = -1, bs = -1;
    for (const [j, sp] of spares.entries()) {
      const k = all.indexOf(sp.src);
      const sims = usedIdx.map((u) => M[k][u]);
      if (!sims.length || Math.max(...sims) >= 0.93) continue;
      const avg = sims.reduce((a, b) => a + b, 0) / sims.length;
      if (avg > bs) (bs = avg), (best = j);
    }
    return best < 0 ? null : spares.splice(best, 1)[0];
  };
  const MIN = opts.min || 8;
  let dropped = 0;
  const out = [];
  const used = []; // 実際に使った写真（順番どおり）
  const swaps = [];
  for (let [i, it] of items.entries()) {
   for (;;) {
    let sb = subj[it.src] || null;
    let buf = await sharp(fs.readFileSync(it.src)).rotate().toBuffer();
    if (opts.layout === "side") {
      const m = await sharp(buf).metadata();
      // 横向きのリールは横位置の写真だけ（縦位置の差し替え候補は使わない）
      if (m.width <= m.height && it.spare) {
        const nx = spares.shift();
        if (!nx) break;
        swaps.push({ i, from: it.src, to: nx.src });
        it = { ...nx, spare: true };
        continue;
      }
      if (m.width > m.height) {
        buf = await sharp(buf).rotate(90).toBuffer();
        // 時計回りに90°倒したので、主役の四角も一緒に回す
        if (sb) sb = { ...sb, box: [1 - sb.box[3], sb.box[0], 1 - sb.box[1], sb.box[2]] };
      }
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
      const crop = await coverCrop(buf, sb);
      if (!crop) {
        // 主役が見切れる → 8枚以上残るなら外すだけ。足りなくなるなら同じテーマの候補と入れ替え
        const next = items.length - dropped - 1 >= MIN ? null : pickSpare();
        if (!next) {
          dropped++;
          swaps.push({ i, from: it.src, to: null });
          break;
        }
        swaps.push({ i, from: it.src, to: next.src });
        it = { ...next, spare: true };
        continue;
      }
      await (await filmLook(crop, { look })).jpeg({ quality: 93 }).toFile(f);
    }
    out.push(f);
    used.push(it.src);
    break;
   }
  }
  // 番号を詰め直す（使わなかった写真の分）
  const files = [];
  for (const [k, f] of out.entries()) {
    const g = path.join(kitDir, `${String(k + 1).padStart(2, "0")}.jpg`);
    if (f !== g) fs.renameSync(f, g);
    files.push(g);
  }
  return { files, look, swaps, used };
}
module.exports = { makeKit };
