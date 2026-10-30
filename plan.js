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
const { pullAlbum, connect, listAlbum, fetchFresh } = require("./lib/lightroom");
const { makePostImage, makeThumb } = require("./lib/image");
const { planFlyers } = require("./lib/flyer");
const { planReels } = require("./lib/reels-plan");
const { buildCaption, CAPTION_RULES } = require("./lib/caption");
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
      // ログインできたので、前の「再ログインして」通知は消す
      fs.rmSync(path.join(ROOT, "要対応_Lightroom再ログイン.txt"), { force: true });
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
        it.shot = it.shot || require("./lib/lightroom").shotLine(ex);
      }
    } catch {}
    out.push(it);
  }
  return out;
}

// ---- AI選定（このPCの claude コマンドを使う） ----
function aiSelect(batch) {
  const lines = batch.map((it) => `- ${it.thumb}（撮影 ${it.takenLabel}${it.event ? `・${it.event.title}` : ""}）`).join("\n");
  const minScore = cfg.minScore ?? 8;
  const prompt = `あなたは写真家のInstagramアカウントの編集者で、大きな写真コンテストの審査員も務めるプロです。カレントフォルダにある次の候補写真を Read ツールで全部見てください。
このアカウントはフォロワー1万人を目指していて、「お金を払ってもらえる作品／フォトコンテストで入賞するレベル」の写真だけを載せます。

${lines}

各写真について判断:
- score: 1〜10点。フォトコンの審査と同じ目で、構図・光・瞬間（決定的瞬間/表情）・技術（ピント・ブレ・露出）・物語性・独自性を総合して厳しく採点。
  10=大きなコンテストでグランプリ級 / 9=入賞級 / 8=作品として販売できる・依頼が来るレベル / 7=上手いが普通 / 6以下=記録写真・スナップの域。
  「よく撮れている」だけでは7点。見た人が指を止めて保存したくなる強さがあって初めて8点以上。
- perfect: 0〜100点の「満点評価」。この写真家は「100点満点の写真しか載せたくない」（2026-10-31）。
  100=直す所が1つもなく、このアカウントの代表作として一番上に固定できる1枚 / 95=ほぼ完璧で、プロの写真家が見ても文句がない / 90=とても良いが、構図・光・瞬間・技術・色のどこかに小さな弱さがある / 80以下=良い写真だが代表作ではない。
  少しでも「惜しい」「もう少し○○なら」と思う所があれば95未満。迷ったら低い方。
- use: perfect が ${cfg.minPerfect ?? 95} 以上、かつ score が ${minScore} 以上なら true、それ未満は false。さらに:
  ・同じ場所・同じ被写体・似た構図が続く時は一番良い1枚だけ（はっきり別の魅力がある時だけ2枚まで）
  ・ピンボケ・ブレ・露出の失敗・何を撮ったか伝わりにくい写真は点数に関係なく false
  ・残る枚数が少なくなっても基準は下げない
- 【ポートレート（人物が主役）は表情を最優先で厳しく見る】同じ人・同じ場面の写真が何枚あっても、表情がいちばん良い1枚を選ぶ。
  ・目：ピントが目に来ている・目に光（キャッチライト）がある・半目/まばたき途中/視線が泳いでいるものは不可
  ・表情：作り笑いや固い顔より、自然な笑顔・ふとした瞬間・感情が伝わる顔。口元が中途半端（話している途中など）は不可
  ・その人がいちばん魅力的に見えるか（顔の角度・あご・手の位置・髪の乱れ・服のしわ）。本人が「この写真を使ってほしい」と思える1枚か
  ・表情が良くない写真は、構図や光が良くても7点以下にする
- extra: use=false の写真のうち、score が6〜7で、ピント・ブレ・露出に問題がなく、同じ日の高得点の写真の「2枚目以降」に添えると投稿が豊かになる写真なら true（ほぼ同じ構図の写真は false）。
- tone: 全体の明るさ。"dark"（夜・暗い）/"mid"/"bright"（昼の明るい写真）のどれか。
- portrait: 人物が主役のポートレートなら true（街並みの中の小さな人影・後ろ姿のスナップは false）。
- crop: 投稿は必ず4:5（縦長）に切り取る。トップのフォトエディターとして、作品がいちばん強く見える切り取り方を決める。
  {"cx":横の中心(0=左端〜1=右端),"cy":縦の中心(0=上端〜1=下端),"zoom":寄り具合(1=4:5で取れる最大の範囲、1.2=さらに1.2倍寄る、最大1.6)}
  ・横長の写真は左右を大きく切ることになるので、主題・視線の向き・余白を考えて位置を決める（主題をど真ん中に置くとは限らない。三分割や視線の先の余白も）
  ・ポートレートは頭・あご・手を不自然に切らない。顔の上に少し余白、視線の先に空間
  ・画面の端の余計なもの（見切れた人・看板・電線・明るいゴミ）は、寄って画面の外に出せるならそうする。ただし画質が落ちるほど寄らない（zoomは基本1〜1.3）
- remove: 切り取っても残る、消しゴムで消した方が作品が良くなるもの（例「右奥を横切る人」「左下の空き缶」）。なければ空の配列。主役や場の雰囲気を作る人は消さない。
- hdr: 明暗差が大きい場面（逆光・夜景の光源と暗部・窓のある室内など）で、ハイライトとシャドウを両方しっかり起こした方が良い写真なら true。true でも不自然なHDR感は出さず、自然に見える範囲で。
- note: 一言（use=true なら写真の内容、false なら見送った理由。例「t003と似た構図」「ブレ」）。
use=true の写真だけ、投稿用に次も書く:
${CAPTION_RULES}

出力は次のJSONだけ（説明文やコードブロック不要）:
{"photos":[{"file":"t001.jpg","score":8,"perfect":90,"tone":"dark","use":true,"extra":false,"portrait":false,"crop":{"cx":0.5,"cy":0.5,"zoom":1},"remove":[],"hdr":false,"note":"…","tags":["#鎌倉"],"alt":"…"}]}`;
  return new Promise((resolve, reject) => {
    const p = spawn("claude", ["-p", "--allowedTools", "Read", "--output-format", "json", "--model", cfg.selectModel || "opus"], { cwd: WORK }); // 選定はいちばん賢いモデル（100点満点の写真だけ）
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

function caption(it, portrait) {
  const base = portrait ? cfg.hashtags.portrait : cfg.hashtags.default;
  const head = it.event ? cfg.tpwHeader.replace("{vol}", it.event.vol).replace("{title}", it.event.title) : "";
  return buildCaption({ head, base, extra: it.ai?.tags }); // 文章はAIでは書かない（アプリで自分で書く）
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

// ---- Lightroomで編集し直した写真を、予約・見送りの画像にも反映 ----
async function syncEdits() {
  const items = [...remoteJson("queue.json", []), ...remoteJson("pool.json", [])].filter((x) => x.lrId);
  if (!items.length) return;
  const lr = await connect(cfg.lightroom.configPath);
  // アルバムから外した（処理済みへ移した）写真も追えるよう、写真ごとに最新の編集日時を聞く
  const edited = new Map();
  const ids = [...new Set(items.map((x) => x.lrId))];
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(
      ids.slice(i, i + 8).map(async (id) => {
        try {
          const a = await lr.get(`/v2/catalogs/${lr.catalogId}/assets/${id}`);
          edited.set(id, a.payload?.develop?.userUpdated || null);
        } catch {}
      })
    );
  }
  const stamp = {};
  const files = [];
  const changed = items.filter((x) => {
    const cur = edited.get(x.lrId);
    if (!cur) return false;
    if (!x.lrEdited) return (stamp[x.id] = cur), false; // 初回は今の状態を基準として記録だけ
    return Date.parse(cur) > Date.parse(x.lrEdited);
  });
  if (changed.length) console.log(`Lightroomで編集し直した写真 ${changed.length}枚を反映…`);
  for (const x of changed) {
    const cur = edited.get(x.lrId);
    const buf = await fetchFresh(lr, x.lrId, cur);
    if (!buf) {
      console.log(`  ⚠ ${x.id} 新しい画像がまだ用意できていません（次回また試します）`);
      continue;
    }
    try {
      git(["checkout", "origin/main", "--", x.image]); // 今の画像（構図を合わせるため）
    } catch {}
    const imgPath = path.join(ROOT, x.image);
    await makePostImage(buf, imgPath, cfg.image, x.crop ? { crop: x.crop } : { keepFrom: imgPath });
    const thumb = x.thumb || `queue/thumbs/${x.id}.jpg`;
    await makeThumb(imgPath, path.join(ROOT, thumb));
    files.push(x.image, thumb);
    stamp[x.id] = cur;
    console.log(`  ✓ ${x.id}`);
  }
  if (!Object.keys(stamp).length) return;
  makeSync(ROOT)(`Lightroomの再編集を反映（${files.length / 2}枚）`, files, (remote) => {
    const upd = (x) => (stamp[x.id] ? { ...x, lrEdited: stamp[x.id] } : x);
    return { "queue.json": remote("queue.json", []).map(upd), "pool.json": remote("pool.json", []).map(upd) };
  });
}

// ---- フォトウォークのフライヤー（開催2週間前の21:00・複数枚）を予約 ----
function askReelCaption(cwd, files) {
  const prompt = `カレントフォルダの写真（同じ日に撮った ${files.length}枚）を Read ツールで全部見てください: ${files.join(" ")}
これを1本のスライドショー動画（リール）にして投稿します。動画全体に添える言葉を書いてください:
${CAPTION_RULES}
出力は次のJSONだけ: {"tags":["#…"]}`;
  return new Promise((resolve, reject) => {
    const CL = path.join(process.env.USERPROFILE || "", ".local", "bin", "claude.exe");
    const pr = spawn(fs.existsSync(CL) ? CL : "claude", ["-p", "--allowedTools", "Read", "--output-format", "json", "--model", cfg.aiModel || "sonnet"], { cwd });
    let out = "";
    pr.stdout.on("data", (d) => (out += d));
    pr.on("error", reject);
    pr.on("close", () => {
      try {
        resolve(JSON.parse((JSON.parse(out).result || "").match(/\{[\s\S]*\}/)[0]));
      } catch (e) {
        reject(e);
      }
    });
    pr.stdin.end(prompt);
  });
}

async function runReels() {
  if (cfg.reelSource === "lr") return; // リールは Lightroom Classic の写真から（lr-reels.js）。インスタの投稿から作るのは止める
  const r = await planReels({ root: ROOT, queue: remoteJson("queue.json", []), pool: remoteJson("pool.json", []), specials: remoteJson("specials.json", []), posted: remoteJson("posted.json", []), cfg, secrets });
  if (!r.add.length) return;
  // キャプションは形式ごとの問いかけ＋ハッシュタグ（AIの文章は使わない）
  makeSync(ROOT)(`リール予約 +${r.add.length}`, r.files, (remote) => {
    const cur = remote("specials.json", []);
    for (const a of r.add) if (!cur.some((x) => x.id === a.id)) cur.push(a);
    cur.sort((a, b) => a.postAt.localeCompare(b.postAt));
    return { "specials.json": cur };
  });
}

async function runFlyers() {
  const tpwDir = path.resolve(cfg.tpwEventsDir, "..", "..");
  const specials = remoteJson("specials.json", []);
  const postedIds = new Set(remoteJson("posted.json", []).map((p) => p.id));
  const { add, files, updates } = await planFlyers({ root: ROOT, tpwDir, specials, postedIds, secrets, eventPlaceName });
  if (!add.length && !Object.keys(updates || {}).length) return;
  makeSync(ROOT)(`フライヤー・ストーリー予約 +${add.length}`, files, (remote) => {
    const cur = remote("specials.json", []).map((x) => (updates?.[x.id] ? { ...x, ...updates[x.id] } : x));
    for (const a of add) if (!cur.some((x) => x.id === a.id)) cur.push(a);
    cur.sort((a, b) => a.postAt.localeCompare(b.postAt));
    return { "specials.json": cur };
  });
}

// ---- 処理済みの写真の一覧（Classicのプラグインが「インスタ投稿（処理済み）」へ移すのに使う） ----
//   ファイル名 <タブ> 撮影日時（分まで・現地時刻）
async function writeProcessed() {
  const state = remoteJson("state.json", { lrDone: [] });
  const done = new Set(state.lrDone);
  const lr = await connect(cfg.lightroom.configPath);
  const assets = (await listAlbum(lr, cfg.lightroom.albumName)) || [];
  const rows = assets
    .filter((a) => done.has(a.id) && a.payload?.importSource?.fileName && a.payload?.captureDate)
    .map((a) => `${a.payload.importSource.fileName}\t${a.payload.captureDate.slice(0, 16)}`);
  fs.writeFileSync(path.join(ROOT, "classic-processed.tsv"), rows.join("\n") + "\n");
  console.log(`処理済みでまだ「${cfg.lightroom.albumName}」にある写真: ${rows.length}枚（Classicで移動）`);
}

async function refreshThreadsLocal() {
  const sec = readJson("secrets.local.json", {});
  if (!sec.threadsToken || (sec.threadsRefreshedAt && Date.now() - Date.parse(sec.threadsRefreshedAt) < 7 * 864e5)) return;
  sec.threadsToken = await require("./lib/threads").refreshToken(sec.threadsToken);
  sec.threadsRefreshedAt = new Date().toISOString();
  fs.writeFileSync(path.join(ROOT, "secrets.local.json"), JSON.stringify(sec, null, 2));
  console.log("スレッズのトークンを更新しました（手元）");
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

  if (!DRY) {
    await refreshThreadsLocal().catch((e) => console.log("⚠ スレッズのトークン更新: " + e.message));
    try {
      await syncEdits();
      git(["fetch", "-q", "origin", "main"]);
    } catch (e) {
      console.log("⚠ 再編集の反映でエラー: " + e.message);
    }
    try {
      await runFlyers();
      git(["fetch", "-q", "origin", "main"]);
    } catch (e) {
      console.log("⚠ フライヤー予約でエラー: " + e.message);
    }
    try {
      await runReels();
      git(["fetch", "-q", "origin", "main"]);
    } catch (e) {
      console.log("⚠ リール予約でエラー: " + e.message);
    }
  }
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
    for (const it of batch) {
      it.ai = info[it.thumb] || { use: true, note: "（AIの判定なし）" };
      if (typeof it.ai.score === "number" && it.ai.score < (cfg.minScore ?? 8)) it.ai.use = false; // 点数が足りない写真は載せない
      if (cfg.minPerfect && !(Number(it.ai.perfect) >= cfg.minPerfect)) it.ai.use = false; // 100点満点の写真だけ（満点評価が足りない・ない写真は載せない）
    }
  }

  // 新しい写真だけ画像を作る（予約中・見送り中の写真は前に作った画像をそのまま使う）
  const fresh = [];
  const newFiles = [];
  for (const it of targets) {
    const use = it.ai.use !== false;
    if (typeof it.ai.score === "number") it.ai.note = `[${it.ai.perfect != null ? `${it.ai.perfect}/100` : `${it.ai.score}点`}] ${it.ai.note || ""}`;
    console.log(`  ${use ? "✓" : "✗"} ${it.id} ${it.ai.portrait ? "[ポートレート]" : ""} ${it.ai.note || ""}`);
    if (known.has(it.id)) continue;
    const portrait = !!it.ai.portrait;
    const locationName = await placeFor(it, places);
    const locationId = locationName ? await findLocationId(locationName, secrets.igToken) : null;
    const imgPath = path.join(QDIR, `${it.id}.jpg`);
    await makePostImage(it.file, imgPath, cfg.image, it.ai.crop ? { crop: it.ai.crop } : { focusY: it.ai.focusY ?? 0.5 });
    await makeThumb(imgPath, path.join(QDIR, "thumbs", `${it.id}.jpg`));
    newFiles.push(`queue/${it.id}.jpg`, `queue/thumbs/${it.id}.jpg`);
    fresh.push({
      id: it.id,
      lrId: it.lrId || null,
      lrEdited: it.lrEdited || null,
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
      score: it.ai.score ?? null,
      perfect: it.ai.perfect ?? null,
      shot: it.shot || null,
      crop: it.ai.crop || null,
      remove: it.ai.remove?.length ? it.ai.remove : undefined,
      hdr: it.ai.hdr || undefined,
      tone: it.ai.tone || null,
      alt: it.ai.alt || "",
    });
  }
  // 複数枚投稿：8点の写真を1枚目に、同じ日・近い時間（2時間以内）の6〜7点の写真を2枚目以降に添える（最大4枚）
  //   9点以上は1枚で見せた方が強いので単独のまま。添えた写真は見送りに入れない（アプリで「1枚ずつに戻す」もできる）
  const aiOf = new Map(targets.map((it) => [it.id, it.ai]));
  const absorbed = new Set();
  const near = (a, b) => a.date === b.date && (!a.takenAt || !b.takenAt || Math.abs(Date.parse(a.takenAt) - Date.parse(b.takenAt)) <= 2 * 3600e3);
  for (const cover of fresh) {
    const ca = aiOf.get(cover.id);
    if (ca?.use === false || (ca?.score ?? 0) >= 9 || typeof ca?.score !== "number") continue;
    const comps = fresh
      .filter((x) => x.id !== cover.id && !absorbed.has(x.id) && near(cover, x))
      .filter((x) => {
        const a = aiOf.get(x.id);
        return a?.use === false && a.extra === true && (a.score ?? 0) >= 6 && !cfg.minPerfect; // 満点の写真だけにする時は、点数の低い写真を添えない
      })
      .sort((a, b) => (aiOf.get(b.id).score ?? 0) - (aiOf.get(a.id).score ?? 0))
      .slice(0, 4);
    if (!comps.length) continue;
    for (const c of comps) absorbed.add(c.id);
    const { ...solo } = cover;
    cover.images = [cover.image, ...comps.map((c) => c.image)];
    cover.parts = [solo, ...comps];
    cover.note = `${cover.images.length}枚の複数枚投稿（1枚目 ${ca.score}点）`;
    console.log(`  ＋ ${cover.id} に ${comps.length}枚を添えて複数枚投稿に`);
  }
  const decision = new Map(targets.filter((it) => !absorbed.has(it.id)).map((it) => [it.id, it.ai]));
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

main()
  .then(async () => {
    if (DRY) return;
    git(["fetch", "-q", "origin", "main"]);
    await writeProcessed().catch((e) => console.log("⚠ 処理済み一覧の作成でエラー: " + e.message));
  })
  .catch((e) => {
  console.error("エラー: " + e.message);
  process.exit(1);
});
