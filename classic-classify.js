// classic-classify.js — Lightroom Classic プラグインから呼ばれる。
//   フォルダ内の縮小JPEG（ファイル名=写真のID）をAIが見て、ポートレートかどうかと露光量の補正を決め、result.tsv に書く。
//   node classic-classify.js <フォルダ>
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const dir = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const BATCH = 30;
const CLAUDE = path.join(process.env.USERPROFILE || "", ".local", "bin", "claude.exe");

function ask(files) {
  const prompt = `あなたは写真家のレタッチ助手です。カレントフォルダの次の写真を Read ツールで全部見てください（まだレタッチしていない状態）:
${files.map((f) => "- " + f).join("\n")}

各写真について:
- portrait: 人物が主役のポートレートなら true（街並みの中の小さな人影・後ろ姿のスナップ・風景は false）
- ev: 露光量をあと何段上げ下げするか（-1.0〜+2.0、0.05刻み）。
  この写真家のレタッチは「ハイライトを強めに抑えて、シャドウを少し起こす」ので、その後で中間調がちょうど良く明るめに見える量にする。
  ポートレートは肌が明るく透明感のある明るさ（たいてい +0.4〜+1.0）。スナップは自然〜少し明るめ（たいてい +0.2〜+0.8）。夜景は暗さを残す。

出力は次のJSONだけ（説明不要）:
{"photos":[{"file":"123.jpg","portrait":false,"ev":0.5}]}`;
  return new Promise((resolve, reject) => {
    const p = spawn(fs.existsSync(CLAUDE) ? CLAUDE : "claude", ["-p", "--allowedTools", "Read", "--output-format", "json", "--model", cfg.aiModel || "sonnet"], { cwd: dir, shell: false });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill(), 20 * 60e3);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error("AI判定に失敗: " + (err || out).slice(0, 300));
        const m = (JSON.parse(out).result || "").match(/\{[\s\S]*\}/);
        resolve(JSON.parse(m[0]).photos || []);
      } catch (e) {
        reject(e);
      }
    });
    p.stdin.end(prompt);
  });
}

(async () => {
  const files = fs.readdirSync(dir).filter((f) => /\.jpg$/i.test(f));
  const batches = [];
  for (let i = 0; i < files.length; i += BATCH) batches.push(files.slice(i, i + BATCH));
  const rows = [];
  for (let i = 0; i < batches.length; i += 3) {
    const res = await Promise.all(batches.slice(i, i + 3).map(ask));
    for (const list of res) for (const r of list) rows.push(`${r.file.replace(/\.jpg$/i, "")}\t${r.portrait ? 1 : 0}\t${Number(r.ev) || 0}`);
  }
  fs.writeFileSync(path.join(dir, "result.tsv"), rows.join("\n") + "\n");
  fs.appendFileSync(path.join(dir, "..", "classify.log"), `${new Date().toISOString()} ${files.length}枚 → ${rows.length}件\n`);
})().catch((e) => {
  fs.appendFileSync(path.join(dir, "..", "classify.log"), `${new Date().toISOString()} エラー: ${e.message}\n`);
  process.exit(1);
});
