// classic-ai-retouch.js — Lightroom Classic プラグインから呼ばれる「AIレタッチ」。
//   node classic-ai-retouch.js plan   <フォルダ>  … 未レタッチの写真を見て、1枚ずつ現像設定を決める
//   node classic-ai-retouch.js review <フォルダ>  … レタッチ後の写真を見て、仕上げの修正を決める
// フォルダ: <ID>.jpg（Lightroomのプレビュー）と、review では <ID>.cur（今の設定 Key=Value）
// 出力: result.tsv … ID \t P|S \t Key=Value;Key=Value…（プラグインがそのまま当てる）
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");
sharp.cache(false);

const [mode, dir] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const MODEL = cfg.retouchModel || "opus";
const CLAUDE = path.join(process.env.USERPROFILE || "", ".local", "bin", "claude.exe");
const BATCH = 6; // 1回に見る枚数（1枚ずつじっくり見られるよう少なめ）

// 当ててよい項目と範囲（AIが極端な値を出しても安全な範囲に収める）
const RANGE = {
  Exposure2012: [-2, 3], Contrast2012: [-40, 70], Highlights2012: [-100, 20], Shadows2012: [-40, 80],
  Whites2012: [-80, 50], Blacks2012: [-80, 20], Texture: [-40, 50], Clarity2012: [-40, 50], Dehaze: [-20, 40],
  Vibrance: [-30, 50], Saturation: [-40, 25], TempDelta: [-1500, 1500], TintDelta: [-25, 25],
  PostCropVignetteAmount: [-40, 10],
  SplitToningShadowHue: [0, 359], SplitToningShadowSaturation: [0, 40], SplitToningHighlightHue: [0, 359],
  SplitToningHighlightSaturation: [0, 40], SplitToningBalance: [-60, 60],
  ParametricShadows: [-40, 40], ParametricDarks: [-40, 40], ParametricLights: [-40, 40], ParametricHighlights: [-40, 40],
};
for (const c of ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"]) {
  RANGE[`HueAdjustment${c}`] = [-40, 40];
  RANGE[`SaturationAdjustment${c}`] = [-60, 40];
  RANGE[`LuminanceAdjustment${c}`] = [-50, 50];
}

// 白飛び・黒つぶれ・明るさの分布を数字で測る（AIの目だけに頼らない）
async function stats(file) {
  const { data, info } = await sharp(file).resize({ width: 600, withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const lum = new Uint32Array(256);
  let clipHi = 0, clipLo = 0, sum = 0, sat = 0;
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    lum[y]++;
    sum += y;
    if (r >= 250 || g >= 250 || b >= 250) clipHi++;
    if (r <= 4 && g <= 4 && b <= 4) clipLo++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    sat += mx ? (mx - mn) / mx : 0;
  }
  const pct = (p) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += lum[v]) >= n * p) return v;
    return 255;
  };
  return {
    白飛び: (clipHi / n * 100).toFixed(2) + "%",
    黒つぶれ: (clipLo / n * 100).toFixed(2) + "%",
    平均輝度: Math.round(sum / n),
    "輝度1%/50%/99%": `${pct(0.01)}/${pct(0.5)}/${pct(0.99)}`,
    平均彩度: (sat / n).toFixed(2),
  };
}

const STYLE = `【この写真家のいつもの仕上がり（約300枚の実データ）】
- ポートレート: コントラスト0・ハイライト-100・シャドウ+25・黒-20・テクスチャ/明瞭度0、カラーグレーディング シャドウ色相200彩度17／ハイライト色相33彩度14、肌はやわらかく（顔の肌マスクは別で入る）。明るく透明感、少し暖かい。
- スナップ: コントラスト+20・ハイライト-20・シャドウ+10・黒-20・テクスチャ/明瞭度+25、カラーグレーディング シャドウ色相214彩度23／ハイライト色相23彩度23。街の質感とメリハリ。
- 露光量は撮って出しから平均+0.6前後上げている。`;

const GOAL = `【目標】Instagramのフィードで指が止まる、作品として最高品質の仕上がり。凄腕のプロのレタッチャーとして判断する。
- 白飛びさせない（空・肌・白い服・ネオンの階調を残す）。黒は締めるがつぶさない。
- スマホの小さい画面で映えるメリハリ（中間調のコントラスト・適度な明瞭度/テクスチャ）。ただしHDRっぽい不自然さ・ハロ・過剰な彩度はNG。
- 色: 肌は健康的で自然（オレンジの彩度/輝度で整える）。空の青は濁らせず、緑は少し落ち着かせると上品。全体の色はこの写真家のカラーグレーディングの方向性を活かしつつ、その写真に合う強さに。
- 主題に目がいく光の流れ（必要なら周辺を少し落とす）。夜景は暗さと光の美しさを残す。
- 写真ごとに最適化する（同じ値を機械的に当てない）。`;

const KEYS = `【使える項目】（すべて「最終的な値」で指定。TempDelta/TintDeltaだけは今の色温度/色かぶりからの差）
Exposure2012, Contrast2012, Highlights2012, Shadows2012, Whites2012, Blacks2012, Texture, Clarity2012, Dehaze, Vibrance, Saturation,
TempDelta(K), TintDelta, PostCropVignetteAmount(負で周辺減光),
ParametricShadows/Darks/Lights/Highlights（トーンカーブ）,
HueAdjustment{Red,Orange,Yellow,Green,Aqua,Blue,Purple,Magenta}, SaturationAdjustment{同}, LuminanceAdjustment{同},
SplitToningShadowHue, SplitToningShadowSaturation, SplitToningHighlightHue, SplitToningHighlightSaturation, SplitToningBalance`;

function prompt(files, info) {
  const lines = files.map((f) => `- ${f}  測定値: ${JSON.stringify(info[f].stats)}${info[f].cur ? `\n  今の設定: ${info[f].cur}` : ""}`).join("\n");
  if (mode === "plan")
    return `${GOAL}

${STYLE}

カレントフォルダの次の写真を Read ツールで1枚ずつじっくり見てください（まだレタッチ前のRAWの見た目。露光量は撮影時のまま）:
${lines}

各写真について:
1. portrait（人物が主役なら true。街並みの小さな人影・後ろ姿のスナップは false）
2. その写真に最適な現像設定を決める（Exposure2012 は「最終的な露光量」。今は0付近）

${KEYS}

出力は次のJSONだけ（説明やコードブロック不要）:
{"photos":[{"file":"123.jpg","portrait":false,"note":"何をどう狙ったか一言","settings":{"Exposure2012":0.6,"Contrast2012":20}}]}`;
  return `${GOAL}

カレントフォルダの次の写真は、あなたが前回決めた設定でレタッチした結果です。Read ツールで1枚ずつ厳しくチェックしてください:
${lines}

プロの目で、作品として最高品質になっているか確認し、直すべき所だけ修正値を出してください
（白飛び・黒つぶれ・眠さ・やりすぎ・色かぶり・肌色・空の色・主題の目立ち方）。問題がなければ settings は空でよい。

${KEYS}

出力は次のJSONだけ（説明やコードブロック不要）:
{"photos":[{"file":"123.jpg","note":"何を直したか一言","settings":{"Highlights2012":-80}}]}`;
}

function ask(files, info) {
  return new Promise((resolve, reject) => {
    const p = spawn(fs.existsSync(CLAUDE) ? CLAUDE : "claude", ["-p", "--allowedTools", "Read", "--output-format", "json", "--model", MODEL], { cwd: dir });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill(), 25 * 60e3);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error("AIレタッチに失敗: " + (err || out).slice(0, 300));
        const m = (JSON.parse(out).result || "").match(/\{[\s\S]*\}/);
        resolve(JSON.parse(m[0]).photos || []);
      } catch (e) {
        reject(e);
      }
    });
    p.stdin.end(prompt(files, info));
  });
}

function clean(settings) {
  const out = [];
  for (const [k, v] of Object.entries(settings || {})) {
    const r = RANGE[k];
    const x = Number(v);
    if (!r || !isFinite(x)) continue;
    const c = Math.min(r[1], Math.max(r[0], x));
    out.push(`${k}=${k === "Exposure2012" ? c.toFixed(2) : Math.round(c)}`);
  }
  return out.join(";");
}

(async () => {
  const files = fs.readdirSync(dir).filter((f) => /\.jpg$/i.test(f));
  const info = {};
  for (const f of files) {
    const cur = path.join(dir, f.replace(/\.jpg$/i, ".cur"));
    info[f] = { stats: await stats(path.join(dir, f)), cur: fs.existsSync(cur) ? fs.readFileSync(cur, "utf8").trim().replace(/\r?\n/g, ", ") : null };
  }
  const batches = [];
  for (let i = 0; i < files.length; i += BATCH) batches.push(files.slice(i, i + BATCH));
  const rows = [];
  const notes = [];
  for (let i = 0; i < batches.length; i += 3) {
    const res = await Promise.all(batches.slice(i, i + 3).map((b) => ask(b, info)));
    for (const list of res)
      for (const r of list) {
        const id = String(r.file).replace(/\.jpg$/i, "");
        rows.push(`${id}\t${r.portrait ? "P" : "S"}\t${clean(r.settings)}`);
        notes.push(`${mode} ${id} ${r.portrait ? "[P]" : ""} ${r.note || ""} | ${clean(r.settings)}`);
      }
  }
  fs.writeFileSync(path.join(dir, "result.tsv"), rows.join("\n") + "\n");
  fs.appendFileSync(path.join(dir, "..", "retouch.log"), `${new Date().toISOString()} ${mode} ${files.length}枚\n${notes.join("\n")}\n`);
})().catch((e) => {
  fs.appendFileSync(path.join(dir, "..", "retouch.log"), `${new Date().toISOString()} エラー: ${e.message}\n`);
  process.exit(1);
});
