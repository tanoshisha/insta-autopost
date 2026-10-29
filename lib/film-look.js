// リール用の色味（ジャンルで分ける。反応の良かった色に少しずつ寄せていく）
//   teal   … 夜。noa.jp2000 風：影は青緑、オレンジ（ネオン・提灯）だけ浮かせる、ほかの色は少し抑える
//   pastel … 昼。kai__photo1 風：黒をしっかり持ち上げたやわらかいフィルム、青緑寄り、コントラストは低め
//   film   … その間（黒を少し持ち上げ・影はネイビー・明るい所は暖かく）
//   auto   … 写真の明るさで teal / pastel を選ぶ
const sharp = require("sharp");

const LOOKS = {
  teal: { lift: 0.035, roll: 0.94, s: 0.16, sat: 0.7, keepOrange: 0.45, sh: [-0.09, 0.035, 0.075], hi: [0.04, 0.012, -0.035], green: [0.4, 0.28] },
  pastel: { lift: 0.11, roll: 0.88, s: 0.0, sat: 0.8, keepOrange: 0, sh: [-0.02, 0.025, 0.03], hi: [0.025, 0.015, -0.015], green: [0.22, 0.14] },
  film: { lift: 0.055, roll: 0.915, s: 0.06, sat: 0.9, keepOrange: 0, sh: [-0.025, 0, 0.04], hi: [0.03, 0.008, -0.03], green: [0.18, 0.12] },
};

function table(L) {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    const s = x + L.s * (x - 0.5) * (1 - Math.abs(2 * x - 1)) * 2; // ゆるいS字
    t[i] = L.lift + L.roll * Math.min(1, Math.max(0, s));
  }
  return t;
}

async function lumOf(input) {
  const st = await sharp(input).stats();
  return 0.299 * st.channels[0].mean + 0.587 * st.channels[1].mean + 0.114 * st.channels[2].mean;
}

// look: "teal" | "pastel" | "film" | "auto"。sharpen: ディテール強め（構想：シャープ強めの方が相性がいい）
async function filmLook(input, { look = "auto", strength = 1, sharpen = true } = {}) {
  if (look === "auto") look = (await lumOf(input)) < 100 ? "teal" : "pastel";
  const L = LOOKS[look] || LOOKS.film;
  const C = table(L);
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(data.length);
  const k = strength;
  for (let p = 0; p < data.length; p += 3) {
    let r = data[p] / 255;
    let g = data[p + 1] / 255;
    let b = data[p + 2] / 255;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    // 緑を青緑へ
    const gx = g - Math.max(r, b);
    if (gx > 0) {
      g -= gx * L.green[0] * k;
      b += gx * L.green[1] * k;
    }
    // 彩度を抑える。ただしオレンジ（ネオン・提灯・肌）は残す
    const orange = r > g && g > b ? Math.min(1, (r - b) * 2) : 0;
    const sat = 1 - (1 - L.sat) * k * (1 - orange * L.keepOrange * 2);
    r = l + (r - l) * sat;
    g = l + (g - l) * sat;
    b = l + (b - l) * sat;
    // 影と明るい所の色
    const sh = Math.max(0, 1 - l * 2.2);
    const hi = Math.max(0, l * 1.6 - 0.6);
    r += (L.sh[0] * sh + L.hi[0] * hi) * k;
    g += (L.sh[1] * sh + L.hi[1] * hi) * k;
    b += (L.sh[2] * sh + L.hi[2] * hi) * k;
    const f = (v) => {
      const i = Math.min(255, Math.max(0, Math.round(v * 255)));
      return Math.round(255 * (C[i] * k + (i / 255) * (1 - k)));
    };
    out[p] = f(r);
    out[p + 1] = f(g);
    out[p + 2] = f(b);
  }
  let img = sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } });
  if (sharpen) img = img.sharpen({ sigma: 1.1, m1: 0.6, m2: 2.2 });
  return img;
}

module.exports = { filmLook, LOOKS };
