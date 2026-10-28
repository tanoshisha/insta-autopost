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

// src: ファイルパスかBuffer / opts.focusY: 縦長を切る位置 / opts.keepFrom: 今の画像（あれば同じ構図で切る）
async function makePostImage(src, dest, cfgImage, opts = {}) {
  const buf = await sharp(src).rotate().toBuffer();
  const { width: w, height: h } = await sharp(buf).metadata();
  let img = sharp(buf);
  if (w / h < 0.8) {
    const ch = Math.round(w / 0.8);
    const top =
      opts.keepFrom && fs.existsSync(opts.keepFrom)
        ? await findTop(buf, w, h, opts.keepFrom)
        : Math.min(Math.max(Math.round((opts.focusY ?? 0.5) * h - ch / 2), 0), h - ch);
    img = img.extract({ left: 0, top, width: w, height: ch });
  } else if (w / h > 1.91) {
    const cw = Math.round(h * 1.91);
    img = img.extract({ left: Math.round((w - cw) / 2), top: 0, width: cw, height: h });
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
