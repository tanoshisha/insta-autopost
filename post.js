// post.js — 予約の先頭1枚をインスタに投稿する（GitHub Actions が毎日実行）。
//   必要な環境変数: IG_USER_ID, IG_TOKEN, GITHUB_REPOSITORY（Actionsが自動で入れる）
//   30分ごとに起動され、schedule.json の投稿時刻を過ぎていて未投稿の枠があれば1枚投稿する
const fs = require("fs");
const path = require("path");
const { makeSync } = require("./lib/sync");
const { timesFor, toMin, nowJst } = require("./lib/schedule");
const LATE_LIMIT = 150; // GitHubの起動遅れを見込んで、予定時刻から2時間半以内なら投稿する

const ROOT = __dirname;
const GRAPH = "https://graph.facebook.com/v26.0";
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const read = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
  } catch {
    return d;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const syncCommit = makeSync(ROOT);

async function graph(method, p, params) {
  const body = new URLSearchParams({ ...params, access_token: process.env.IG_TOKEN });
  const url = method === "GET" ? `${GRAPH}${p}?${body}` : `${GRAPH}${p}`;
  const r = await fetch(url, method === "GET" ? {} : { method, body });
  const j = await r.json();
  if (j.error) throw new Error(`${p}: ${j.error.message}`);
  return j;
}

const files = (item) => [...new Set([...(item.images || []), item.image, item.thumb].filter(Boolean))];

// 投稿したものを予約から外して記録（最新の予約に対して行う）。list = "queue.json" | "specials.json"
function record(item, rec, list = "queue.json") {
  syncCommit(`posted ${item.id}`, [], (remote) => {
    const q = remote(list, []).filter((x) => x.id !== item.id);
    const posted = remote("posted.json", []);
    if (rec && !posted.some((p) => p.id === item.id)) posted.push(rec);
    const out = { [list]: q, "posted.json": posted };
    for (const f of files(item)) out[f] = null;
    return out;
  });
}

// 入れ物を作る。失敗したら、外してよいもの（タグ→位置情報）を1つずつ外して再挑戦
async function create(params, droppable) {
  for (const drop of [null, ...droppable]) {
    if (drop && !params[drop]) continue;
    if (drop) delete params[drop];
    try {
      return await graph("POST", `/${process.env.IG_USER_ID}/media`, params);
    } catch (e) {
      if (!droppable.some((k) => params[k])) throw e;
      console.log(`失敗（${e.message}）→ 外して再挑戦`);
    }
  }
  throw new Error("投稿の準備に失敗しました");
}
async function waitReady(id, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const s = await graph("GET", `/${id}`, { fields: "status_code" });
    if (s.status_code === "FINISHED") return;
    if (s.status_code === "ERROR") throw new Error("インスタ側で画像の処理に失敗");
    await sleep(4000);
  }
  throw new Error("インスタ側の画像処理が終わりませんでした");
}

// 1枚でも複数枚（カルーセル）でも投稿する
async function publish(item) {
  const url = (p) => `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/main/${p}`;
  const images = item.images?.length ? item.images : [item.image];
  // 位置IDはアプリで後から登録されることがあるので、投稿する時点の places.json を見る
  const locationId = item.locationId || (item.locationName && read("places.json", {}).locationIds?.[item.locationName]);
  // 人物タグ（アプリで設定）。x,y は写真の左上0〜右下1。複数枚の時は1枚目に付ける
  const tags = item.userTags?.length ? JSON.stringify(item.userTags.map(({ username, x, y }) => ({ username, x, y }))) : null;
  console.log(`投稿: ${item.id}（${images.length}枚）`);
  let container;
  if (item.kind === "reel") {
    // 動画は jsDelivr（GitHubのファイルを正しい形式で配る CDN）経由で渡す。コミットを指定するので最新が読まれる
    const params = { media_type: "REELS", video_url: `https://cdn.jsdelivr.net/gh/${process.env.GITHUB_REPOSITORY}@${item.sha}/${item.video}`, caption: item.caption, share_to_feed: "true" };
    if (locationId) params.location_id = locationId;
    container = await create(params, ["location_id"]);
    await waitReady(container.id, 120); // 動画の処理は数分かかる
  } else if (item.kind === "story") {
    // ストーリー（キャプション・位置情報なし）
    container = await create({ image_url: url(images[0]), media_type: "STORIES" }, []);
  } else if (images.length === 1) {
    const params = { image_url: url(images[0]), caption: item.caption };
    if (locationId) params.location_id = locationId;
    if (tags) params.user_tags = tags;
    if (item.alt) params.alt_text = item.alt.slice(0, 1000); // 写真の説明（読み上げ・検索向け）
    container = await create(params, ["user_tags", "alt_text", "location_id"]);
  } else {
    const children = [];
    for (const [i, p] of images.slice(0, 20).entries()) {
      const params = { image_url: url(p), is_carousel_item: "true" };
      if (i === 0 && tags) params.user_tags = tags;
      if (i === 0 && item.alt) params.alt_text = item.alt.slice(0, 1000);
      const c = await create(params, ["user_tags", "alt_text"]);
      await waitReady(c.id);
      children.push(c.id);
    }
    const params = { media_type: "CAROUSEL", children: children.join(","), caption: item.caption };
    if (locationId) params.location_id = locationId;
    container = await create(params, ["location_id"]);
  }
  await waitReady(container.id);
  const pub = await graph("POST", `/${process.env.IG_USER_ID}/media_publish`, { creation_id: container.id });
  const info = await graph("GET", `/${pub.id}`, { fields: "permalink,media_url,thumbnail_url" }).catch(() => ({}));
  console.log(`✅ 投稿しました ${info.permalink || pub.id}`);
  return { pub, info };
}

// フライヤーなど時刻指定の投稿（普段の投稿ペースとは別枠）
async function postSpecial(today, posted) {
  const nowIso = new Date().toISOString();
  const due = read("specials.json", []).find(
    (s) => !s.skipped && Date.parse(s.postAt) <= Date.now() && (!s.eventDate || s.eventDate > today) && !posted.some((p) => p.id === s.id)
  );
  if (!due) return;
  // 手で同じ回の告知を出していたら二重に投稿しない
  if (due.kind === "flyer" && due.title) {
    const recent = await graph("GET", `/${process.env.IG_USER_ID}/media`, { fields: "caption", limit: "25" }).catch(() => ({ data: [] }));
    if ((recent.data || []).some((m) => (m.caption || "").split("\n")[0].includes(due.title))) {
      console.log(`「${due.title}」はインスタに告知済みなので予約を外します`);
      return record(due, null, "specials.json");
    }
  }
  const item = due.kind === "story" ? await withSeats(due) : due.kind === "reel" ? await withVideo(due) : due;
  const { pub, info } = await publish(item);
  const { images, thumb, _extra, ...rest } = item;
  // 記録のあと、元の画像・残り人数入りの画像の両方を消す
  record({ ...due, images: [...due.images, ...(item._extra ? item.images : [])] }, { ...rest, mediaId: pub.id, permalink: info.permalink, mediaUrl: info.media_url, postedAt: nowIso, day: today, slot: "special" }, "specials.json");
}

// ---- リールの動画を作る（GitHub の実行環境の ffmpeg で）→ 公開URLで読めるように先に送る ----
async function withVideo(item) {
  const { makeReel } = require("./lib/reel");
  const video = item.images[0].replace(/[^/]+$/, "reel.mp4");
  const r = await makeReel(item.images.map((p) => path.join(ROOT, p)), path.join(ROOT, video), ROOT);
  syncCommit(`reel video ${item.id}`, [video], () => ({}));
  const sha = require("child_process").execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  console.log(`リールの動画を作りました（${r.seconds}秒）`);
  await sleep(8000);
  return { ...item, video, sha, images: [...item.images, video], _extra: true };
}

// ---- ストーリーに「残りN名」を重ねる（投稿の直前に、サイトの予約システムから最新の人数を取る） ----
// サイトと同じルール：定員まで空きがある間は「募集中」、残り9名以下は「残りN名」、定員に達したら「追加1枠」
const SITE = "https://tokyo-photowalk.com";
async function seatKey(date) {
  const ev = (await fetch(`${SITE}/events.json?t=${Date.now()}`).then((r) => r.json())).find((e) => e.date === date);
  if (!ev) return null;
  let live = null;
  try {
    const conf = await fetch(`${SITE}/booking-config.js?t=${Date.now()}`).then((r) => r.text());
    const api = conf.match(/TPW_BOOKING_API\s*=\s*'([^']+)'/)?.[1];
    if (api) live = (await fetch(`${api}?action=counts&t=${Date.now()}`, { redirect: "follow" }).then((r) => r.json())).counts?.[date] ?? null;
  } catch {}
  const cap = ev.capacity || 10;
  let n = live != null ? Number(live) : Number(ev.booked || 0);
  if (ev.seats != null && ev.seats !== "") n = Math.max(n, cap - Number(ev.seats));
  if (n < cap) return cap - n < 10 ? `left${cap - n}` : "open";
  return "extra";
}
async function withSeats(item) {
  try {
    const sharp = require("sharp");
    const key = await seatKey(item.eventDate);
    const badge = key && path.join(ROOT, "assets", "seat", `${key}.png`);
    if (!badge || !fs.existsSync(badge)) return item;
    const out = item.images[0].replace(/\.jpg$/, "-seat.jpg");
    const buf = await sharp(path.join(ROOT, item.images[0])).composite([{ input: fs.readFileSync(badge), left: 90, top: 1400 }]).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    fs.writeFileSync(path.join(ROOT, out), buf);
    syncCommit(`story ${item.id}: ${key}`, [out], () => ({})); // 公開URLで読めるように先に送る
    console.log(`残り人数を重ねました（${key}）`);
    await sleep(5000);
    return { ...item, images: [out], seat: key, _extra: true };
  } catch (e) {
    console.log("残り人数を重ねられなかったので、そのまま投稿します: " + e.message);
    return item;
  }
}

// ---- 投稿の反応（いいね・コメント数）を6時間に1回取る → insights.json（アプリの「投稿済み」と「反応がいい時間帯」用）----
async function refreshInsights() {
  const cur = read("insights.json", null);
  if (cur && Date.now() - Date.parse(cur.updatedAt) < 6 * 3600e3) return;
  const j = await graph("GET", `/${process.env.IG_USER_ID}/media`, { fields: "id,timestamp,like_count,comments_count,permalink,media_type,media_url,thumbnail_url,caption", limit: "60" });
  const media = (j.data || []).map((m) => ({
    id: m.id,
    at: m.timestamp,
    likes: m.like_count ?? null,
    comments: m.comments_count ?? null,
    url: m.permalink,
    img: m.media_type === "VIDEO" ? m.thumbnail_url : m.media_url,
    type: m.media_type,
    head: (m.caption || "").split("\n")[0].slice(0, 40),
  }));
  syncCommit("insights", [], () => ({ "insights.json": { updatedAt: new Date().toISOString(), media } }));
  console.log(`反応を更新しました（${media.length}件）`);
}

// ---- うまくいかなかった時はアプリに出す（status.json）。うまくいったら消す ----
function setStatus(error) {
  const cur = read("status.json", null);
  if (!error && !cur?.error) return;
  syncCommit(error ? "status: error" : "status: ok", [], () => ({ "status.json": error ? { error, at: new Date().toISOString() } : null }));
}

// ---- 自動ストーリー（config.json の stories で切り替え） ----
//   newPost: フィードに投稿したら、その写真を「新しい投稿」付きでストーリーにも（1日1回まで）
//   memory : 毎週日曜20:30に、反応が良かった昔の写真を「あの日の一枚」としてストーリーに
const storyCfg = () => ({ newPost: true, memory: true, ...(cfg.stories || {}) });
async function composeStory(buf, badgeKey, outRel) {
  const sharp = require("sharp");
  const bg = await sharp(buf).resize(1080, 1920, { fit: "cover" }).blur(45).modulate({ brightness: 0.5 }).toBuffer();
  const fg = await sharp(buf).resize(880, 1100, { fit: "cover" }).toBuffer();
  const out = await sharp(bg)
    .composite([{ input: fg, left: 100, top: 250 }, { input: fs.readFileSync(path.join(ROOT, "assets", "seat", `${badgeKey}.png`)), left: 90, top: 1400 }])
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
  fs.mkdirSync(path.dirname(path.join(ROOT, outRel)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, outRel), out);
  syncCommit(`story image ${outRel}`, [outRel], () => ({}));
  await sleep(5000);
}
async function postAutoStory(kind, outRel, extra, today) {
  const { pub } = await publish({ id: outRel, kind: "story", images: [outRel] });
  syncCommit(`posted ${kind}`, [], (remote) => {
    const posted = remote("posted.json", []);
    posted.push({ id: `${kind}-${Date.now()}`, kind: "story", title: kind === "memory" ? "あの日の一枚" : "新しい投稿のお知らせ", mediaId: pub.id, postedAt: new Date().toISOString(), day: today, slot: `${kind}-story`, ...extra });
    return { "posted.json": posted, [outRel]: null };
  });
}
async function memoryStory(today, now, posted) {
  if (!storyCfg().memory) return;
  const dow = new Date(Date.parse(today + "T00:00:00Z")).getUTCDay();
  if (dow !== 0 || now < 20 * 60 + 30 || now > 23 * 60) return;
  if (posted.some((p) => p.day === today && p.slot === "memory-story")) return;
  const used = new Set(posted.filter((p) => p.memoryOf).map((p) => p.memoryOf));
  const old = (read("insights.json", null)?.media || []).filter((m) => m.img && m.type !== "VIDEO" && Date.now() - Date.parse(m.at) > 45 * 864e5 && !used.has(m.id));
  const best = old.sort((a, b) => (b.likes || 0) - (a.likes || 0))[0];
  if (!best) return;
  const buf = Buffer.from(await (await fetch(best.img)).arrayBuffer());
  const rel = `specials/auto/memory-${today}.jpg`;
  await composeStory(buf, "memory", rel);
  await postAutoStory("memory", rel, { memoryOf: best.id }, today);
  console.log("あの日の一枚をストーリーに投稿しました");
}

async function main() {
  const queue = read("queue.json", []);
  const posted = read("posted.json", []);
  const { day: today, min: now } = nowJst();
  if (read("paused.json", null)?.paused) return console.log("一時停止中（paused.json）");

  try {
    await memoryStory(today, now, posted);
  } catch (e) {
    console.log("あの日の一枚のストーリーは失敗: " + e.message);
  }
  try {
    await postSpecial(today, posted);
  } catch (e) {
    console.error("フライヤー投稿のエラー: " + e.message);
    process.exitCode = 1;
    try {
      setStatus("フライヤー/ストーリー: " + e.message.slice(0, 280));
    } catch {}
  }

  const times = timesFor(today, read("schedule.json", null));
  const slot = process.env.FORCE
    ? "manual-" + new Date().toISOString().slice(11, 16)
    : times.find((t) => toMin(t) <= now && now - toMin(t) <= LATE_LIMIT && !posted.some((p) => p.day === today && p.slot === t));
  if (!slot) return console.log(`今は投稿時刻ではありません（今日の予定: ${times.join(" / ") || "お休み"}）`);
  if (!queue.length) return console.log("予約が空です");

  const item = queue[0];
  // 前回、投稿後の記録だけ失敗していた場合は記録だけ直す（二重投稿しない）
  if (posted.some((p) => p.id === item.id)) {
    console.log("投稿済みの写真が予約に残っていたので外します: " + item.id);
    return record(item, null);
  }
  const { pub, info } = await publish(item);
  // 「新しい投稿」のストーリー用の画像を、元の画像が消える前に作っておく（1日1回まで）
  let storyRel = null;
  if (storyCfg().newPost && !posted.some((p) => p.day === today && p.slot === "newpost-story")) {
    try {
      storyRel = `specials/auto/newpost-${item.id}.jpg`;
      await composeStory(fs.readFileSync(path.join(ROOT, item.image || item.images[0])), "newpost", storyRel);
    } catch (e) {
      console.log("新しい投稿のストーリー画像を作れませんでした: " + e.message);
      storyRel = null;
    }
  }
  const { image, images, thumb, ...rest } = item;
  record(item, { ...rest, count: (images || [image]).length, mediaId: pub.id, permalink: info.permalink, mediaUrl: info.media_url, postedAt: new Date().toISOString(), day: today, slot });
  if (storyRel) {
    try {
      await postAutoStory("newpost", storyRel, { of: item.id }, today);
      console.log("新しい投稿のお知らせをストーリーに出しました");
    } catch (e) {
      console.log("新しい投稿のストーリーは失敗: " + e.message);
    }
  }
}

main()
  .then(async () => {
    try {
      await refreshInsights();
    } catch (e) {
      console.log("反応の取得に失敗: " + e.message);
    }
    if (!process.exitCode) setStatus(null);
  })
  .catch((e) => {
    console.error("エラー: " + e.message);
    try {
      setStatus(e.message.slice(0, 300));
    } catch {}
    process.exit(1);
  });
