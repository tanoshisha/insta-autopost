// plan.js — 候補写真を集めて、AIが選定・並べ替え → 投稿キュー（queue.json + queue/*.jpg）に追加する。PCで実行。
//   候補の入れ方: ① Lightroom（クラウド）のアルバム「インスタ投稿」に入れる
//                 ② Lightroom Classic から inbox/ フォルダへ書き出す（どちらでもOK・併用OK）
//   node plan.js        … 実行して GitHub に反映（→ クラウドが毎日投稿）
//   node plan.js --dry  … お試し（GitHubへ送らない・inbox を消さない）
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const sharp = require("sharp");
const exifr = require("exifr");
const { pullAlbum } = require("./lib/lightroom");
const { loadEvents, jstDate, eventPlaceName, reverseGeocode, findLocationId } = require("./lib/places");

const ROOT = __dirname;
const DRY = process.argv.includes("--dry");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const INBOX = path.join(ROOT, "inbox");
const WORK = path.join(ROOT, ".work");
const QDIR = DRY ? path.join(WORK, "preview") : path.join(ROOT, "queue");
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
  } catch {
    return d;
  }
};
const writeJson = (f, v) => fs.writeFileSync(path.join(ROOT, f), JSON.stringify(v, null, 2) + "\n");
const secrets = readJson("secrets.local.json", {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IMG = /\.(jpe?g|png|webp|tiff?|heic)$/i;

async function collect(state) {
  const items = [];
  // ① Lightroom クラウドのアルバム
  if (cfg.lightroom?.albumName && fs.existsSync(cfg.lightroom.configPath)) {
    console.log(`Lightroom「${cfg.lightroom.albumName}」を確認…`);
    try {
      const got = await pullAlbum({
        configPath: cfg.lightroom.configPath,
        albumName: cfg.lightroom.albumName,
        outDir: WORK,
        doneIds: new Set(state.lrDone),
      });
      for (const g of got) items.push({ ...g, source: "lightroom" });
    } catch (e) {
      console.log("  ⚠ " + e.message);
      if (e.code === "LR_AUTH") fs.writeFileSync(path.join(ROOT, "要対応_Lightroom再ログイン.txt"), e.message + "\n");
    }
  }
  // ② inbox フォルダ
  for (const f of fs.readdirSync(INBOX).filter((f) => IMG.test(f))) {
    items.push({ file: path.join(INBOX, f), source: "inbox" });
  }
  // EXIF（撮影日・GPS）と重複チェック
  const seen = new Set(state.hashes);
  const out = [];
  for (const it of items) {
    const buf = fs.readFileSync(it.file);
    it.hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);
    if (seen.has(it.hash)) {
      if (it.source === "lightroom") state.lrDone.push(it.lrId);
      continue;
    }
    seen.add(it.hash);
    try {
      const ex = await exifr.parse(buf, { gps: true });
      if (ex) {
        it.takenAt = it.takenAt || ex.DateTimeOriginal || ex.CreateDate || null;
        if (!it.gps && typeof ex.latitude === "number") it.gps = { lat: ex.latitude, lng: ex.longitude };
      }
    } catch {}
    out.push(it);
  }
  return out;
}

// ---- AI選定（このPCの claude コマンドを使う） ----
function aiSelect(batch, recent) {
  const lines = batch.map((it) => `- ${it.thumb}（撮影日 ${it.date || "不明"}${it.event ? `・${it.event.title}` : ""}）`).join("\n");
  const prompt = `あなたは写真家のInstagramアカウントの編集者です。カレントフォルダにある次の候補写真を Read ツールで全部見てください。
写真家本人がある程度絞った候補なので、基本は「使う」方向で判断します。

${lines}

直前に投稿予定の写真: ${recent.length ? recent.join(" / ") : "なし"}

各写真について判断:
- use: ほぼ同じ構図・連写の重複は一番良い1枚だけ true、他は false。明らかなピンボケ・失敗写真も false。それ以外は true。
- portrait: 人物が主役のポートレートなら true（街並みの中の小さな人影・後ろ姿のスナップは false）。
- focusY: 縦長写真を4:5に上下トリミングする時に残したい中心の縦位置（0=上端, 0.5=中央, 1=下端）。顔や主題が切れない値に。
- note: 一言の理由。

order: use=true の写真を並べたもの（順番は気にしなくてよい。投稿は撮影日時の古い順になる）。

出力は次のJSONだけ（説明文やコードブロック不要）:
{"photos":[{"file":"t001.jpg","use":true,"portrait":false,"focusY":0.5,"note":"…"}],"order":["t001.jpg"]}`;
  return new Promise((resolve, reject) => {
    const p = spawn("claude", ["-p", "--allowedTools", "Read", "--output-format", "json", "--model", cfg.aiModel || "sonnet"], { cwd: WORK });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill(), 30 * 60e3);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error("AI選定に失敗: " + (err || out).slice(0, 400));
        const text = JSON.parse(out).result || "";
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) throw new Error("AIの返答を読めませんでした: " + text.slice(0, 300));
        resolve(JSON.parse(m[0]));
      } catch (e) {
        reject(e);
      }
    });
    p.stdin.end(prompt);
  });
}

// ---- 投稿用画像（4:5〜1.91:1 に収めて長辺調整・メタデータ除去） ----
async function makePostImage(src, dest, focusY = 0.5) {
  const base = sharp(src).rotate();
  const buf = await base.toBuffer();
  const { width: w, height: h } = await sharp(buf).metadata();
  let crop = null;
  if (w / h < 0.8) {
    const ch = Math.round(w / 0.8);
    const top = Math.min(Math.max(Math.round(focusY * h - ch / 2), 0), h - ch);
    crop = { left: 0, top, width: w, height: ch };
  } else if (w / h > 1.91) {
    const cw = Math.round(h * 1.91);
    crop = { left: Math.round((w - cw) / 2), top: 0, width: cw, height: h };
  }
  let img = sharp(buf);
  if (crop) img = img.extract(crop);
  await img
    .resize({ width: cfg.image.width, withoutEnlargement: true })
    .toColorspace("srgb")
    .jpeg({ quality: cfg.image.quality, mozjpeg: true })
    .toFile(dest);
}

function caption(it, portrait) {
  const tags = portrait ? cfg.hashtags.portrait : cfg.hashtags.default;
  if (!it.event) return tags;
  const head = cfg.tpwHeader.replace("{vol}", it.event.vol).replace("{title}", it.event.title);
  return `${head}\n\n${tags}`;
}

function sortQueue(q) {
  const key = (it) => it.takenAt || (it.date ? it.date + "T12:00:00.000Z" : "9999");
  q.sort((a, b) => key(a).localeCompare(key(b)));
}

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  for (const f of fs.readdirSync(WORK)) fs.rmSync(path.join(WORK, f), { recursive: true, force: true });
  fs.mkdirSync(QDIR, { recursive: true });
  // クラウド側で投稿済みになった分を先に取り込む
  if (!DRY) {
    try {
      execFileSync("git", ["pull", "--rebase", "-q"], { cwd: ROOT, stdio: "ignore" });
    } catch {}
  }

  const state = readJson("state.json", { lrDone: [], hashes: [] });
  const queue = readJson("queue.json", []);
  const items = await collect(state);
  if (!items.length) return console.log("新しい候補はありません。");
  console.log(`候補 ${items.length}枚`);

  // 撮影日 → フォトウォーク開催回
  const events = loadEvents(cfg.tpwEventsDir);
  // 撮影時刻順にしてから分けると、連写の似た写真が同じ組に入って重複を見つけやすい
  const t = (it) => (it.takenAt ? new Date(it.takenAt).getTime() : Infinity);
  items.sort((a, b) => t(a) - t(b));
  for (const [i, it] of items.entries()) {
    it.date = jstDate(it.takenAt);
    it.event = events.find((e) => e.date === it.date && e.status !== "cancelled") || null;
    it.thumb = `t${String(i + 1).padStart(3, "0")}.jpg`;
    await sharp(it.file).rotate().resize({ width: 900, height: 900, fit: "inside" }).jpeg({ quality: 75 }).toFile(path.join(WORK, it.thumb));
  }

  // AI選定（30枚ずつ）
  const recent = queue.slice(-3).map((q) => q.note || q.locationName || q.date);
  const ordered = [];
  const skipped = [];
  const batches = [];
  for (let i = 0; i < items.length; i += 25) batches.push(items.slice(i, i + 25));
  console.log(`AIが選定中…（${items.length}枚を${batches.length}回に分けて・3つ同時）`);
  const results = [];
  for (let i = 0; i < batches.length; i += 3) {
    const part = batches.slice(i, i + 3);
    results.push(...(await Promise.all(part.map((b) => aiSelect(b, recent)))));
    console.log(`  …${Math.min(i + 3, batches.length)}/${batches.length}`);
  }
  for (const [bi, batch] of batches.entries()) {
    const res = results[bi];
    const info = Object.fromEntries((res.photos || []).map((p) => [p.file, p]));
    const byThumb = Object.fromEntries(batch.map((b) => [b.thumb, b]));
    for (const t of res.order || []) if (byThumb[t] && info[t]?.use !== false) ordered.push({ ...byThumb[t], ai: info[t] || {} });
    for (const b of batch) if (!ordered.includes(b) && !ordered.find((o) => o.thumb === b.thumb)) skipped.push({ ...b, ai: info[b.thumb] || {} });
  }

  // 位置情報・キャプション・投稿画像
  for (const it of ordered) {
    const portrait = !!it.ai.portrait;
    let locationName = null;
    if (it.event) locationName = eventPlaceName(it.event);
    else if (it.gps) {
      locationName = await reverseGeocode(it.gps);
      await sleep(1100);
    }
    const locationId = locationName ? await findLocationId(locationName, secrets.igToken) : null;
    const id = `${it.date || "nodate"}_${it.hash}`;
    await makePostImage(it.file, path.join(QDIR, `${id}.jpg`), it.ai.focusY ?? 0.5);
    queue.push({
      id,
      image: `queue/${id}.jpg`,
      caption: caption(it, portrait),
      portrait,
      date: it.date,
      takenAt: it.takenAt ? new Date(it.takenAt).toISOString() : null,
      event: it.event ? `vol.${it.event.vol} ${it.event.title}` : null,
      locationName,
      locationId,
      note: it.ai.note || "",
    });
    console.log(`  ✓ ${id}  ${portrait ? "[ポートレート]" : ""} ${it.event ? "[TPW vol." + it.event.vol + "]" : ""} 📍${locationName || "なし"}${locationName && !locationId ? "（位置ID未取得）" : ""}  ${it.ai.note || ""}`);
  }
  // 投稿は撮影日時の古い順（ユーザー指定）。後から古い写真を足してもその位置に入る
  sortQueue(queue);
  for (const s of skipped) console.log(`  ✗ 見送り: ${path.basename(s.file)}  ${s.ai.note || ""}`);

  // 記録（見送り分も「処理済み」にして次回また出てこないようにする）
  for (const it of items) {
    state.hashes.push(it.hash);
    if (it.lrId) state.lrDone.push(it.lrId);
  }
  if (DRY) {
    for (const q of queue.slice(-ordered.length || queue.length)) console.log(`\n--- ${q.id} ---\n${q.caption}`);
    return console.log(`\n[お試し] ${ordered.length}枚を選定（何も保存していません。画像は .work/preview/）`);
  }
  writeJson("queue.json", queue);
  writeJson("state.json", state);
  {
    for (const it of items) if (it.source === "inbox") fs.rmSync(it.file, { force: true });
    try {
      execFileSync("git", ["add", "queue", "queue.json", "state.json", "places.json"], { cwd: ROOT, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", `queue: +${ordered.length}`], { cwd: ROOT, stdio: "ignore" });
      execFileSync("git", ["push"], { cwd: ROOT, stdio: "inherit" });
      console.log(`\n✅ ${ordered.length}枚を予約しました（キュー合計 ${queue.length}枚）`);
    } catch (e) {
      console.log("⚠ GitHubへの送信に失敗: " + e.message);
    }
  }
}

main().catch((e) => {
  console.error("エラー: " + e.message);
  process.exit(1);
});
