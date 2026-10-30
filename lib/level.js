// 写真の「水平・垂直」と「真ん中」を測る（AIの目分量ではなく、写真の中の線から正確に）
//   measureTilt：建物の縦の線・水平線を見つけて、何度傾いているか（Lightroom の CropAngle にそのまま入れる値）
//                縦の線が上すぼまり/下すぼまりになっているか（＝Upright の垂直補正が要るか）も
//   centerAxis：左右対称の軸がどこにあるか（被写体が真ん中の写真を、ぴったり真ん中にするため）
const sharp = require("sharp");
sharp.cache(false);
let cvp = null;
const loadCv = () =>
  (cvp ||= new Promise((ok) => {
    const cv = require("@techstark/opencv-js");
    if (cv.Mat) ok({ cv });
    else cv.onRuntimeInitialized = () => ok({ cv });
  }));
async function gray(input, long) {
  const { data, info } = await sharp(input).rotate().resize({ width: long, height: long, fit: "inside" }).grayscale().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}
// 重み付きの中央値
function wmedian(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a.v - b.v);
  const tot = s.reduce((t, x) => t + x.w, 0);
  let acc = 0;
  for (const x of s) if ((acc += x.w) >= tot / 2) return x.v;
  return s[s.length - 1].v;
}

async function measureTilt(input) {
  const { cv } = await loadCv();
  const g = await gray(input, 1400);
  const m = cv.matFromArray(g.h, g.w, cv.CV_8UC1, Array.from(g.data));
  const blur = new cv.Mat(), edges = new cv.Mat(), lines = new cv.Mat();
  cv.GaussianBlur(m, blur, new cv.Size(3, 3), 0);
  cv.Canny(blur, edges, 40, 120);
  const diag = Math.hypot(g.w, g.h);
  cv.HoughLinesP(edges, lines, 1, Math.PI / 720, 40, diag * 0.035, 3);
  const vert = [], hori = [];
  for (let i = 0; i < lines.rows; i++) {
    const [x1, y1, x2, y2] = lines.data32S.slice(i * 4, i * 4 + 4);
    const len = Math.hypot(x2 - x1, y2 - y1);
    let a = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI; // 画面の座標（下向きが+）での角度
    if (a < -90) a += 180;
    if (a > 90) a -= 180;
    // 縦の線：90°からのずれ（右に倒れている＝+）
    if (Math.abs(Math.abs(a) - 90) < 12) {
      const d = a > 0 ? a - 90 : a + 90;
      vert.push({ v: d, w: len, x: (x1 + x2) / 2 / g.w });
    } else if (Math.abs(a) < 10) hori.push({ v: a, w: len });
  }
  m.delete(), blur.delete(), edges.delete(), lines.delete();
  // 縦の線は左右で倒れ方が違う（すぼまり）ことがあるので、写真の中央付近の線を重く見る
  const vC = vert.map((x) => ({ ...x, w: x.w * (1.5 - Math.abs(x.x - 0.5) * 2) }));
  const vTilt = wmedian(vC), hTilt = wmedian(hori);
  const vLen = vert.reduce((t, x) => t + x.w, 0) / diag, hLen = hori.reduce((t, x) => t + x.w, 0) / diag;
  // すぼまり：左側の縦線と右側の縦線の倒れの差
  const L = wmedian(vert.filter((x) => x.x < 0.35)), R = wmedian(vert.filter((x) => x.x > 0.65));
  const keystone = L != null && R != null ? R - L : null;
  // 縦の線が十分あれば縦を優先（建物・柱は縦がいちばん目立つ）、なければ水平線
  //   縦の線が左右で大きくすぼまっている（見上げ・見下ろし）時は、回転では直らない → Upright の垂直補正が要る
  //   （本人が手で直した正解と比べて確認：線がはっきりある写真は0.2〜0.5°以内）
  let tilt = null, by = null;
  const converging = keystone != null && Math.abs(keystone) > 3;
  if (vTilt != null && vLen > 0.2 && !converging) (tilt = vTilt), (by = "縦の線");
  else if (hTilt != null && hLen > 0.2) (tilt = hTilt), (by = "水平線");
  else if (converging) by = "縦の線がすぼまっている（Upright の垂直補正）";
  return { tilt: tilt == null ? null : +tilt.toFixed(2), by, vertical: vTilt, horizontal: hTilt, vLen: +vLen.toFixed(2), hLen: +hLen.toFixed(2), keystone: keystone == null ? null : +keystone.toFixed(2), converging };
}

// 左右対称の軸（写真の幅=1での位置）。鏡に映した形と最もよく重なる位置を探す
async function centerAxis(input) {
  const W = 360;
  const { data, info } = await sharp(input).rotate().resize({ width: W }).grayscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  // 明るさの差ではなく、形（横方向の変化）で比べる
  const gx = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 1; x < w - 1; x++) gx[y * w + x] = Math.abs(data[y * w + x + 1] - data[y * w + x - 1]);
  let best = { s: -1, c: w / 2 };
  for (let c2 = Math.round(w * 0.7); c2 <= Math.round(w * 1.3); c2++) {
    // 軸 = c2/2（半ピクセル刻み）
    const half = Math.min(c2 / 2, w - c2 / 2) | 0;
    if (half < w * 0.25) continue;
    let sab = 0, saa = 0, sbb = 0;
    for (let y = 0; y < h; y += 2)
      for (let d = 1; d < half; d++) {
        const xl = Math.floor(c2 / 2 - d), xr = Math.ceil(c2 / 2 + d);
        if (xl < 1 || xr >= w - 1) break;
        const a = gx[y * w + xl], b = gx[y * w + xr];
        sab += a * b, saa += a * a, sbb += b * b;
      }
    const s = sab / Math.sqrt(saa * sbb + 1e-9);
    if (s > best.s) best = { s, c: c2 / 2 };
  }
  return { axis: +(best.c / w).toFixed(4), score: +best.s.toFixed(3) };
}
module.exports = { measureTilt, centerAxis };
