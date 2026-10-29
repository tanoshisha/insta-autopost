// リール用の動画を作る（写真 → 9:16 のスライドショー。ゆっくりズーム＋フェードでつなぐ）
//   ・写真はぼかした同じ写真の上に置く（縦横比がバラバラでも黒帯なし）
//   ・assets/music/*.mp3 があればランダムに1曲（なければ無音）
//   ・ffmpeg は GitHub の実行環境に最初から入っている（PC では ffmpeg-static があれば使う）
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sharp = require("sharp");
sharp.cache(false);

const SEC = 3; // 1枚あたりの秒数
const FADE = 0.5; // つなぎのフェード
const W = 1080;
const H = 1920;

function ffmpegPath() {
  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }
}

async function frame(src, dest) {
  const buf = fs.readFileSync(src);
  const bg = await sharp(buf).resize(W, H, { fit: "cover" }).blur(40).modulate({ brightness: 0.55 }).toBuffer();
  const fg = await sharp(buf).resize(1000, 1500, { fit: "inside" }).toBuffer();
  const m = await sharp(fg).metadata();
  await sharp(bg)
    .composite([{ input: fg, left: Math.round((W - m.width) / 2), top: Math.round((H - m.height) / 2) - 40 }])
    .jpeg({ quality: 92 })
    .toFile(dest);
}

// images: 写真のパス（4〜8枚がちょうどいい）。out: 出力する mp4
async function makeReel(images, out, root) {
  const tmp = path.join(path.dirname(out), "_frames");
  fs.mkdirSync(tmp, { recursive: true });
  const frames = [];
  for (const [i, src] of images.entries()) {
    const f = path.join(tmp, `${i}.jpg`);
    await frame(src, f);
    frames.push(f);
  }
  const n = frames.length;
  const total = n * SEC - (n - 1) * FADE;
  const args = ["-y"];
  for (const f of frames) args.push("-loop", "1", "-framerate", "30", "-t", String(SEC), "-i", f);
  const music = fs.existsSync(path.join(root, "assets", "music")) ? fs.readdirSync(path.join(root, "assets", "music")).filter((x) => /\.(mp3|m4a|aac)$/i.test(x)) : [];
  if (music.length) args.push("-i", path.join(root, "assets", "music", music[Math.floor(Math.random() * music.length)]));
  else args.push("-f", "lavfi", "-t", String(total), "-i", "anullsrc=r=44100:cl=stereo");
  // 1枚ずつゆっくりズーム（交互にズームイン／アウト）→ フェードでつなぐ
  const parts = frames.map((_, i) => {
    const z = i % 2 ? "1.07-0.0007*on" : "1+0.0007*on";
    return `[${i}:v]scale=${W * 2}:${H * 2},zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=30,setsar=1,format=yuv420p[v${i}]`;
  });
  let last = "v0";
  for (let i = 1; i < n; i++) {
    const o = (SEC - FADE) * i;
    parts.push(`[${last}][v${i}]xfade=transition=fade:duration=${FADE}:offset=${o.toFixed(2)}[x${i}]`);
    last = `x${i}`;
  }
  parts.push(`[${n}:a]afade=t=in:st=0:d=1,afade=t=out:st=${(total - 1.5).toFixed(2)}:d=1.5,atrim=0:${total.toFixed(2)}[a]`);
  args.push("-filter_complex", parts.join(";"), "-map", `[${last}]`, "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "128k", "-t", total.toFixed(2), "-movflags", "+faststart", out);
  execFileSync(ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 26 });
  fs.rmSync(tmp, { recursive: true, force: true });
  return { seconds: total };
}

module.exports = { makeReel };
