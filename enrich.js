// enrich.js — 予約中の写真に、タイトル（題名）・写真に合わせたハッシュタグ・説明文（alt）を付ける（タイトルがまだの分だけ）
//   文章（感想など）はAIでは書かない（本人がアプリで書く）
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
{"photos":[{"file":"p001.jpg","title":"…","tags":["#…"],"alt":"…"}]}`;
  return new Promise((resolve, reject) => {
    const p = spawn(fs.existsSync(CLAUDE) ? CLAUDE : "claude", ["-p", "--allowedTools", "Read", "--output-format", "json", "--model", cfg.aiModel || "sonnet"], { cwd: WORK });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => {
      try {
        if (code !== 0) throw new Error("AIに失敗");
        const j = JSON.parse(out);
        if (j.is_error || /limit/i.test(j.result || "") && !/{/.test(j.result || "")) throw new Error("AIが使えません: " + String(j.result).slice(0, 120));
        resolve(JSON.parse((j.result || "").match(/\{[\s\S]*\}/)[0]).photos || []);
      } catch (e) {
        reject(e);
      }
    });
    p.stdin.end(prompt);
  });
}

// キャプションが「冒頭（フォトウォーク）＋いつものタグ（＋写真のタグ）」だけなら、タイトルを差し込む。
//   自分で文章を書いた・タグを書き換えた写真は null（触らない）
function withTitle(caption, title, tags) {
  for (const base of [cfg.hashtags.portrait, cfg.hashtags.default]) {
    const i = caption.indexOf(base);
    if (i === -1) continue;
    const rest = caption.slice(i + base.length).trim();
    if (rest && !/^(#\S+\s*)+$/.test(rest)) continue;
    const head = caption.slice(0, i).trim();
    if (head && !/^東京フォトウォークサークル/.test(head)) return null; // 文章あり
    const have = rest ? rest.split(/s+/) : [];
    return buildCaption({ head, title, base, extra: have.length ? have : tags });
  }
  return null;
}

(async () => {
  git(["fetch", "-q", "origin", "main"]);
  const queue = JSON.parse(git(["show", "origin/main:queue.json"]));
  const todo = queue.filter((x) => !x.title && x.thumb && withTitle(x.caption || "", "仮の題名", []));
  console.log(`タイトルを付ける写真: ${todo.length}枚`);
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
    const r = await Promise.all(batches.slice(i, i + 3).map((b) => ask(b).catch((e) => (console.error("  " + e.message), []))));
    for (const list of r) for (const p of list) if (nameOf.has(p.file)) res[nameOf.get(p.file)] = p;
    console.log(`  …${Math.min(i + 3, batches.length)}/${batches.length}`);
  }
  for (const [id, p] of Object.entries(res).slice(0, 5)) console.log(`  ${id}: ${p.title}  ${(p.tags || []).join(" ")}`);
  if (DRY) return console.log("[お試し] 保存していません");
  let n = 0;
  makeSync(ROOT)(`予約中の写真にタイトルを追加`, [], (remote) => {
    const q = remote("queue.json", []).map((x) => {
      const p = res[x.id];
      if (!p || x.title || !p.title) return x;
      const cap = withTitle(x.caption || "", p.title, p.tags);
      if (!cap) return x; // その間にアプリで書き換えられた
      n++;
      return { ...x, title: p.title, alt: x.alt || p.alt || "", caption: cap };
    });
    return { "queue.json": q };
  });
  console.log(`✅ ${n}枚に付けました`);
})().catch((e) => {
  console.error("エラー: " + e.message);
  process.exit(1);
});
