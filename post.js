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
    (s) => !s.skipped && !(s.kind === "reel" && s.manual) && Date.parse(s.postAt) <= Date.now() && (!s.eventDate || s.eventDate > today) && !posted.some((p) => p.id === s.id)
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
  let thr = null;
  if (due.kind === "flyer") {
    try {
      thr = await toThreads({ ...due, images: due.images.slice(0, 1) }, due.threadsText); // サイトのスレッズ用告知文で
    } catch (e) {
      console.log("フライヤーのスレッズ投稿は失敗: " + e.message);
      try {
        setStatus("スレッズ（フライヤー）: " + e.message.slice(0, 250));
      } catch {}
    }
  }
  const { images, thumb, _extra, ...rest } = item;
  // 記録のあと、元の画像・残り人数入りの画像の両方を消す
  record({ ...due, images: [...due.images, ...(item._extra ? item.images : [])] }, { ...rest, threads: thr?.permalink || (thr ? true : null), mediaId: pub.id, permalink: info.permalink, mediaUrl: info.media_url, postedAt: nowIso, day: today, slot: "special" }, "specials.json");
}

// リールの写真と設定（形式・つかみの一言・撮影データ・クイズの答え）
const reelItems = (x) => x.images.map((p, i) => ({ src: path.join(ROOT, p), shot: x.shots?.[i] || null, place: x.places?.[i] || null }));
const reelOpts = (x) => ({ durations: x.durations || null, style: x.style || "oto", format: x.format || "dump", hook: x.hook || x.reelTitle || "", sub: x.reelSub || "", answer: x.answer || null, bpm: x.bpm, beats: x.beats, layout: x.layout || null, rhythm: x.rhythm || undefined });

// ---- リールの動画を前もって作っておく（アプリで再生・保存して、インスタで曲を付けて投稿する） ----
//   予約されたリール・アプリでテンポやタイトルを変えたリール（rebuild）を作り直す。ファイル名を毎回変えて、古い動画が見えないように
async function buildReels() {
  if (read("config.json", {}).reelVideo !== true) return; // 動画は作らない（本人が Edits で組む・2026-10-30）
  // PC（After Effects）が作るのを待つ。3時間たっても作られていなければ、ここ（ffmpeg版）で作る
  const pcWait = (s) => Date.now() - Date.parse(s.rebuildAt || s.builtAt || s.postAt) < 3 * 3600e3 && Date.parse(s.postAt) - Date.now() > 3 * 3600e3;
  const list = read("specials.json", []).filter((s) => s.kind === "reel" && !s.skipped && (s.rebuild || !s.video) && s.images?.length && !pcWait(s));
  if (list.length && process.platform === "linux") {
    // 動画づくりの ffmpeg とタイトルの日本語フォント（起動時に入れているが、入る前から動いている時のために）
    try {
      require("child_process").execSync('(command -v ffmpeg >/dev/null && fc-list | grep -qi "Noto Sans CJK") || (sudo apt-get update -qq && sudo apt-get install -y -qq ffmpeg fonts-noto-cjk)', { stdio: "ignore", timeout: 240000 });
    } catch {}
  }
  for (const x of list.slice(0, 1)) {
    const { makeReel } = require("./lib/reel");
    const n = (x.rev || 0) + 1;
    const video = `specials/${x.id}/reel-${n}.mp4`;
    const r = await makeReel(reelItems(x), path.join(ROOT, video), ROOT, reelOpts(x));
    const cover = video.replace(/.mp4$/, "-cover.jpg");
    const old = [x.video, x.cover].filter(Boolean);
    syncCommit(`reel video ${x.id} (${r.bpm}bpm)`, [video, cover], (remote) => {
      const sp = remote("specials.json", []);
      const k = sp.findIndex((y) => y.id === x.id);
      if (k === -1) return {};
      // 作っている間にアプリでまた変えられていたら、もう一度作る
      const again = ["bpm", "beats", "hook", "reelTitle", "reelSub", "answer", "format", "style", "durations", "images", "layout", "rhythm"].some((f) => JSON.stringify(sp[k][f]) !== JSON.stringify(x[f]));
      sp[k] = { ...sp[k], video, cover, rev: n, seconds: r.seconds, beatsUsed: r.beats, rebuild: again, builtAt: new Date().toISOString() };
      const out = { "specials.json": sp };
      for (const f of old) out[f] = null;
      return out;
    });
    console.log(`リールの動画を作りました ${x.id}（${r.seconds}秒・${r.bpm}bpm・${r.beats}拍ごと）`);
  }
}

// ---- リールの動画を作る（自動で投稿する時）→ 公開URLで読めるように先に送る ----
async function withVideo(item) {
  const { makeReel } = require("./lib/reel");
  const video = item.images[0].replace(/[^/]+$/, "reel.mp4");
  const r = await makeReel(reelItems(item), path.join(ROOT, video), ROOT, reelOpts(item));
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
  // 直近25件はリーチ・保存・シェアも
  for (const m of media.slice(0, 25)) {
    try {
      const r = await graph("GET", `/${m.id}/insights`, { metric: "reach,saved,shares,views" });
      for (const x of r.data || []) m[x.name] = x.values?.[0]?.value ?? null;
    } catch {}
  }
  const account = {};
  try {
    const on = await graph("GET", `/${process.env.IG_USER_ID}/insights`, { metric: "online_followers", period: "lifetime" });
    const v = (on.data?.[0]?.values || []).map((x) => x.value).filter((x) => x && Object.keys(x).length).pop();
    if (v) account.online = v; // 時（UTC）ごとのオンラインのフォロワー数
  } catch {}
  try {
    const fc = await graph("GET", `/${process.env.IG_USER_ID}/insights`, { metric: "follower_count", period: "day" });
    account.followerDaily = (fc.data?.[0]?.values || []).map((x) => ({ day: x.end_time.slice(0, 10), n: x.value }));
    const me = await graph("GET", `/${process.env.IG_USER_ID}`, { fields: "followers_count,media_count" });
    account.followers = me.followers_count;
  } catch {}
  const hist = [...(cur?.followerHist || []).filter((x) => x.day !== nowJst().day), ...(account.followers ? [{ day: nowJst().day, n: account.followers }] : [])].slice(-120);
  syncCommit("insights", [], () => ({ "insights.json": { updatedAt: new Date().toISOString(), media, account, followerHist: hist } }));
  console.log(`反応を更新しました（${media.length}件）`);
}

// ---- 交流リスト：よく使うハッシュタグの人気・新着投稿を12時間に1回集める → explore.json（いいねは自分で押す） ----
//   インスタの決まりで、調べられるハッシュタグは7日間で30種類まで（ここでは決まった数個だけ使う）
async function refreshExplore() {
  const cur = read("explore.json", null);
  if (cur && Date.now() - Date.parse(cur.updatedAt) < 12 * 3600e3) return;
  const tags = cfg.explore || ["東京カメラ部", "ファインダー越しの私の世界", "写真好きな人と繋がりたい", "ポートレート", "ストリートスナップ"];
  const ids = { ...(cur?.ids || {}) };
  const out = [];
  const seen = new Set();
  for (const t of tags) {
    try {
      if (!ids[t]) ids[t] = (await graph("GET", "/ig_hashtag_search", { user_id: process.env.IG_USER_ID, q: t })).data?.[0]?.id;
      if (!ids[t]) continue;
      for (const kind of ["top_media", "recent_media"]) {
        const j = await graph("GET", `/${ids[t]}/${kind}`, { user_id: process.env.IG_USER_ID, fields: "id,permalink,media_type,like_count,comments_count,media_url,timestamp", limit: "25" });
        for (const m of j.data || []) {
          if (seen.has(m.id) || m.media_type === "VIDEO" || !m.media_url) continue;
          seen.add(m.id);
          out.push({ id: m.id, tag: t, kind: kind === "top_media" ? "top" : "new", url: m.permalink, img: m.media_url, likes: m.like_count ?? null, at: m.timestamp });
        }
      }
    } catch (e) {
      console.log(`交流リスト #${t}: ${e.message}`);
    }
  }
  if (!out.length) return;
  syncCommit("explore", [], () => ({ "explore.json": { updatedAt: new Date().toISOString(), ids, media: out.slice(0, 200) } }));
  console.log(`交流リストを更新しました（${out.length}件）`);
}

// ---- コメント（30分ごと）：スパムっぽいものは自動で非表示。アプリで書いた返信（actions.json）を送る ----
const SPAM = /(https?:\/\/|www\.|\.com\b|\bdm\b|promo|promot|collab|ambassador|send (a )?pic|check (my|out)|crypto|bitcoin|forex|invest|giveaway|followers?\s*(free|cheap)|稼げ|副業|在宅|LINE(追加|登録)|プロフ(を)?見て|💰|📈)/i;
async function refreshComments() {
  let threadsStats = null;
  const cur = read("comments.json", null);
  const acts = read("actions.json", []);
  const due = !cur || Date.now() - Date.parse(cur.updatedAt) > 30 * 60e3;
  if (!due && !acts.length) return;
  const me = cfg.username || "hayato_naoe";
  const done = [];
  // アプリからの依頼（返信・非表示を戻す）
  for (const a of acts) {
    try {
      if (a.commentId.startsWith("th:")) {
        // スレッズの返信
        const th = require("./lib/threads");
        const token = await threadsToken();
        const rid = a.commentId.slice(3);
        if (a.type === "reply") await th.replyTo({ token, userId: cfg.threadsUserId, replyToId: rid, text: a.text });
        else await th.hideReply({ token, replyId: rid, hide: a.type === "hide" });
      } else if (a.type === "reply") await graph("POST", `/${a.commentId}/replies`, { message: a.text });
      else if (a.type === "unhide") await graph("POST", `/${a.commentId}`, { hide: "false" });
      else if (a.type === "hide") await graph("POST", `/${a.commentId}`, { hide: "true" });
      done.push({ ...a, ok: true });
    } catch (e) {
      done.push({ ...a, ok: false, error: e.message.slice(0, 120) });
    }
  }
  let items = cur?.items || [];
  if (due) {
    const list = await graph("GET", `/${process.env.IG_USER_ID}/media`, { fields: "id,permalink,media_url,thumbnail_url,comments_count,timestamp", limit: "20" });
    const fresh = [];
    for (const m of (list.data || []).filter((x) => x.comments_count > 0)) {
      const c = await graph("GET", `/${m.id}/comments`, { fields: "id,username,text,timestamp,hidden,replies{username}", limit: "50" }).catch(() => ({ data: [] }));
      for (const x of c.data || []) {
        if (x.username === me) continue;
        const old = items.find((y) => y.id === x.id) || {};
        const replied = (x.replies?.data || []).some((r) => r.username === me) || !!old.replied;
        let hidden = !!x.hidden;
        let spam = old.spam || false;
        if (!hidden && !old.checked && SPAM.test(x.text || "")) {
          try {
            await graph("POST", `/${x.id}`, { hide: "true" });
            hidden = spam = true;
            console.log(`スパムっぽいコメントを非表示: @${x.username}`);
          } catch {}
        }
        fresh.push({ id: x.id, mediaId: m.id, url: m.permalink, img: m.media_url || m.thumbnail_url, username: x.username, text: x.text, at: x.timestamp, hidden, spam, replied, checked: true });
      }
    }
    // スレッズの返信と、投稿ごとの数字（表示・いいね・返信）
    let thPosts = null;
    if (cfg.threadsUserId && cfg.threads !== false) {
      try {
        const r = await require("./lib/threads").recent({ token: await threadsToken(), me });
        for (const x of r.replies) {
          const old = items.find((y) => y.id === x.id) || {};
          fresh.push({ ...x, replied: x.replied || !!old.replied, checked: true });
        }
        thPosts = r.posts;
      } catch (e) {
        console.log("スレッズの返信の確認に失敗: " + e.message);
      }
    }
    if (thPosts) threadsStats = { updatedAt: new Date().toISOString(), posts: thPosts };
    items = fresh.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300);
  }
  for (const d of done) {
    const it = items.find((x) => x.id === d.commentId);
    if (it && d.ok) {
      if (d.type === "reply") it.replied = true;
      if (d.type === "unhide") (it.hidden = false), (it.spam = false);
      if (d.type === "hide") it.hidden = true;
    }
  }
  const changed = JSON.stringify(items) !== JSON.stringify(cur?.items || []) || done.length || threadsStats;
  if (!changed && cur) return;
  syncCommit("comments", [], (remote) => {
    const left = remote("actions.json", []).filter((a) => !done.some((d) => d.at === a.at && d.commentId === a.commentId));
    const out = { "comments.json": { updatedAt: new Date().toISOString(), items, log: [...done, ...(cur?.log || [])].slice(0, 50) } };
    out["actions.json"] = left.length ? left : null;
    if (threadsStats) out["threads.json"] = threadsStats;
    return out;
  });
}

// ---- タグ付け（6時間ごと）：自分がタグ付けされた投稿の一覧 → tagged.json ----
async function refreshTagged() {
  const cur = read("tagged.json", null);
  if (cur && Date.now() - Date.parse(cur.updatedAt) < 6 * 3600e3) return;
  const j = await graph("GET", `/${process.env.IG_USER_ID}/tags`, { fields: "id,username,permalink,media_type,media_url,thumbnail_url,timestamp,caption", limit: "50" });
  const items = (j.data || []).map((m) => ({ id: m.id, username: m.username, url: m.permalink, img: m.media_url || m.thumbnail_url, at: m.timestamp, head: (m.caption || "").split("\n")[0].slice(0, 50) }));
  syncCommit("tagged", [], () => ({ "tagged.json": { updatedAt: new Date().toISOString(), items } }));
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
  let out;
  if (badgeKey === "newpost") {
    // 写真を全面に敷き、真ん中だけ少しくっきり→外側へグラデーションで強くぼかす。上に控えめな文字（投稿を開かないとはっきり見えない）
    const base = await sharp(buf).resize(1080, 1920, { fit: "cover" }).toBuffer();
    const clear = await sharp(base).modulate({ brightness: 0.8 }).toBuffer();
    const mask = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><defs><radialGradient id="g" cx="50%" cy="46%" r="50%" gradientTransform="translate(0.5 0.46) scale(1 0.56) translate(-0.5 -0.46)"><stop offset="0.26" stop-color="#fff" stop-opacity="0"/><stop offset="0.62" stop-color="#fff" stop-opacity="1"/></radialGradient></defs><rect width="1080" height="1920" fill="url(#g)"/></svg>`
    );
    const blurred = await sharp(base).blur(30).modulate({ brightness: 0.68 }).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
    out = await sharp(clear)
      .composite([{ input: blurred }, { input: fs.readFileSync(path.join(ROOT, "assets", "seat", "newpost-overlay.png")) }])
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
  } else {
    const bg = await sharp(buf).resize(1080, 1920, { fit: "cover" }).blur(45).modulate({ brightness: 0.5 }).toBuffer();
    const fg = await sharp(buf).resize(880, 1100, { fit: "cover" }).toBuffer();
    out = await sharp(bg)
      .composite([{ input: fg, left: 100, top: 250 }, { input: fs.readFileSync(path.join(ROOT, "assets", "seat", `${badgeKey}.png`)), left: 90, top: 1400 }])
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
  }
  fs.mkdirSync(path.dirname(path.join(ROOT, outRel)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, outRel), out);
  syncCommit(`story image ${outRel}`, [outRel], () => ({}));
  await sleep(5000);
}
async function postAutoStory(kind, outRel, extra, today) {
  const { pub } = await publish({ id: outRel, kind: "story", images: [outRel] });
  syncCommit(`posted ${kind}`, [], (remote) => {
    const posted = remote("posted.json", []);
    posted.push({ id: `${kind}-${Date.now()}`, kind: "story", title: kind === "memory" ? "あの日の一枚" : "新しい投稿のお知らせ", mediaId: pub.id, postedAt: new Date().toISOString(), day: today, slot: `${kind}-story`, image: outRel, ...extra }); // 画像はアプリで見られるよう残す
    return { "posted.json": posted };
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

// ---- スレッズのトークン：自分だけの「秘密のGist」に置いて、1週間ごとに自動で更新（60日の期限を気にしなくていい） ----
//   GIST_TOKEN（gist だけ触れる鍵）が無い時は、Secrets の THREADS_TOKEN をそのまま使う
const GIST_DESC = "insta-autopost: threads token (自動更新)";
let thToken = null;
async function threadsToken() {
  if (thToken) return thToken;
  const th = require("./lib/threads");
  const ok = async (t) => !!t && !!(await fetch(`https://graph.threads.net/v1.0/me?fields=id&access_token=${t}`).then((r) => r.json()).catch(() => ({})))?.id;
  const envTok = process.env.THREADS_TOKEN || null;
  const gt = process.env.GIST_TOKEN;
  if (!gt) {
    if (!(await ok(envTok))) throw new Error("スレッズの鍵が使えません（GitHub の THREADS_TOKEN を確認）");
    return (thToken = envTok);
  }
  const H = { Authorization: `Bearer ${gt}`, Accept: "application/vnd.github+json", "User-Agent": "insta-autopost", "Content-Type": "application/json" };
  const put = async (url, method, token) => {
    const r = await fetch(url, { method, headers: H, body: JSON.stringify({ description: GIST_DESC, public: false, files: { "threads.json": { content: JSON.stringify({ token, refreshedAt: new Date().toISOString() }) } } }) });
    if (!r.ok) console.log(`スレッズの鍵の保存に失敗（Gist ${r.status}）`);
  };
  const list = await fetch("https://api.github.com/gists?per_page=100", { headers: H }).then((r) => r.json()).catch(() => null);
  if (!Array.isArray(list)) console.log("Gist を読めません（GIST_TOKEN を確認）: " + JSON.stringify(list).slice(0, 120));
  const g = Array.isArray(list) ? list.find((x) => x.description === GIST_DESC) : null;
  let tok = null;
  let at = 0;
  if (g) {
    try {
      const d = JSON.parse((await fetch(g.url, { headers: H }).then((r) => r.json())).files["threads.json"].content);
      tok = d.token;
      at = Date.parse(d.refreshedAt) || 0;
    } catch {}
  }
  // Gist の鍵が使えなければ、Secrets の鍵に戻す
  if (!(await ok(tok))) {
    if (!(await ok(envTok))) throw new Error("スレッズの鍵が使えません（Gist も THREADS_TOKEN もダメ）");
    tok = envTok;
    at = 0;
    console.log("スレッズ：Secrets の鍵を使います");
  }
  if (Date.now() - at > 7 * 864e5) {
    try {
      tok = await th.refreshToken(tok);
      console.log("スレッズのトークンを更新しました");
    } catch (e) {
      console.log("スレッズのトークン更新は失敗（今の鍵で続けます）: " + e.message);
    }
    if (Array.isArray(list)) await put(g ? g.url : "https://api.github.com/gists", g ? "PATCH" : "POST", tok);
  }
  return (thToken = tok);
}

// ---- スレッズにも（スレッズ用に書き直して）。トークンが無い時は何もしない ----
async function toThreads(item, text) {
  if (!cfg.threadsUserId || cfg.threads === false) return;
  const token = await threadsToken();
  if (!token) return;
  const th = require("./lib/threads");
  const imgs = (item.images?.length ? item.images : [item.image]).filter(Boolean);
  const id = await th.postToThreads({
    token,
    userId: cfg.threadsUserId,
    imageUrls: imgs.map((p) => `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/main/${p}`),
    text: text || th.threadsText(item, `${cfg.hashtags.default} ${cfg.hashtags.portrait}`),
  });
  if (id) console.log("スレッズにも投稿しました");
  return id;
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
    try {
      await buildReels();
    } catch (e) {
      console.log("リールの動画づくりに失敗: " + e.message.slice(0, 300));
      try {
        setStatus("リールの動画: " + (e.message + " " + String(e.stderr || "").slice(-300)).slice(0, 400));
      } catch {}
    }
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

  // グリッドの統一感：明るい写真（昼など）が2枚続かないよう、直前が明るければ次の3枚から暗めの写真を先に出す
  const lumOf = async (it) => {
    try {
      const st = await require("sharp")(path.join(ROOT, it.image || it.images[0])).stats();
      return Math.round(0.299 * st.channels[0].mean + 0.587 * st.channels[1].mean + 0.114 * st.channels[2].mean);
    } catch {
      return null;
    }
  };
  const BRIGHT = 110;
  const lastFeed = [...posted].reverse().find((p) => !p.kind && typeof p.lum === "number");
  let item = queue[0];
  let lum = await lumOf(item);
  if (lastFeed && lastFeed.lum >= BRIGHT && lum >= BRIGHT) {
    for (const alt of queue.slice(1, 4)) {
      const l = await lumOf(alt);
      if (l !== null && l < BRIGHT) {
        console.log(`明るい写真が続くので、先に ${alt.id} を投稿します（グリッドの統一感）`);
        item = alt;
        lum = l;
        break;
      }
    }
  }
  // 前回、投稿後の記録だけ失敗していた場合は記録だけ直す（二重投稿しない）
  if (posted.some((p) => p.id === item.id)) {
    console.log("投稿済みの写真が予約に残っていたので外します: " + item.id);
    return record(item, null);
  }
  const { pub, info } = await publish(item);
  let thr = null;
  let thErr = null;
  try {
    thr = await toThreads(item); // 画像が消える前に
  } catch (e) {
    console.log("スレッズへの投稿は失敗: " + e.message);
    thErr = e.message;
    try {
      setStatus("スレッズ: " + e.message.slice(0, 250));
    } catch {}
  }
  // 「新しい投稿」のストーリー用の画像を、元の画像が消える前に作っておく（投稿のたびに）
  let storyRel = null;
  if (storyCfg().newPost) { // 投稿のたびに毎回
    try {
      storyRel = `specials/auto/newpost-${item.id}.jpg`;
      await composeStory(fs.readFileSync(path.join(ROOT, item.image || item.images[0])), "newpost", storyRel);
    } catch (e) {
      console.log("新しい投稿のストーリー画像を作れませんでした: " + e.message);
      storyRel = null;
    }
  }
  const { image, images, thumb, ...rest } = item;
  record(item, { ...rest, count: (images || [image]).length, threads: thr?.permalink || (thr ? true : null), threadsError: thErr, mediaId: pub.id, permalink: info.permalink, mediaUrl: info.media_url, postedAt: new Date().toISOString(), day: today, slot, lum });
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
    try {
      await refreshExplore();
    } catch (e) {
      console.log("交流リストの取得に失敗: " + e.message);
    }
    try {
      await refreshComments();
    } catch (e) {
      console.log("コメントの取得に失敗: " + e.message);
    }
    try {
      await refreshTagged();
    } catch (e) {
      console.log("タグ付けの取得に失敗: " + e.message);
    }
    try {
      if (process.env.GIST_TOKEN && nowJst().min < 10) await threadsToken(); // 投稿がない日も、毎日0時台に1回確かめて更新
    } catch (e) {
      console.log("スレッズのトークンの確認に失敗: " + e.message);
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
