// リール用の動画を作る（写真 → 9:16。プロの編集の型で、最初の1秒で止めて、最後まで見せて、もう一度見たくなるように）
//   形式（opts.format）
//     dump     … つかみの一言 → 拍ごとにハードカット（ときどきウィップ）→ 最後は1枚目に戻ってループ
//     settings … 1枚ずつ撮影データ（85mm f/1.8 1/125s ISO3200）を下に出す。保存されやすい
//     quiz     … ぼかした1枚目に「ここ、どこか分かる？」→ ピントが合う → 何枚か見せて最後に「答え」
//   共通：拍（bpm）に合わせて切り替え・1枚ごとに寄る/引く/横に流れる・つかみの後に一瞬の白フラッシュ・薄いフィルム粒子
//   音は入れない（インスタのアプリで曲を付けて投稿する。曲ページからも見てもらえる）
//   ffmpeg は GitHub では起動時に apt で入れる（PC では ffmpeg-static を使う）
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sharp = require("sharp");
sharp.cache(false);

const W = 1080;
const H = 1920;
const FPS = 30;
const BIG = 1.6; // 寄る・流れる分の余白

function ffmpegPath() {
  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const SANS = "'Noto Sans CJK JP','Yu Gothic UI','Yu Gothic','Hiragino Sans',sans-serif";
const SERIF = "'Noto Serif CJK JP','Yu Mincho','YuMincho','Hiragino Mincho ProN',serif";

// 長い一言は2行に（句読点・スペースのところで）
function lines(text, max = 11) {
  const t = String(text || "").trim();
  if (t.includes("\n")) return t.split("\n").slice(0, 3);
  if (t.length <= max) return [t];
  const cut = [...t.matchAll(/[、。！？ 　]/g)].map((m) => m.index + 1).filter((i) => i >= 3 && i <= t.length - 2);
  const at = cut.sort((a, b) => Math.abs(a - t.length / 2) - Math.abs(b - t.length / 2))[0] || Math.ceil(t.length / 2);
  return [t.slice(0, at).trim(), t.slice(at).trim()];
}

const shadow = `<filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="10"/><feOffset dy="4"/><feComponentTransfer><feFuncA type="linear" slope="0.55"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;

// つかみの一言（画面の上の方・太字）＋小さい文字（場所・日付）
function hookSvg(hook, sub) {
  const ls = lines(hook);
  const size = Math.min(104, Math.floor(960 / Math.max(...ls.map((l) => l.length)) / 1.02));
  const y0 = 640;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${shadow}<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.45"/><stop offset="0.45" stop-color="#000" stop-opacity="0"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <g filter="url(#s)">
  ${ls.map((l, i) => `<text x="540" y="${y0 + i * size * 1.28}" text-anchor="middle" font-family="${SANS}" font-weight="bold" font-size="${size}" letter-spacing="2" fill="#fff" stroke="#000" stroke-opacity="0.35" stroke-width="3" paint-order="stroke">${esc(l)}</text>`).join("")}
  ${sub ? `<text x="540" y="${y0 + ls.length * size * 1.28 + 30}" text-anchor="middle" font-family="${SANS}" font-weight="500" font-size="32" letter-spacing="8" fill="#fff" fill-opacity="0.9">${esc(sub)}</text>` : ""}
  </g></svg>`;
}
// 撮影データ（下の方・カードなし）
function shotSvg(shot, place) {
  const txt = String(shot || "").split("／").filter(Boolean).join("   ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${shadow}<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0.62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.6"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <g filter="url(#s)">
  ${place ? `<text x="90" y="1560" font-family="${SANS}" font-weight="600" font-size="34" letter-spacing="4" fill="#fff" fill-opacity="0.85">${esc(place)}</text>` : ""}
  <text x="90" y="1640" font-family="${SANS}" font-weight="bold" font-size="50" letter-spacing="3" fill="#fff" stroke="#000" stroke-opacity="0.3" stroke-width="3" paint-order="stroke">${esc(txt)}</text>
  </g></svg>`;
}
// クイズの答え
function answerSvg(place) {
  const size = Math.min(110, Math.floor(900 / Math.max(1, place.length) / 1.02));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${shadow}<radialGradient id="g" cx="50%" cy="50%" r="60%"><stop offset="0" stop-color="#000" stop-opacity="0.45"/><stop offset="1" stop-color="#000" stop-opacity="0.1"/></radialGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <g filter="url(#s)"><text x="540" y="860" text-anchor="middle" font-family="${SANS}" font-weight="700" font-size="40" letter-spacing="14" fill="#fff" fill-opacity="0.9">答え</text>
  <text x="540" y="${900 + size}" text-anchor="middle" font-family="${SERIF}" font-weight="700" font-size="${size}" letter-spacing="6" fill="#fff">${esc(place)}</text></g></svg>`;
}
const png = (svg, file) => sharp(Buffer.from(svg)).png().toFile(file);

async function frame(src, dest, blurDest) {
  // 主役が残る位置で 9:16 に切り抜く（寄る分の余白をとって大きめに）
  const buf = await sharp(fs.readFileSync(src)).rotate().resize(Math.round(W * BIG), Math.round(H * BIG), { fit: "cover", position: sharp.strategy.attention }).jpeg({ quality: 94 }).toBuffer();
  fs.writeFileSync(dest, buf);
  if (blurDest) await sharp(buf).resize(W, H).blur(38).modulate({ brightness: 0.85 }).jpeg({ quality: 90 }).toFile(blurDest);
}

// 1拍の長さから、1枚あたりの拍数（0.45〜0.8秒くらい）
function beatsPerCut(bpm) {
  return Math.max(1, Math.round((0.6 * bpm) / 60));
}

// 1枚ごとの動き（寄る・引く・横に流れる）。N=その1枚のフレーム数
function motion(i, N, whipOut, whipIn) {
  const kinds = ["push", "pull", "panL", "push", "panR", "pull"];
  const k = i === 0 ? "push" : kinds[i % kinds.length];
  const p = `(on/${N})`;
  let z = { push: `1.04+0.07*${p}`, pull: `1.12-0.07*${p}`, panL: "1.12", panR: "1.12" }[k];
  let x = { push: "iw/2-(iw/zoom/2)", pull: "iw/2-(iw/zoom/2)", panL: `(iw-iw/zoom)*(0.85-0.7*${p})`, panR: `(iw-iw/zoom)*(0.15+0.7*${p})` }[k];
  // ウィップ：最後の3フレームで横に一気に流れる／次の1枚の最初の3フレームで流れ込む（ぶれで目立たない）
  if (whipOut) x = `${x}+if(gte(on,${N - 3}),(on-${N - 4})*iw*0.06,0)`;
  if (whipIn) x = `${x}-if(lt(on,3),(3-on)*iw*0.06,0)`;
  if (whipOut || whipIn) z = `(${z})+if(${whipOut ? `gte(on,${N - 3})` : "0"}+${whipIn ? "lt(on,3)" : "0"},0.1,0)`;
  return { z, x, y: "ih/2-(ih/zoom/2)" };
}

// items: [{ src, shot, place }] または パスの配列（8〜12枚）。opts: { format, hook, sub, bpm, beats, answer }
async function makeReel(items, out, root, opts = {}) {
  items = items.map((x) => (typeof x === "string" ? { src: x } : x));
  const format = opts.format || "dump";
  const bpm = Math.min(Math.max(Number(opts.bpm) || 100, 50), 200);
  const beat = 60 / bpm;
  const per = Math.max(1, Number(opts.beats) || (format === "settings" ? Math.max(2, beatsPerCut(bpm)) : beatsPerCut(bpm)));
  const tmp = path.join(path.dirname(out), "_frames");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  // 最後は1枚目に戻る（ループすると切れ目が分からない）
  const seq = [...items, { ...items[0], loop: true }];
  const frames = [];
  for (const [i, it] of seq.entries()) {
    const f = path.join(tmp, `${i}.jpg`);
    if (it.loop) fs.copyFileSync(frames[0], f);
    else await frame(it.src, f, i === 0 && format === "quiz" ? path.join(tmp, "blur.jpg") : null);
    frames.push(f);
  }
  // 拍で区切る：つかみ（1.4秒以上 / クイズは2.2秒以上）→ 本編は per 拍ずつ → クイズの答えは長め → ループの1枚は1拍
  const hookBeats = Math.max(2, Math.ceil((format === "quiz" ? 2.2 : 1.4) / beat));
  const ansAt = seq.length - 2;
  const lens = seq.map((it, i) => (i === 0 ? hookBeats : it.loop ? 1 : format === "quiz" && i === ansAt ? Math.max(per, Math.ceil(1.6 / beat)) : per));
  const bounds = [0];
  for (const l of lens) bounds.push(bounds[bounds.length - 1] + l * beat);
  const nf = lens.map((_, i) => Math.round(bounds[i + 1] * FPS) - Math.round(bounds[i] * FPS));
  const total = bounds[bounds.length - 1];

  // 重ねる文字
  const overlays = {};
  if (opts.hook) await png(hookSvg(opts.hook, format === "quiz" ? "" : opts.sub), (overlays[0] = path.join(tmp, "t0.png")));
  if (format === "settings")
    for (const [i, it] of seq.entries()) if (i > 0 && !it.loop && it.shot) await png(shotSvg(it.shot, it.place), (overlays[i] = path.join(tmp, `t${i}.png`)));
  if (format === "quiz" && opts.answer) await png(answerSvg(opts.answer), (overlays[ansAt] = path.join(tmp, "ans.png")));

  const args = ["-y"];
  frames.forEach((f, i) => args.push("-loop", "1", "-framerate", String(FPS), "-t", (nf[i] / FPS + 0.2).toFixed(3), "-i", f));
  let nextIn = frames.length;
  const addInput = (file, dur) => {
    args.push("-loop", "1", "-framerate", String(FPS), "-t", (dur + 0.2).toFixed(3), "-i", file);
    return nextIn++;
  };
  const blurIdx = format === "quiz" ? addInput(path.join(tmp, "blur.jpg"), nf[0] / FPS) : -1;
  const ovIdx = {};
  for (const [i, f] of Object.entries(overlays)) ovIdx[i] = addInput(f, nf[i] / FPS);
  args.push("-f", "lavfi", "-t", total.toFixed(3), "-i", "anullsrc=r=44100:cl=stereo");
  const ai = nextIn;

  // ウィップは本編の4枚ごと（つかみの直後は白フラッシュ）
  const whip = (i) => i >= 2 && i < seq.length - 1 && i % 4 === 0;
  const parts = [];
  frames.forEach((_, i) => {
    const N = nf[i];
    const wOut = whip(i + 1);
    const wIn = whip(i);
    const m = motion(i, N, wOut, wIn);
    let chain = `[${i}:v]zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=1:s=${W}x${H}:fps=${FPS},trim=end_frame=${N},setpts=PTS-STARTPTS`;
    if (wOut) chain += `,avgblur=sizeX=48:sizeY=1:enable='gte(n,${N - 3})'`;
    if (wIn) chain += `,avgblur=sizeX=48:sizeY=1:enable='lt(n,3)'`;
    if (i === 1) chain += `,eq=brightness=0.35:enable='lt(n,2)'`; // つかみの後の白フラッシュ
    parts.push(`${chain},setsar=1,format=yuv420p[c${i}]`);
    let cur = `c${i}`;
    if (i === 0 && blurIdx >= 0) {
      // クイズ：ぼけた状態から1秒でピントが合う
      const hold = Math.min(0.8, (N / FPS) * 0.35);
      parts.push(`[${blurIdx}:v]format=rgba,trim=end_frame=${N},setpts=PTS-STARTPTS,fade=t=out:st=${hold.toFixed(2)}:d=1.0:alpha=1[bl]`);
      parts.push(`[${cur}][bl]overlay=0:0:shortest=1,format=yuv420p[q0]`);
      cur = "q0";
    }
    if (ovIdx[i] !== undefined) {
      const slide = i === 0 ? `y='max(0,60-t*260)'` : "y=0";
      parts.push(`[${ovIdx[i]}:v]format=rgba,trim=end_frame=${N},setpts=PTS-STARTPTS,fade=t=in:st=${i === 0 ? 0.12 : 0}:d=${i === 0 ? 0.3 : 0.15}:alpha=1[o${i}]`);
      parts.push(`[${cur}][o${i}]overlay=x=0:${slide}:shortest=1,format=yuv420p[t${i}]`);
      cur = `t${i}`;
    }
    parts.push(`[${cur}]null[v${i}]`);
  });
  parts.push(`${frames.map((_, i) => `[v${i}]`).join("")}concat=n=${frames.length}:v=1:a=0,noise=alls=5:allf=t,vignette=angle=PI/7,format=yuv420p[v]`);
  args.push("-filter_complex", parts.join(";"), "-map", "[v]", "-map", `${ai}:a`, "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(FPS), "-c:a", "aac", "-b:a", "128k", "-t", total.toFixed(3), "-movflags", "+faststart", out);
  execFileSync(ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 26 });

  // 表紙（1枚目＋つかみの一言。グリッドで目立つように）
  const cover = out.replace(/\.mp4$/, "-cover.jpg");
  const c = await sharp(frames[0]).resize(W, H).toBuffer();
  await sharp(c)
    .composite(overlays[0] ? [{ input: overlays[0] }] : [])
    .jpeg({ quality: 88 })
    .toFile(cover);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { seconds: +total.toFixed(2), bpm, beats: per, cover };
}

module.exports = { makeReel, beatsPerCut };
