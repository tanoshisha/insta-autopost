// 傾きを「見比べて」決める：少しずつ回した候補に格子を重ねて並べ、AIにいちばん水平・垂直なものを選ばせる（2段階で0.25°まで）
//   写真の中の線から測った値（lib/level.js）があれば、それを中心に候補を作る
//   返す値は Lightroom の CropAngle（正＝画面上で時計回りに傾いている写真を直す向き）
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");
sharp.cache(false);
const CLAUDE = path.join(process.env.USERPROFILE || "", ".local", "bin", "claude.exe");
const LABELS = "ABCDEFG";

// CropAngle=a の見た目＝写真を反時計回りに a 度回す（sharp は正が時計回りなので -a）
async function panel(src, a, H) {
  const img = sharp(src).rotate(-a, { background: "#000" });
  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  // 回して出た黒い角を避けて、真ん中の82%だけ
  const cw = Math.round(info.width * 0.82), ch = Math.round(info.height * 0.82);
  const b = await sharp(data).extract({ left: ((info.width - cw) / 2) | 0, top: ((info.height - ch) / 2) | 0, width: cw, height: ch }).resize({ height: H }).toBuffer({ resolveWithObject: true });
  const w = b.info.width;
  const lines = [];
  for (let i = 1; i < 10; i++) lines.push(`<line x1="${(w * i) / 10}" y1="0" x2="${(w * i) / 10}" y2="${H}"/>`, `<line x1="0" y1="${(H * i) / 10}" x2="${w}" y2="${(H * i) / 10}"/>`);
  const grid = Buffer.from(`<svg width="${w}" height="${H}"><g stroke="#ff2d55" stroke-opacity="0.75" stroke-width="1">${lines.join("")}</g></svg>`);
  return { buf: await sharp(b.data).composite([{ input: grid }]).png().toBuffer(), w };
}
async function sheet(src, angles, file) {
  const H = 640;
  const ps = [];
  for (const a of angles) ps.push(await panel(src, a, H));
  const gap = 24, top = 44;
  const W = ps.reduce((t, p) => t + p.w + gap, gap);
  let x = gap;
  const comp = [];
  ps.forEach((p, i) => {
    comp.push({ input: p.buf, left: x, top });
    comp.push({ input: Buffer.from(`<svg width="60" height="40"><text x="0" y="32" font-size="32" font-family="Arial" font-weight="bold" fill="#fff">${LABELS[i]}</text></svg>`), left: x, top: 2 });
    x += p.w + gap;
  });
  await sharp({ create: { width: W, height: H + top + gap, channels: 3, background: "#222" } }).composite(comp).jpeg({ quality: 88 }).toFile(file);
}
function ask(dir, file, n) {
  const prompt = `${file} を Read で見てください。同じ写真を少しずつ回した候補 ${LABELS.slice(0, n).split("").join("・")} が並んでいて、赤い格子が重ねてあります。
写真家は垂直・水平をとても気にします。建物・柱・窓枠・電柱などの縦の線が格子の縦線と平行で、水平線・地面・棚などの横の線が格子の横線と平行な候補はどれですか。
縦の線を優先（見上げで上がすぼまる線は、画面の中央付近の縦線で判断）。はっきりした線がない時は、地平線や人の立ち姿など全体の傾きで判断。
出力は次のJSONだけ：{"pick":"C","sure":true}（sure は差がはっきり分かる時 true、どれも同じに見える時 false）`;
  return new Promise((ok) => {
    const p = spawn(fs.existsSync(CLAUDE) ? CLAUDE : "claude", ["-p", "--allowedTools", "Read", "--output-format", "json", "--model", "opus"], { cwd: dir });
    let out = "";
    const t = setTimeout(() => p.kill(), 5 * 60e3);
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => {
      clearTimeout(t);
      try {
        const m = (JSON.parse(out).result || "").match(/\{[\s\S]*?\}/);
        const j = JSON.parse(m[0]);
        ok({ i: LABELS.indexOf(String(j.pick).trim().toUpperCase()), sure: j.sure !== false });
      } catch {
        ok({ i: -1, sure: false });
      }
    });
    p.stdin.end(prompt);
  });
}
// src：トリミング前の全体の写真（向きを直したもの）。hint：線から測った角度（なければ null）
async function levelByEye(src, hint = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "level-"));
  try {
    const c = hint == null ? 0 : Math.max(-6, Math.min(6, hint));
    const a1 = hint == null ? [-3, -2, -1, 0, 1, 2, 3] : [-1.5, -1, -0.5, 0, 0.5, 1, 1.5].map((d) => +(c + d).toFixed(2));
    await sheet(src, a1, path.join(dir, "1.jpg"));
    const r1 = await ask(dir, "1.jpg", a1.length);
    if (r1.i < 0) return null;
    const m = a1[r1.i];
    const step = hint == null ? 0.25 : 0.12;
    const a2 = [-3, -2, -1, 0, 1, 2, 3].map((k) => +(m + k * step * (hint == null ? 1.33 : 1.33)).toFixed(2));
    await sheet(src, a2, path.join(dir, "2.jpg"));
    const r2 = await ask(dir, "2.jpg", a2.length);
    const angle = r2.i < 0 ? m : a2[r2.i];
    return { angle, sure: r1.sure && r2.sure, first: m };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
module.exports = { levelByEye, sheet };
