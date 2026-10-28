// tpw-blog.js — Lightroom Classic の「東京フォトウォークサークル（ブログ）」の写真から、TPWサイトの活動記録（下書き）を作る
//   node tpw-blog.js events                 … 活動記録を作れる回の一覧 → classic-tpw-events.tsv（プラグインがコレクションを用意する）
//   node tpw-blog.js publish <日付> <フォルダ> … フォルダ内の写真（<UUID>.jpg）で活動記録を作る/写真を足す → git push
//     ・新しい記事は「下書き」で作る（CMSで確認して下書きをオフにすると公開）
//     ・写真の説明（alt）・ファイル名・タイトル・本文はAIが過去の記事と同じ調子で書く
//     ・終わった写真のUUIDを <フォルダ>/done.tsv に書く
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const sharp = require("sharp");
sharp.cache(false);

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const TPW = path.resolve(cfg.tpwEventsDir, "..", "..");
const CLAUDE = path.join(process.env.USERPROFILE || "", ".local", "bin", "claude.exe");
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const nowStr = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
const git = (args) => execFileSync("git", args, { cwd: TPW, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function loadEvents() {
  const { build } = await import("file:///" + path.join(TPW, "scripts", "build.mjs").replace(/\\/g, "/"));
  return build({ write: false }).events;
}

async function cmdEvents() {
  const events = (await loadEvents()).filter((e) => e.status !== "cancelled" && e.date <= today && e.date >= new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10));
  const rows = events.map((e) => `${e.date}\t${e.vol}\t${e.title}`);
  fs.writeFileSync(path.join(ROOT, "classic-tpw-events.tsv"), rows.join("\n") + "\n");
  console.log(`活動記録を作れる回: ${rows.length}件`);
}

function askAI(prompt, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(fs.existsSync(CLAUDE) ? CLAUDE : "claude", ["-p", "--allowedTools", "Read", "--output-format", "json", "--model", cfg.retouchModel || "opus"], { cwd });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      try {
        if (code !== 0) throw new Error("AIに失敗: " + (err || out).slice(0, 300));
        const m = (JSON.parse(out).result || "").match(/\{[\s\S]*\}/);
        resolve(JSON.parse(m[0]));
      } catch (e) {
        reject(e);
      }
    });
    p.stdin.end(prompt);
  });
}

async function cmdPublish(date, dir) {
  const events = await loadEvents();
  const e = events.find((x) => x.date === date);
  if (!e) throw new Error(`${date} の開催回が見つかりません`);
  try {
    git(["pull", "-q", "--rebase"]);
  } catch {}
  const logPath = path.join(TPW, "data", "logs", `${date}.json`);
  const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, "utf8")) : null;
  // 並び順＝撮影順（プラグインが order.tsv に書く）
  const order = fs.existsSync(path.join(dir, "order.tsv"))
    ? fs.readFileSync(path.join(dir, "order.tsv"), "utf8").trim().split(/\r?\n/).map((l) => l.split("\t")[0])
    : [];
  const files = fs.readdirSync(dir).filter((f) => /\.jpg$/i.test(f)).sort((a, b) => order.indexOf(a.replace(/\.jpg$/i, "")) - order.indexOf(b.replace(/\.jpg$/i, "")));
  if (!files.length) return console.log("写真がありません");

  // AIに見せる用の小さい画像
  const view = path.join(dir, "view");
  fs.mkdirSync(view, { recursive: true });
  for (const [i, f] of files.entries()) await sharp(fs.readFileSync(path.join(dir, f))).resize({ width: 900, height: 900, fit: "inside" }).jpeg({ quality: 75 }).toFile(path.join(view, `p${String(i + 1).padStart(2, "0")}.jpg`));
  const viewNames = files.map((_, i) => `p${String(i + 1).padStart(2, "0")}.jpg`);

  // 過去の記事を2つお手本に
  const samples = fs
    .readdirSync(path.join(TPW, "data", "logs"))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== `${date}.json`)
    .sort()
    .slice(-2)
    .map((f) => JSON.parse(fs.readFileSync(path.join(TPW, "data", "logs", f), "utf8")))
    .map((l) => `タイトル: ${l.title}\n本文: ${l.body}\n写真の説明の例: ${(l.photos || []).slice(0, 4).map((p) => p.alt).join(" / ")}\nファイル名の例: ${(l.photos || []).slice(0, 3).map((p) => p.src).join(" ")}`)
    .join("\n\n");
  const prompt = `あなたは「東京フォトウォークサークル」の運営者として、サイトの活動記録（ブログ）を書きます。
開催回: 第${e.vol}回 ${e.title}（${e.date}・${e.place || ""}）
テーマ: ${e.theme || e.note || ""}

カレントフォルダの写真を Read ツールで全部見てください（当日撮った写真・この順に記事に載ります）:
${viewNames.join(" ")}

${log ? `この回の記事はすでにあります（タイトル「${log.title}」）。今回は追加の写真の説明とファイル名だけ作ってください。` : "この回の記事を新しく書いてください。"}

【お手本（過去の記事）】
${samples}

ルール:
- 写真の説明（alt）: 写っているものを具体的に1文（30〜45字・体言止め）。検索や読み上げに使う。参加者は「参加者」と書く（名前は出さない）。
- ファイル名用の英語スラッグ: 写っている物を英小文字とハイフンで1〜3語（例: kaminarimon, pumpkin-steps）。
- 場所スラッグ: 開催場所のローマ字（英小文字、例: asakusa, tama, nezu）。
${log ? "" : `- タイトル: お手本のように、場所と見どころが伝わる明るい一文（30字前後・「！」可）。
- 本文: お手本と同じ調子で「第${e.vol}回は〜へ。」から始め、写真に写っている見どころを順に織り込み、最後は「ご参加いただいたみなさん、ありがとうございました！」。250〜400字、必要なら空行で2段落。写真に写っていないことは書かない。
- タグ: 場所名1語。`}

出力は次のJSONだけ（説明やコードブロック不要）:
{"place":"asakusa",${log ? "" : '"title":"…","body":"…","tag":"…",'}"photos":[{"file":"p01.jpg","slug":"kaminarimon","alt":"…"}]}`;
  const ai = await askAI(prompt, view);
  const info = Object.fromEntries((ai.photos || []).map((p) => [p.file, p]));
  const place = String(ai.place || log?.photos?.[0]?.src?.match(/images\/([a-z0-9]+)-vol/)?.[1] || "tpw").replace(/[^a-z0-9]/g, "") || "tpw";

  // 4:5（1280×1600）に揃えてサイトの images へ
  const photos = [];
  const used = new Set(fs.readdirSync(path.join(TPW, "images")));
  const done = [];
  for (const [i, f] of files.entries()) {
    const p = info[viewNames[i]] || {};
    let base = `${place}-vol${e.vol}-${String(p.slug || "photo").toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "") || "photo"}`;
    let name = `${base}.jpg`;
    for (let k = 2; used.has(name); k++) name = `${base}-${k}.jpg`;
    used.add(name);
    await sharp(fs.readFileSync(path.join(dir, f)))
      .rotate()
      .resize(1280, 1600, { fit: "cover", position: sharp.strategy.attention })
      .toColorspace("srgb")
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(path.join(TPW, "images", name));
    photos.push({ src: `images/${name}`, alt: p.alt || `${e.title}の様子` });
    done.push(f.replace(/\.jpg$/i, ""));
  }

  const out = log
    ? { ...log, updated: nowStr(), photos: [...(log.photos || []), ...photos] }
    : { draft: true, updated: nowStr(), date: e.date, title: ai.title || e.title, body: ai.body || "", tag: ai.tag || e.place || "", photos };
  fs.writeFileSync(logPath, JSON.stringify(out, null, 2) + "\n");
  git(["add", "--", `data/logs/${date}.json`, ...photos.map((p) => p.src)]);
  git(["-c", "user.name=tanoshisha", "-c", "user.email=tanoshisha@gmail.com", "commit", "-q", "-m", `活動記録${out.draft ? "（下書き）" : ""}：第${e.vol}回 ${e.title}（写真${photos.length}枚${log ? "を追加" : ""}）`]);
  for (let i = 0; i < 3; i++) {
    try {
      git(["pull", "-q", "--rebase"]);
      git(["push", "-q"]);
      break;
    } catch (err) {
      if (i === 2) throw err;
    }
  }
  fs.writeFileSync(path.join(dir, "done.tsv"), done.join("\n") + "\n");
  console.log(`✅ 第${e.vol}回の活動記録に写真${photos.length}枚${log ? "を追加" : "で下書きを作成"}しました`);
}

const [cmd, a1, a2] = process.argv.slice(2);
(cmd === "events" ? cmdEvents() : cmd === "publish" ? cmdPublish(a1, a2) : Promise.reject(new Error("使い方: node tpw-blog.js events | publish <日付> <フォルダ>"))).catch((e) => {
  fs.appendFileSync(path.join(ROOT, ".work", "tpw-blog.log"), `${new Date().toISOString()} エラー: ${e.message}\n`);
  console.error("エラー: " + e.message);
  process.exit(1);
});
