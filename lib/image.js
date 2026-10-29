// インスタ投稿用の画像づくり（plan.js・Lightroomの再編集反映・作り直しで共通）
//   4:5〜1.91:1 に収める → 幅1440px → 軽くシャープ → sRGB・JPEG q95・色の間引きなし
const fs = require("fs");
const sharp = require("sharp");
sharp.cache(false); // Windowsで、読んだ画像を同じ場所に書き戻せるように

// 今の投稿画像が、新しい元画像のどの高さで切り抜かれていたかを探す（小さくして差が一番小さい位置）
async function findTop(buf, w, h, curPath) {
  const SW = 96;
  const ch = Math.round(w / 0.8);
  const hs = Math.round((h * SW) / w);
  const hc = Math.round((ch * SW) / w);
  const big = await sharp(buf).resize(SW, hs, { fit: "fill" }).greyscale().raw().toBuffer();
  const cur = await sharp(fs.readFileSync(curPath)).resize(SW, hc, { fit: "fill" }).greyscale().raw().toBuffer();
  let best = 0;
  let bestD = Infinity;
  for (let off = 0; off <= hs - hc; off++) {
    let d = 0;
    for (let i = 0; i < cur.length && d < bestD; i++) d += Math.abs(cur[i] - big[off * SW + i]);
    if (d < bestD) (bestD = d), (best = off);
  }
  return Math.min(Math.max(Math.round((best * h) / hs), 0), h - ch);
}

// 必ず4:5で切る。crop = { cx, cy: 残したい中心（0〜1）, zoom: 1=4:5で取れる最大の範囲、1.3=そこから1.3倍寄る }
function cropRect(w, h, crop) {
  const zoom = Math.min(Math.max(crop.zoom || 1, 1), 2);
  let cw = w / h > 0.8 ? h * 0.8 : w;
  let ch = cw / 0.8;
  cw = Math.round(cw / zoom);
  ch = Math.round(cw / 0.8);
  const clamp = (v, max) => Math.min(Math.max(Math.round(v), 0), max);
  return { left: clamp((crop.cx ?? 0.5) * w - cw / 2, w - cw), top: clamp((crop.cy ?? 0.5) * h - ch / 2, h - ch), width: cw, height: ch };
}

// src: ファイルパスかBuffer / opts.crop: 切り取り方（AIが決める） / opts.focusY: 縦長を切る位置（古い形式） / opts.keepFrom: 今の画像（あれば同じ構図で切る）
async function makePostImage(src, dest, cfgImage, opts = {}) {
  const buf = await sharp(src).rotate().toBuffer();
  const { width: w, height: h } = await sharp(buf).metadata();
  let img = sharp(buf);
  if (opts.crop) {
    img = img.extract(cropRect(w, h, opts.crop));
  } else if (w / h < 0.8) {
    const ch = Math.round(w / 0.8);
    const top =
      opts.keepFrom && fs.existsSync(opts.keepFrom)
        ? await findTop(buf, w, h, opts.keepFrom)
        : Math.min(Math.max(Math.round((opts.focusY ?? 0.5) * h - ch / 2), 0), h - ch);
    img = img.extract({ left: 0, top, width: w, height: ch });
  } else if (w / h > 0.8) {
    img = img.extract(cropRect(w, h, { cx: 0.5, cy: 0.5 })); // 横長・正方形も4:5に（真ん中）
  }
  const out = await img
    .resize({ width: cfgImage.width, withoutEnlargement: true, kernel: "lanczos3" })
    .sharpen({ sigma: 0.5 }) // 縮小で甘くなる分だけ軽く（インスタの再圧縮でぼやけにくい）
    .toColorspace("srgb")
    .jpeg({ quality: cfgImage.quality, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toBuffer();
  fs.writeFileSync(dest, out);
  return out;
}

async function makeThumb(fromPath, dest) {
  await sharp(fs.readFileSync(fromPath)).resize({ width: 480 }).jpeg({ quality: 78 }).toFile(dest);
}

module.exports = { makePostImage, makeThumb };
