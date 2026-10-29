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
async function waitReady(id) {
  for (let i = 0; i < 40; i++) {
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
  if (item.kind === "story") {
    // ストーリー（キャプション・位置情報なし）
    container = await create({ image_url: url(images[0]), media_type: "STORIES" }, []);
  } else if (images.length === 1) {
    const params = { image_url: url(images[0]), caption: item.caption };
    if (locationId) params.location_id = locationId;
    if (tags) params.user_tags = tags;
    container = await create(params, ["user_tags", "location_id"]);
  } else {
    const children = [];
    for (const [i, p] of images.slice(0, 20).entries()) {
      const params = { image_url: url(p), is_carousel_item: "true" };
      if (i === 0 && tags) params.user_tags = tags;
      const c = await create(params, ["user_tags"]);
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
  const item = due.kind === "story" ? await withSeats(due) : due;
  const { pub, info } = await publish(item);
  const { images, thumb, _extra, ...rest } = item;
  // 記録のあと、元の画像・残り人数入りの画像の両方を消す
  record({ ...due, images: [...due.images, ...(item._extra ? item.images : [])] }, { ...rest, mediaId: pub.id, permalink: info.permalink, mediaUrl: info.media_url, postedAt: nowIso, day: today, slot: "special" }, "specials.json");
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

async function main() {
  const queue = read("queue.json", []);
  const posted = read("posted.json", []);
  const { day: today, min: now } = nowJst();
  if (read("paused.json", null)?.paused) return console.log("一時停止中（paused.json）");

  try {
    await postSpecial(today, posted);
  } catch (e) {
    console.error("フライヤー投稿のエラー: " + e.message);
    process.exitCode = 1;
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
  const { image, images, thumb, ...rest } = item;
  record(item, { ...rest, count: (images || [image]).length, mediaId: pub.id, permalink: info.permalink, mediaUrl: info.media_url, postedAt: new Date().toISOString(), day: today, slot });
}

main().catch((e) => {
  console.error("エラー: " + e.message);
  process.exit(1);
});
