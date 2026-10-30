// 載せた写真（トリミング済み）が、元の写真のどこをどう切り取ったものかを求める
//   両方の写真の「特徴点」（角や模様）を見つけて対応を取り、拡大率・回転・位置を出す（色や明るさが違っても合う）
//   → Lightroom のトリミングの数値（CropLeft/Top/Right/Bottom/Angle：元の写真の幅・高さを1とした位置）
const sharp = require("sharp");
sharp.cache(false);
let cvp = null;
const loadCv = () =>
  // OpenCV は then を持つので、そのまま Promise で返すと待ち続けてしまう → 箱に入れて返す
  (cvp ||= new Promise((ok) => {
    const cv = require("@techstark/opencv-js");
    if (cv.Mat) ok({ cv });
    else cv.onRuntimeInitialized = () => ok({ cv });
  }));

async function gray(input, long) {
  const { data, info } = await sharp(input).resize({ width: long, height: long, fit: "inside" }).grayscale().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}
function feats(cv, g, n) {
  const m = cv.matFromArray(g.h, g.w, cv.CV_8UC1, Array.from(g.data));
  const orb = new cv.ORB(n);
  const kp = new cv.KeyPointVector();
  const des = new cv.Mat();
  const none = new cv.Mat();
  orb.detectAndCompute(m, none, kp, des);
  const pts = [];
  for (let i = 0; i < kp.size(); i++) pts.push(kp.get(i).pt);
  m.delete(), orb.delete(), kp.delete(), none.delete();
  return { pts, des };
}
// 2点の対応から「拡大・回転・移動」を出す（ref の点 → 元の写真の点）
function sim2(a1, b1, a2, b2) {
  const ax = a2.x - a1.x, ay = a2.y - a1.y, bx = b2.x - b1.x, by = b2.y - b1.y;
  const d = ax * ax + ay * ay;
  if (d < 1e-6) return null;
  const c = (ax * bx + ay * by) / d, s = (ax * by - ay * bx) / d;
  return { c, s, tx: b1.x - (c * a1.x - s * a1.y), ty: b1.y - (s * a1.x + c * a1.y) };
}
const ap = (T, p) => ({ x: T.c * p.x - T.s * p.y + T.tx, y: T.s * p.x + T.c * p.y + T.ty });
// 最小二乗（たくさんの点で合わせ直す）
function lsq(A, B) {
  const n = A.length;
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (let i = 0; i < n; i++) (ax += A[i].x), (ay += A[i].y), (bx += B[i].x), (by += B[i].y);
  (ax /= n), (ay /= n), (bx /= n), (by /= n);
  let sc = 0, ss = 0, sd = 0;
  for (let i = 0; i < n; i++) {
    const px = A[i].x - ax, py = A[i].y - ay, qx = B[i].x - bx, qy = B[i].y - by;
    sc += px * qx + py * qy;
    ss += px * qy - py * qx;
    sd += px * px + py * py;
  }
  const c = sc / sd, s = ss / sd;
  return { c, s, tx: bx - (c * ax - s * ay), ty: by - (s * ax + c * ay) };
}

// ref：載せた写真、src：元の写真（向きを直した、トリミングなしの全体）
async function fitCrop(ref, src) {
  const { cv } = await loadCv();
  const R = await gray(ref, 1000);
  const S = await gray(src, 1600);
  const fr = feats(cv, R, 4000);
  const fs_ = feats(cv, S, 8000);
  if (fr.des.rows < 10 || fs_.des.rows < 10) return (fr.des.delete(), fs_.des.delete(), null);
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const mm = new cv.DMatchVectorVector();
  bf.knnMatch(fr.des, fs_.des, mm, 2);
  const A = [], B = [];
  for (let i = 0; i < mm.size(); i++) {
    const v = mm.get(i);
    if (v.size() < 2) continue;
    const m1 = v.get(0), m2 = v.get(1);
    if (m1.distance < 0.8 * m2.distance) A.push(fr.pts[m1.queryIdx]), B.push(fs_.pts[m1.trainIdx]);
  }
  mm.delete(), bf.delete(), fr.des.delete(), fs_.des.delete();
  if (A.length < 8) return null;
  // RANSAC：でたらめに2組選んで合わせ、いちばん多くの点が合う形を探す
  const tol = 3;
  let best = null, bestIn = [];
  for (let it = 0; it < 3000; it++) {
    const i = (Math.random() * A.length) | 0, j = (Math.random() * A.length) | 0;
    if (i === j) continue;
    const T = sim2(A[i], B[i], A[j], B[j]);
    if (!T) continue;
    const sc = Math.hypot(T.c, T.s);
    if (sc < 0.2 || sc > 3) continue;
    const inl = [];
    for (let k = 0; k < A.length; k++) {
      const p = ap(T, A[k]);
      if (Math.hypot(p.x - B[k].x, p.y - B[k].y) < tol) inl.push(k);
    }
    if (inl.length > bestIn.length) (best = T), (bestIn = inl);
  }
  if (!best || bestIn.length < 12) return { ok: false, inliers: bestIn.length, matches: A.length };
  let T = best;
  for (let r = 0; r < 3; r++) {
    T = lsq(bestIn.map((k) => A[k]), bestIn.map((k) => B[k]));
    const inl = [];
    for (let k = 0; k < A.length; k++) {
      const p = ap(T, A[k]);
      if (Math.hypot(p.x - B[k].x, p.y - B[k].y) < tol) inl.push(k);
    }
    bestIn = inl;
  }
  // 載せた写真の四隅が、元の写真のどこに来るか
  const tl = ap(T, { x: 0, y: 0 }), br = ap(T, { x: R.w, y: R.h });
  const angle = (Math.atan2(T.s, T.c) * 180) / Math.PI;
  return {
    ok: true,
    inliers: bestIn.length,
    matches: A.length,
    left: tl.x / S.w,
    top: tl.y / S.h,
    right: br.x / S.w,
    bottom: br.y / S.h,
    angle,
    // 四隅（左上・右上・右下・左下）の元の写真での位置（ピクセル）と、元の写真の大きさ
    corners: [ap(T, { x: 0, y: 0 }), ap(T, { x: R.w, y: 0 }), ap(T, { x: R.w, y: R.h }), ap(T, { x: 0, y: R.h })],
    sw: S.w,
    sh: S.h,
  };
}
module.exports = { fitCrop };

// 求めた四隅 → Lightroom のトリミングの数値
//   Lightroom は「センサーの向き（回転を直す前）」で、トリミング枠の対角の2隅（左上・右下）を、写真の幅・高さ＝1で持つ
//   角度は表示の向きで求めた角度そのまま（正解のある38枚で、ずれ0.2%以内を確認）
function toLrCrop(fit, orientation) {
  const W = fit.sw, H = fit.sh;
  const side = orientation === "BC" || orientation === "DA";
  const sw = side ? H : W, sh = side ? W : H;
  const P = fit.corners.map((p) =>
    orientation === "BC" ? { x: p.y, y: W - p.x } : orientation === "DA" ? { x: H - p.y, y: p.x } : orientation === "CD" ? { x: W - p.x, y: H - p.y } : p
  );
  const a = P.reduce((b, p) => (p.x + p.y < b.x + b.y ? p : b));
  const z = P.reduce((b, p) => (p.x + p.y > b.x + b.y ? p : b));
  // 端にほぼ付いている時は端に（インスタの書き出しで1〜2ピクセルずれるため）
  const snap = (v) => +(v < 0.005 ? 0 : v > 0.995 ? 1 : v).toFixed(6);
  return { left: snap(a.x / sw), top: snap(a.y / sh), right: snap(z.x / sw), bottom: snap(z.y / sh), angle: +fit.angle.toFixed(4) };
}
module.exports = { fitCrop, toLrCrop };
