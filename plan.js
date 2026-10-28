// plan.js — 候補写真を集めて、AIが厳選 → 投稿予約（queue.json）と「見送り」（pool.json）に振り分ける。PCで実行。
//   候補の入れ方: ① Lightroom（クラウド）のアルバム「インスタ投稿」に入れる
//                 ② Lightroom Classic から inbox/ フォルダへ書き出す（どちらでもOK・併用OK）
//   node plan.js            … 新しい候補だけ選定して GitHub に反映（→ クラウドが毎日投稿）
//   node plan.js --reselect … アルバムの全写真（予約中・見送り含む）をもう一度選び直す
//   node plan.js --dry      … お試し（GitHubへ送らない・inbox を消さない）
// 見送りになった写真も画像ごと保存するので、iPhoneアプリの「見送り」タブから復活できる。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const sharp = require("sharp");
const exifr = require("exifr");
const { pullAlbum } = require("./lib/lightroom");
const { loadEvents, jstDate, eventPlaceName, reverseGeocode, findLocationId } = require("./lib/places");
const { makeSync, insertByDate } = require("./lib/sync");

const ROOT = __dirname;
const DRY = process.argv.includes("--dry");
const RESELECT = process.argv.includes("--reselect");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const INBOX = path.join(ROOT, "inbox");
const WORK = path.join(ROOT, ".work");
const QDIR = DRY ? path.join(WORK, "preview") : path.join(ROOT, "queue");
const BATCH = 30;
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
  } catch {
    return d;
  }
};
const secrets = readJson("secrets.local.json", {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IMG = /\.(jpe?g|png|webp|tiff?|heic)$/i;
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function remoteJson(p, d) {
  try {
    return JSON.parse(git(["show", `origin/main:${p}`]));
  } catch {
    return d;
  }
}

async function collect(state) {
  const items = [];
  // ① Lightroom クラウドのアルバム（選び直しの時は全部）
  if (cfg.lightroom?.albumName && fs.existsSync(cfg.lightroom.configPath)) {
    console.log(`Lightroom「${cfg.lightroom.albumName}」を確認…`);
    try {
      const got = await pullAlbum({
        configPath: cfg.lightroom.configPath,
        albumName: cfg.lightroom.albumName,
        outDir: WORK,
        doneIds: RESELECT ? new Set() : new Set(state.lrDone),
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
  const seen = new Set(RESELECT ? [] : state.hashes);
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
function aiSelect(batch) {
  const lines = batch.map((it) => `- ${it.thumb}（撮影 ${it.takenLabel}${it.event ? `・${it.event.title}` : ""}）`).join("\n");
  const prompt = `あなたは写真家のInstagramアカウントの編集者です。カレントフォルダにある次の候補写真を Read ツールで全部見てください。
候補は多めに入っているので、インスタに載せる価値のある写真だけを「厳選」してください。

${lines}

各写真について判断:
- use: 載せるなら true。基準は厳しめに:
  ・同じ場所・同じ被写体・似た構図が続く時は一番良い1枚だけ（はっきり別の魅力がある時だけ2枚まで）
  ・ピンボケ・ブレ・露出の失敗・何を撮ったか伝わりにくい記録写真は false
  ・目安として候補の3〜4割くらいが残るイメージ（良い写真が多ければもっと残してよい）
- portrait: 人物が主役のポートレートなら true（街並みの中の小さな人影・後ろ姿のスナップは false）。
- focusY: 縦長写真を4:5に上下トリミングする時に残したい中心の縦位置（0=上端, 0.5=中央, 1=下端）。顔や主題が切れない値に。
- note: 一言（use=true なら写真の内容、false なら見送った理由。例「t003と似た構図」「ブレ」）。

出力は次のJSONだけ（説明文やコードブロック不要）:
{"photos":[{"file":"t001.jpg","use":true,"portrait":false,"focusY":0.5,"note":"…"}]}`;
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
  const buf = await sharp(src).rotate().toBuffer();
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
    .resize({ width: cfg.image.width, withoutEnlargement: true, kernel: "lanczos3" })
    .sharpen({ sigma: 0.5 }) // 縮小で甘くなる分だけ軽く（インスタの再圧縮でぼやけにくい）
    .toColorspace("srgb")
    .jpeg({ quality: cfg.image.quality, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toFile(dest);
}

function caption(it, portrait) {
  const tags = portrait ? cfg.hashtags.portrait : cfg.hashtags.default;
  if (!it.event) return tags;
  const head = cfg.tpwHeader.replace("{vol}", it.event.vol).replace("{title}", it.event.title);
  return `${head}\n\n${tags}`;
}

// iPhoneアプリでもフォトウォークの回を判定できるよう、開催回の一覧を書き出す（公開情報のみ）
function eventsForApp(events) {
  return events
    .filter((e) => e.status !== "cancelled")
    .map((e) => ({ date: e.date, vol: e.vol, title: e.title, location: eventPlaceName(e) }));
}

// 位置情報：フォトウォークの回 → 日付ごとの場所（アプリで設定）→ 写真のGPS
async function placeFor(it, places) {
  if (it.event) return eventPlaceName(it.event);
  if (it.date && places.dayLocations?.[it.date]) return places.dayLocations[it.date];
  if (it.gps) {
    const n = await reverseGeocode(it.gps);
    await sleep(1100);
    return n;
  }
  return null;
}

// 場所の名前が分かっていて位置IDが未設定のものを埋める（アプリで日付ごとの場所や位置IDを登録した時用）
function fillPlaces(list, places) {
  for (const x of list) {
    if (!x.locationName && !x.event && x.date && places.dayLocations?.[x.date]) x.locationName = places.dayLocations[x.date];
    if (x.locationName && !x.locationId && places.locationIds?.[x.locationName]) x.locationId = places.locationIds[x.locationName];
  }
}

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  for (const f of fs.readdirSync(WORK)) fs.rmSync(path.join(WORK, f), { recursive: true, force: true });
  fs.mkdirSync(QDIR, { recursive: true });
  fs.mkdirSync(path.join(QDIR, "thumbs"), { recursive: true });
  const syncCommit = makeSync(ROOT);
  const events = loadEvents(cfg.tpwEventsDir);

  git(["fetch", "-q", "origin", "main"]);
  const state = remoteJson("state.json", readJson("state.json", { lrDone: [], hashes: [] }));
  const known = new Map();
  const byLr = new Map(); // Lightroomの写真ID → 予約のID（画像サイズを変えてもIDが変わらないように）
  for (const x of remoteJson("queue.json", [])) known.set(x.id, "queue");
  for (const x of remoteJson("pool.json", [])) known.set(x.id, "pool");
  const postedList = remoteJson("posted.json", []);
  const postedIds = new Set(postedList.map((p) => p.id));
  for (const x of [...remoteJson("queue.json", []), ...remoteJson("pool.json", []), ...postedList]) if (x.lrId) byLr.set(x.lrId, x.id);
  const places = { aliases: {}, locationIds: {}, notFound: [], dayLocations: {}, ...remoteJson("places.json", readJson("places.json", {})) };
  fs.writeFileSync(path.join(ROOT, "places.json"), JSON.stringify(places, null, 2) + "\n"); // findLocationId が読むので最新にしておく

  const items = await collect(state);
  if (!items.length) {
    console.log("新しい候補はありません。");
    if (!DRY)
      syncCommit("events更新", [], (remote) => {
        const q = remote("queue.json", []);
        const pool = remote("pool.json", []);
        const pl = { ...places, ...remote("places.json", {}) };
        fillPlaces(q, pl);
        fillPlaces(pool, pl);
        return { "events.json": eventsForApp(events), "queue.json": q, "pool.json": pool };
      });
    return;
  }

  // 撮影時刻順にしてから分けると、連写の似た写真が同じ組に入って重複を見つけやすい
  const t = (it) => (it.takenAt ? new Date(it.takenAt).getTime() : Infinity);
  items.sort((a, b) => t(a) - t(b));
  for (const [i, it] of items.entries()) {
    it.date = jstDate(it.takenAt);
    it.id = (it.lrId && byLr.get(it.lrId)) || `${it.date || "nodate"}_${it.hash}`;
    it.event = events.find((e) => e.date === it.date && e.status !== "cancelled") || null;
    it.thumb = `t${String(i + 1).padStart(3, "0")}.jpg`;
    const d = it.takenAt ? new Date(it.takenAt) : null;
    it.takenLabel = d ? `${it.date} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "不明";
    await sharp(it.file).rotate().resize({ width: 720, height: 720, fit: "inside" }).jpeg({ quality: 72 }).toFile(path.join(WORK, it.thumb));
  }
  const targets = items.filter((it) => !postedIds.has(it.id));
  console.log(`候補 ${targets.length}枚${RESELECT ? "（全部を選び直し）" : ""}`);

  // AI選定（30枚ずつ・3つ同時）
  const batches = [];
  for (let i = 0; i < targets.length; i += BATCH) batches.push(targets.slice(i, i + BATCH));
  console.log(`AIが厳選中…（${batches.length}回に分けて）`);
  const results = [];
  for (let i = 0; i < batches.length; i += 3) {
    results.push(...(await Promise.all(batches.slice(i, i + 3).map((b) => aiSelect(b)))));
    console.log(`  …${Math.min(i + 3, batches.length)}/${batches.length}`);
  }
  for (const [bi, batch] of batches.entries()) {
    const info = Object.fromEntries((results[bi].photos || []).map((p) => [p.file, p]));
    for (const it of batch) it.ai = info[it.thumb] || { use: true, note: "（AIの判定なし）" };
  }

  // 新しい写真だけ画像を作る（予約中・見送り中の写真は前に作った画像をそのまま使う）
  const fresh = [];
  const newFiles = [];
  for (const it of targets) {
    const use = it.ai.use !== false;
    console.log(`  ${use ? "✓" : "✗"} ${it.id} ${it.ai.portrait ? "[ポートレート]" : ""} ${it.ai.note || ""}`);
    if (known.has(it.id)) continue;
    const portrait = !!it.ai.portrait;
    const locationName = await placeFor(it, places);
    const locationId = locationName ? await findLocationId(locationName, secrets.igToken) : null;
    const imgPath = path.join(QDIR, `${it.id}.jpg`);
    await makePostImage(it.file, imgPath, it.ai.focusY ?? 0.5);
    await sharp(imgPath).resize({ width: 480 }).jpeg({ quality: 78 }).toFile(path.join(QDIR, "thumbs", `${it.id}.jpg`));
    newFiles.push(`queue/${it.id}.jpg`, `queue/thumbs/${it.id}.jpg`);
    fresh.push({
      id: it.id,
      lrId: it.lrId || null,
      image: `queue/${it.id}.jpg`,
      thumb: `queue/thumbs/${it.id}.jpg`,
      caption: caption(it, portrait),
      portrait,
      date: it.date,
      takenAt: it.takenAt ? new Date(it.takenAt).toISOString() : null,
      event: it.event ? `vol.${it.event.vol} ${it.event.title}` : null,
      locationName,
      locationId,
      note: it.ai.note || "",
    });
  }
  const decision = new Map(targets.map((it) => [it.id, it.ai]));
  const keepN = targets.filter((it) => it.ai.use !== false).length;

  for (const it of items) {
    if (!state.hashes.includes(it.hash)) state.hashes.push(it.hash);
    if (it.lrId && !state.lrDone.includes(it.lrId)) state.lrDone.push(it.lrId);
  }
  if (DRY) return console.log(`\n[お試し] ${targets.length}枚中 ${keepN}枚を採用（何も保存していません）`);
  for (const it of items) if (it.source === "inbox") fs.rmSync(it.file, { force: true });

  try {
    let total = 0;
    let poolN = 0;
    // 選定中にiPhoneや投稿で予約が変わっていても、その最新の予約に対して振り分ける
    syncCommit(`${RESELECT ? "選び直し" : "queue"}: 採用${keepN} / 見送り${targets.length - keepN}`, newFiles, (remote) => {
      let q = remote("queue.json", []);
      let pool = remote("pool.json", []);
      const pl = { ...places, ...remote("places.json", {}) };
      const all = new Map([...pool, ...q, ...fresh].map((x) => [x.id, x]));
      for (const [id, ai] of decision) {
        const x = all.get(id);
        if (!x) continue;
        const inQ = q.some((y) => y.id === id);
        const inP = pool.some((y) => y.id === id);
        if (ai.use !== false) {
          if (inQ) continue;
          // 選び直しでも、アプリで自分で見送った写真は戻さない
          if (inP && (!RESELECT || x.rejectedBy === "app")) continue;
          pool = pool.filter((y) => y.id !== id);
          const { reason, rejectedBy, ...item } = x;
          insertByDate(q, item);
        } else {
          if (inP) continue;
          q = q.filter((y) => y.id !== id);
          insertByDate(pool, { ...x, reason: ai.note || "AIが見送り", rejectedBy: "ai" });
        }
      }
      fillPlaces(q, pl);
      fillPlaces(pool, pl);
      total = q.length;
      poolN = pool.length;
      return { "queue.json": q, "pool.json": pool, "state.json": state, "events.json": eventsForApp(events) };
    });
    console.log(`\n✅ 採用 ${keepN}枚 / 見送り ${targets.length - keepN}枚（予約合計 ${total}枚・見送り合計 ${poolN}枚）`);
  } catch (e) {
    console.log("⚠ GitHubへの送信に失敗: " + e.message);
  }
}

main().catch((e) => {
  console.error("エラー: " + e.message);
  process.exit(1);
});
