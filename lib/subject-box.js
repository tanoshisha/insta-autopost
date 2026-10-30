// 写真の主役（被写体）がどこにあるかを AI に答えてもらう（切り抜きで見切れさせないため）
//   boxes(files) → { [file]: { box:[左,上,右,下]（幅・高さ=1）, centered:真ん中の構図か } }
//   主役＋大事な部分（人なら頭から足先・手、看板なら文字全体、建物なら上の端）を囲む
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");
sharp.cache(false);
const CLAUDE = path.join(process.env.USERPROFILE || "", ".local", "bin", "claude.exe");
const CACHE = path.join(__dirname, "..", ".work", "subject-boxes.json");

function ask(dir, names) {
  const prompt = `${names.map((n) => n).join("、")} を Read で1枚ずつ見てください。
それぞれの写真の「主役」と、切り抜いた時に欠けたら困る大事な部分（人なら頭のてっぺんから足先・手、看板やネオンなら文字全体、建物や塔なら上の端、動物なら全身）をまとめて囲む四角を、写真の幅・高さを1とした割合で答えてください。
主役が画面の左右の真ん中に置かれた構図（シンメトリー・正面の被写体など）なら centered を true に。
出力は次のJSONだけ：{"photos":[{"file":"1.jpg","box":[0.30,0.12,0.71,0.95],"centered":true}]}`;
  return new Promise((ok) => {
    const p = spawn(fs.existsSync(CLAUDE) ? CLAUDE : "claude", ["-p", "--allowedTools", "Read", "--output-format", "json", "--model", "claude-fable-5-1"], { cwd: dir });
    let out = "";
    const t = setTimeout(() => p.kill(), 8 * 60e3);
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => {
      clearTimeout(t);
      try {
        const m = (JSON.parse(out).result || "").match(/\{[\s\S]*\}/);
        ok(JSON.parse(m[0]).photos || []);
      } catch {
        ok([]);
      }
    });
    p.stdin.end(prompt);
  });
}

async function boxes(files) {
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
  const key = (f) => {
    const s = fs.statSync(f);
    return `${path.resolve(f)}|${s.size}`;
  };
  const todo = files.filter((f) => !cache[key(f)]);
  for (let i = 0; i < todo.length; i += 8) {
    const part = todo.slice(i, i + 8);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subj-"));
    try {
      const names = [];
      for (const [k, f] of part.entries()) {
        const n = `${k + 1}.jpg`;
        await sharp(f).rotate().resize(768, 768, { fit: "inside" }).jpeg({ quality: 80 }).toFile(path.join(dir, n));
        names.push(n);
      }
      for (const r of await ask(dir, names)) {
        const k = names.indexOf(String(r.file).trim());
        const b = (r.box || []).map(Number);
        if (k < 0 || b.length !== 4 || !b.every((v) => v >= -0.01 && v <= 1.01) || b[2] <= b[0] || b[3] <= b[1]) continue;
        cache[key(part[k])] = { box: b.map((v) => Math.min(1, Math.max(0, v))), centered: !!r.centered };
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.writeFileSync(CACHE, JSON.stringify(cache));
  }
  const out = {};
  for (const f of files) out[f] = cache[key(f)] || null;
  return out;
}
module.exports = { boxes };
