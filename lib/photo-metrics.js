// 写真1枚の数値（レタッチの基準と比べるため。このPCの中だけで計算）
//   measure(file, { face }) →
//     明るさ Y（0〜255）系：meanY sdY p02 p50 p98 crush(Y<8 %) clip(Y>250 %) clipAny(どれか≥254 %) sat(HSV) rb(R−B) shRb/shGm hiRb/hiGm lc(局所コントラスト) lapVar(シャープさ・1080px) ringMinusCenter(周辺−中央 Y)
//     L*系（ポートレート用）：meanL p99L faceSkinL faceHue faceSat faceA faceB bgMinusFace bodyMinusFace brighterThanFace10 bgBrighterThanFace10 nFaces
//   測り方は .work/retouch-study と .work/portrait-study の分析と同じ（縮小320px・顔は600px・シャープさは1080px）
const sharp = require("sharp");
sharp.cache(false);
const lin = (c) => ((c /= 255), c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const fl = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
function lab(r, g, b) {
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const fx = fl(X), fy = fl(Y), fz = fl(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx ? d / mx : 0, mx / 255];
}
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r1 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 10) / 10);
const r3 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000);
const isSkinPx = (r, g, b, h, s, v) => (h <= 45 || h >= 355) && s >= 0.12 && s <= 0.65 && v >= 0.2 && r > g && g > b && r - b >= 15;

async function measure(file, opts = {}) {
  // ① Y系（320px）
  const { data, info } = await sharp(file).rotate().resize(320, 320, { fit: "inside" }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, N = W * H;
  const Y = new Float32Array(N);
  let crush = 0, clip = 0, clipAny = 0, sumS = 0, sumRb = 0, nCol = 0, ring = [], center = [];
  for (let i = 0; i < N; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    Y[i] = y;
    if (y < 8) crush++;
    if (y > 250) clip++;
    if (Math.max(r, g, b) >= 254) clipAny++;
    const [, s] = hsv(r, g, b);
    if (y > 20) (sumS += s), nCol++;
    sumRb += r - b;
    const x = i % W, yy = (i / W) | 0;
    if (x < W * 0.2 || x >= W * 0.8 || yy < H * 0.2 || yy >= H * 0.8) ring.push(y);
    else center.push(y);
  }
  const Ys = Array.from(Y).sort((a, b) => a - b);
  const meanY = mean(Ys);
  const sdY = Math.sqrt(mean(Ys.map((v) => (v - meanY) ** 2)));
  const p20 = pct(Ys, 0.2), p80 = pct(Ys, 0.8);
  let sRb = 0, sGm = 0, sn = 0, hRb = 0, hGm = 0, hn = 0, lc = 0;
  for (let i = 0; i < N; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    if (Y[i] <= p20) (sRb += r - b), (sGm += g - (r + b) / 2), sn++;
    else if (Y[i] >= p80 && Y[i] < 250) (hRb += r - b), (hGm += g - (r + b) / 2), hn++;
    const x = i % W, yy = (i / W) | 0;
    if (x > 0 && x < W - 1 && yy > 0 && yy < H - 1) lc += Math.abs(4 * Y[i] - Y[i - 1] - Y[i + 1] - Y[i - W] - Y[i + W]) / 4;
  }
  const o = {
    meanY: r1(meanY), sdY: r1(sdY), p02: r1(pct(Ys, 0.02)), p50: r1(pct(Ys, 0.5)), p98: r1(pct(Ys, 0.98)),
    crush: r3((crush / N) * 100), clip: r3((clip / N) * 100), clipAny: r3((clipAny / N) * 100),
    sat: r3(nCol ? sumS / nCol : 0), rb: r1(sumRb / N), shRb: r1(sn ? sRb / sn : 0), shGm: r1(sn ? sGm / sn : 0), hiRb: r1(hn ? hRb / hn : 0), hiGm: r1(hn ? hGm / hn : 0),
    lc: r1(lc / N), ringMinusCenter: r1(mean(ring) - mean(center)), night: meanY < 85 && pct(Ys, 0.5) < 80,
  };
  // ② シャープさ（1080px・グレー・ラプラシアンの分散）
  try {
    const g = await sharp(file).rotate().resize(1080, 1080, { fit: "inside", withoutEnlargement: true }).grayscale().raw().toBuffer({ resolveWithObject: true });
    const w = g.info.width, h = g.info.height, d = g.data;
    let s1 = 0, s2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const v = 4 * d[i] - d[i - 1] - d[i + 1] - d[i - w] - d[i + w];
        s1 += v;
        s2 += v * v;
        n++;
      }
    o.lapVar = Math.round(s2 / n - (s1 / n) ** 2);
    o.sharpOk = Math.max(w, h) >= 1000;
  } catch {}
  // ③ ポートレート（600px・顔検出）
  if (opts.face !== false) {
    try {
      const { data: d6, info: i6 } = await sharp(file).rotate().resize(600, 600, { fit: "inside" }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
      const W6 = i6.width, H6 = i6.height, N6 = W6 * H6;
      const L = new Float32Array(N6), A = new Float32Array(N6), B = new Float32Array(N6), HU = new Float32Array(N6), SA = new Float32Array(N6), SK = new Uint8Array(N6);
      for (let i = 0; i < N6; i++) {
        const r = d6[i * 3], g = d6[i * 3 + 1], b = d6[i * 3 + 2];
        const [l, a, bb] = lab(r, g, b);
        L[i] = l; A[i] = a; B[i] = bb;
        const [h, s, v] = hsv(r, g, b);
        HU[i] = h; SA[i] = s; SK[i] = isSkinPx(r, g, b, h, s, v) ? 1 : 0;
      }
      const Ls = Array.from(L).sort((a, b) => a - b);
      const mL = mean(Ls);
      let s2 = 0;
      for (const v of Ls) s2 += (v - mL) ** 2;
      o.meanL = r1(mL); o.p99L = r1(pct(Ls, 0.99)); o.p5L = r1(pct(Ls, 0.05)); o.sdL = r1(Math.sqrt(s2 / Ls.length));
      const faces = await require("./face-detect").detect(file, W6, H6);
      o.nFaces = faces.length;
      if (faces.length) {
        const fc = faces[0];
        o.faceArea = r1((fc.w * fc.h / N6) * 100);
        const x0 = fc.x + fc.w * 0.2, x1 = fc.x + fc.w * 0.8, y0 = fc.y + fc.h * 0.15, y1 = fc.y + fc.h * 0.85;
        const fL = [], fs = [];
        for (let y = Math.floor(y0); y < y1; y++) for (let x = Math.floor(x0); x < x1; x++) { const i = y * W6 + x; if (i >= 0 && i < N6) { fL.push(L[i]); if (SK[i]) fs.push(i); } }
        fL.sort((a, b) => a - b);
        o.faceL = r1(pct(fL, 0.5)); o.faceP90 = r1(pct(fL, 0.9));
        if (fs.length >= 20) {
          o.faceSkinL = r1(mean(fs.map((i) => L[i]))); o.faceHue = r1(mean(fs.map((i) => HU[i]))); o.faceSat = r3(mean(fs.map((i) => SA[i])));
          o.faceA = r1(mean(fs.map((i) => A[i]))); o.faceB = r1(mean(fs.map((i) => B[i])));
          o.faceRGB = [0, 1, 2].map((k) => Math.round(mean(fs.map((i) => d6[i * 3 + k]))));
        }
        const ref = o.faceSkinL ?? o.faceL;
        const px0 = fc.x - fc.w * 1.6, px1 = fc.x + fc.w * 2.6, py0 = fc.y - fc.h * 0.6;
        const inFace = (x, y) => x >= fc.x - fc.w * 0.15 && x < fc.x + fc.w * 1.15 && y >= fc.y - fc.h * 0.3 && y < fc.y + fc.h * 1.25;
        let bg = [], bgHi = 0, bodyS = [], any = 0;
        for (let i = 0; i < N6; i++) {
          const x = i % W6, y = (i / W6) | 0;
          if (L[i] > ref + 10 && !inFace(x, y)) any++;
          const inP = x >= px0 && x < px1 && y >= py0;
          if (!inP) { bg.push(L[i]); if (L[i] > ref + 10) bgHi++; }
          else if (SK[i] && !inFace(x, y)) bodyS.push(L[i]);
        }
        o.bgMinusFace = bg.length ? r1(mean(bg) - ref) : null;
        o.bgBrighterThanFace10 = bg.length ? r1((bgHi / bg.length) * 100) : null;
        o.bodyMinusFace = bodyS.length >= 30 ? r1(mean(bodyS) - ref) : null;
        o.brighterThanFace10 = r1((any / N6) * 100);
        o.backlit = o.bgMinusFace != null && o.bgMinusFace > 5;
      }
    } catch (e) {
      o.faceError = String(e.message).slice(0, 60);
    }
  }
  return o;
}
module.exports = { measure };
