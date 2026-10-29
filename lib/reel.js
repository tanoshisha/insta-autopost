// リール用の動画を作る（写真 → 9:16 の「ビートに合わせて切り替わる」動画）
//   ・写真は画面いっぱい（主役が残るように自動で切り抜く）。切り替えはハードカット、1枚ごとに少しずつ寄る/引く
//   ・切り替えは曲のテンポ（bpm）の拍に合わせる。最初の1枚は長めに見せて、場所と日付を映画のタイトルのように重ねる
//   ・音は入れない（インスタのアプリで曲を付けて投稿する。曲ページからの流入があり、伸びやすい）
//   ・ffmpeg は GitHub では起動時に apt で入れる（PC では ffmpeg-static を使う）
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sharp = require("sharp");
sharp.cache(false);

const W = 1080;
const H = 1920;
const FPS = 30;

function ffmpegPath() {
  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }
}

const escXml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// タイトル（場所・日付）。下の方に、細い線と小さな文字で控えめに
function titleSvg({ title, sub }) {
  const serif = "'Noto Serif CJK JP','Yu Mincho','YuMincho','Hiragino Mincho ProN',serif";
  const sans = "'Noto Sans CJK JP','Yu Gothic','Hiragino Sans',sans-serif";
  const size = Math.min(104, Math.floor(900 / (title.length * 1.08))); // 長いタイトルは小さく（画面からはみ出さないように）
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0.5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.6"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  ${sub ? `<text x="540" y="1380" text-anchor="middle" font-family="${sans}" font-size="30" letter-spacing="10" fill="#f3efe6" fill-opacity="0.85">${escXml(sub)}</text>` : ""}
  <text x="540" y="${1380 + 40 + size}" text-anchor="middle" font-family="${serif}" font-weight="600" font-size="${size}" letter-spacing="8" fill="#ffffff">${escXml(title)}</text>
  <rect x="505" y="${1380 + 90 + size}" width="70" height="2" fill="#c9a96a" fill-opacity="0.9"/>
  <text x="540" y="${1380 + 150 + size}" text-anchor="middle" font-family="${sans}" font-size="26" letter-spacing="12" fill="#f3efe6" fill-opacity="0.7">HAYATO NAOE</text>
</svg>`);
}

async function frame(src, dest) {
  // 主役が残る位置で 9:16 に切り抜く（寄る分の余白をとって少し大きめに）
  await sharp(fs.readFileSync(src)).rotate().resize(W * 2, H * 2, { fit: "cover", position: sharp.strategy.attention }).jpeg({ quality: 92 }).toFile(dest);
}

// 1拍の長さから、1枚あたりの拍数を決める（0.6〜0.9秒くらいがちょうどいい）
function beatsPerCut(bpm) {
  return Math.max(1, Math.round((0.75 * bpm) / 60));
}

// images: 写真のパス（8〜12枚がちょうどいい）。opts: { bpm, beats, title, sub }
async function makeReel(images, out, root, opts = {}) {
  const bpm = Math.min(Math.max(Number(opts.bpm) || 100, 50), 200);
  const beat = 60 / bpm;
  const per = Math.max(1, Number(opts.beats) || beatsPerCut(bpm));
  const tmp = path.join(path.dirname(out), "_frames");
  fs.mkdirSync(tmp, { recursive: true });
  const frames = [];
  for (const [i, src] of images.entries()) {
    const f = path.join(tmp, `${i}.jpg`);
    await frame(src, f);
    frames.push(f);
  }
  // 拍で区切る：1枚目は4拍（タイトル）→ 以降は per 拍ずつ → 最後の1枚は2拍のばす
  const lens = frames.map((_, i) => (i === 0 ? Math.max(4, per * 2) : i === frames.length - 1 ? per + 2 : per));
  const bounds = [0];
  for (const l of lens) bounds.push(bounds[bounds.length - 1] + l * beat);
  const nf = lens.map((_, i) => Math.round(bounds[i + 1] * FPS) - Math.round(bounds[i] * FPS));
  const total = bounds[bounds.length - 1];

  const titlePng = path.join(tmp, "title.png");
  if (opts.title) await sharp(titleSvg(opts)).png().toFile(titlePng);

  const args = ["-y"];
  frames.forEach((f, i) => args.push("-loop", "1", "-framerate", String(FPS), "-t", (nf[i] / FPS + 0.1).toFixed(3), "-i", f));
  if (opts.title) args.push("-loop", "1", "-framerate", String(FPS), "-t", (nf[0] / FPS + 0.1).toFixed(3), "-i", titlePng);
  args.push("-f", "lavfi", "-t", total.toFixed(3), "-i", "anullsrc=r=44100:cl=stereo");
  const ti = frames.length;
  const ai = frames.length + (opts.title ? 1 : 0);

  // 1枚目はゆっくり寄る。以降は拍の頭で少し大きく → すっと戻る（パンチイン）と、ゆっくり寄るを交互に
  const parts = frames.map((_, i) => {
    const N = nf[i];
    const z = i === 0 ? `1+0.06*on/${N}` : i % 2 ? `1.06-0.05*min(on/${Math.max(4, Math.round(N * 0.35))},1)` : `1+0.035*on/${N}`;
    return `[${i}:v]zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},trim=end_frame=${N},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[v${i}]`;
  });
  if (opts.title) {
    parts.push(`[${ti}:v]format=rgba,trim=end_frame=${nf[0]},setpts=PTS-STARTPTS,fade=t=in:st=0.25:d=0.6:alpha=1[t]`);
    parts.push(`[v0][t]overlay=0:0:shortest=1,format=yuv420p[v0t]`);
  }
  const ins = frames.map((_, i) => (i === 0 && opts.title ? "[v0t]" : `[v${i}]`)).join("");
  parts.push(`${ins}concat=n=${frames.length}:v=1:a=0[v]`);
  args.push("-filter_complex", parts.join(";"), "-map", "[v]", "-map", `${ai}:a`, "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-r", String(FPS), "-c:a", "aac", "-b:a", "128k", "-t", total.toFixed(3), "-movflags", "+faststart", out);
  execFileSync(ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 26 });
  // 表紙（1枚目＋タイトル）
  const cover = out.replace(/\.mp4$/, "-cover.jpg");
  const c = await sharp(frames[0]).resize(W, H).toBuffer();
  await sharp(c).composite(opts.title ? [{ input: titlePng }] : []).jpeg({ quality: 88 }).toFile(cover);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { seconds: +total.toFixed(2), bpm, beats: per, cover };
}

module.exports = { makeReel, beatsPerCut };
