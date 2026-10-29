// リール用の色味（「デジタルでフィルム」っぽく）：黒を少し持ち上げる（マット）・やわらかいコントラスト・
//   影はネイビー寄り／明るい所は暖かく・緑は少し青緑へ・彩度は少し控えめ
//   参考：kai__photo1（フィルムっぽい・やわらかい）と noa.jp2000（ネイビーの影・暖かい光）
const sharp = require("sharp");

// 0〜255 の表を作る（毎回の計算を速く）
function curve() {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    const s = x + 0.12 * Math.sin(2 * Math.PI * x) * -0.5 * 0.0 + 0.1 * (x - 0.5) * (1 - Math.abs(2 * x - 1)); // ゆるいS字
    t[i] = 0.055 + 0.915 * Math.min(1, Math.max(0, s)); // 黒を持ち上げ、白は少しだけ抑える
  }
  return t;
}
const C = curve();

async function filmLook(input, { strength = 1 } = {}) {
  const img = sharp(input).removeAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(data.length);
  const k = strength;
  for (let p = 0; p < data.length; p += 3) {
    let r = data[p] / 255;
    let g = data[p + 1] / 255;
    let b = data[p + 2] / 255;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    // 緑を少し青緑へ（緑が強い所だけ）
    const gx = g - Math.max(r, b);
    if (gx > 0) {
      g -= gx * 0.18 * k;
      b += gx * 0.12 * k;
    }
    // 彩度を少し控えめに
    const sat = 1 - 0.1 * k;
    r = l + (r - l) * sat;
    g = l + (g - l) * sat;
    b = l + (b - l) * sat;
    // 影はネイビー・明るい所は暖かく
    const sh = Math.max(0, 1 - l * 2.2);
    const hi = Math.max(0, l * 1.6 - 0.6);
    r += (-0.025 * sh + 0.03 * hi) * k;
    g += (0.0 * sh + 0.008 * hi) * k;
    b += (0.04 * sh - 0.03 * hi) * k;
    const f = (v) => {
      const i = Math.min(255, Math.max(0, Math.round(v * 255)));
      return Math.round(255 * (C[i] * k + (i / 255) * (1 - k)));
    };
    out[p] = f(r);
    out[p + 1] = f(g);
    out[p + 2] = f(b);
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } });
}

module.exports = { filmLook };
