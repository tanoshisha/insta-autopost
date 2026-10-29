// enrich.js — 予約中の写真に、AIの一言・写真に合わせたハッシュタグ・説明文（alt）を付ける（まだ付いていない分だけ）
//   node enrich.js [--dry]
//   ・キャプションを自分で書き換えた写真（いつものタグで終わっていないもの）は触らない
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const sharp = require("sharp");
sharp.cache(false);
const { makeSync } = require("./lib/sync");
const { buildCaption, CAPTION_RULES } = require("./lib/caption");

const ROOT = __dirname;
const DRY = process.argv.includes("--dry");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const WORK = path.join(ROOT, ".work", "enrich");
const CLAUDE = path.join(process.env.USERPROFILE || "", ".local", "bin", "claude.exe");
const git = (a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function ask(files) {
  const prompt = `あなたは写真家のInstagram運用担当です。カレントフォルダの次の写真を Read ツールで全部見てください:
${files.map((f) => "- " + f).join("\n")}

各写真について、投稿用に次を書いてください:
${CAPTION_RULES}

出力は次のJSONだけ（説明不要）:
{"photos":[{"file":"p001.jpg","line":"…","tags":["#…"],"alt":"…"}]}`;
  return new Promise((resolve, reject) => {
    const p = spawn(fs.existsSync(CLAUDE) ? CLAUDE : "claude", ["-p", "--allowedTools", "Read", "--output-format", "json", "--model", cfg.aiModel || "sonnet"], { cwd: WORK });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => {
      try {
        if (code !== 0) throw new Error("AIに失敗");
        resolve(JSON.parse((JSON.parse(out).result || "").match(/\{[\s\S]*\}/)[0]).photos || []);
      } catch (e) {
        reject(e);
      }
    });
    p.stdin.end(prompt);
  });
}

// いつものタグで終わるキャプションに、一言と追加のタグを差し込む
function withLine(caption, line, tags) {
  for (const base of [cfg.hashtags.portrait, cfg.hashtags.default]) {
    const i = caption.lastIndexOf(base);
    if (i === -1 || caption.slice(i + base.length).trim()) continue;
    return buildCaption({ head: caption.slice(0, i).trim(), line, base, extra: tags });
  }
  return null;
}

(async () => {
  git(["fetch", "-q", "origin", "main"]);
  const queue = JSON.parse(git(["show", "origin/main:queue.json"]));
  const todo = queue.filter((x) => !x.line && x.thumb);
  console.log(`一言を付ける写真: ${todo.length}枚`);
  if (!todo.length) return;
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const nameOf = new Map();
  for (const [i, x] of todo.entries()) {
    const f = `p${String(i + 1).padStart(3, "0")}.jpg`;
    nameOf.set(f, x.id);
    execFileSync("git", ["show", `origin/main:${x.thumb}`], { cwd: ROOT, stdio: ["ignore", fs.openSync(path.join(WORK, f), "w"), "pipe"] });
  }
  const files = [...nameOf.keys()];
  const batches = [];
  for (let i = 0; i < files.length; i += 20) batches.push(files.slice(i, i + 20));
  const res = {};
  for (let i = 0; i < batches.length; i += 3) {
    const r = await Promise.all(batches.slice(i, i + 3).map((b) => ask(b).catch(() => [])));
    for (const list of r) for (const p of list) if (nameOf.has(p.file)) res[nameOf.get(p.file)] = p;
    console.log(`  …${Math.min(i + 3, batches.length)}/${batches.length}`);
  }
  for (const [id, p] of Object.entries(res).slice(0, 5)) console.log(`  ${id}: ${p.line}  ${(p.tags || []).join(" ")}`);
  if (DRY) return console.log("[お試し] 保存していません");
  let n = 0;
  makeSync(ROOT)(`予約中の写真に一言・タグ・説明文を追加`, [], (remote) => {
    const q = remote("queue.json", []).map((x) => {
      const p = res[x.id];
      if (!p || x.line) return x;
      const cap = withLine(x.caption || "", p.line, p.tags);
      n++;
      return { ...x, line: p.line || "", alt: p.alt || x.alt || "", ...(cap ? { caption: cap } : {}) };
    });
    return { "queue.json": q };
  });
  console.log(`✅ ${n}枚に付けました`);
})().catch((e) => {
  console.error("エラー: " + e.message);
  process.exit(1);
});
