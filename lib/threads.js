// スレッズ：投稿と本文づくり
//   ・トークンは GitHub の Secrets（THREADS_TOKEN）。60日で切れるので、PC が毎週新しいトークンを用意し（plan.js）、
//     50日たったらアプリで入れ直しをお知らせする
//   ・本文はスレッズ用に短く（撮影日・場所・回から組み立てる。AIの文章は使わない）、ハッシュタグは1つ
const API = "https://graph.threads.net/v1.0";

async function call(method, p, params, token) {
  const body = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(method === "GET" ? `${API}${p}?${body}` : `${API}${p}`, method === "GET" ? {} : { method, body });
  const j = await r.json();
  if (j.error) throw new Error(`threads ${p}: ${j.error.message}`);
  return j;
}
async function waitReady(id, token) {
  for (let i = 0; i < 20; i++) {
    const s = await call("GET", `/${id}`, { fields: "status,error_message" }, token).catch(() => ({}));
    if (s.status === "FINISHED") return;
    if (s.status === "ERROR") throw new Error("スレッズ側で画像の処理に失敗: " + (s.error_message || ""));
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// imageUrls: 公開URL（1〜20枚） / text: 本文（500字まで）
async function postToThreads({ token, userId, imageUrls, text }) {
  const t = String(text || "").slice(0, 500);
  let id;
  if (imageUrls.length > 1) {
    const kids = [];
    for (const u of imageUrls.slice(0, 20)) kids.push((await call("POST", `/${userId}/threads`, { media_type: "IMAGE", image_url: u, is_carousel_item: "true" }, token)).id);
    for (const k of kids) await waitReady(k, token);
    id = (await call("POST", `/${userId}/threads`, { media_type: "CAROUSEL", children: kids.join(","), text: t }, token)).id;
  } else {
    id = (await call("POST", `/${userId}/threads`, { media_type: "IMAGE", image_url: imageUrls[0], text: t }, token)).id;
  }
  await waitReady(id, token);
  const pubId = (await call("POST", `/${userId}/threads_publish`, { creation_id: id }, token)).id;
  const info = await call("GET", `/${pubId}`, { fields: "permalink" }, token).catch(() => ({}));
  return { id: pubId, permalink: info.permalink || null };
}

// 60日の期限を延ばす（新しいトークンが返る）
async function refreshToken(token) {
  const r = await (await fetch(`https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${token}`)).json();
  if (!r.access_token) throw new Error("スレッズのトークンを更新できません: " + JSON.stringify(r).slice(0, 150));
  return r.access_token;
}

// スレッズ用の本文：「10/4 鎌倉で撮った一枚📷」＋撮影データ「85mm／f1.8／1/160秒／ISO1600」＋話題タグ1つ
function threadsText(item, baseTags) {
  const cap = item.caption || "";
  const head = cap.split(/\n\s*\n/)[0] || "";
  const ev = /東京フォトウォークサークル/.test(head) ? head.replace(/📷/g, "").replace(/\s*\n\s*/g, " ").trim() : "";
  const md = item.date ? `${+item.date.slice(5, 7)}/${+item.date.slice(8, 10)}` : "";
  const place = item.locationName || "";
  const line = ev ? `${ev}で撮った一枚📷` : place ? `${md ? md + " " : ""}${place}で撮った一枚📷` : `${md ? md + "に" : ""}撮った一枚📷`;
  return [line, item.shot || "", topicTag(item, baseTags)].filter(Boolean).join("\n");
}

// 話題タグ（スレッズは1投稿1つ。そのタグの話題ページに載る）
//   フォトウォークの回 → #フォトウォーク / ポートレート → #ポートレート / 写真ならではのタグ（#東京タワー #ハロウィン など）→ それ / 夜 → #夜景 / それ以外 → #ストリートスナップ
function topicTag(item, baseTags) {
  const cap = item.caption || "";
  if (/東京フォトウォークサークル/.test(cap.split(/\n\s*\n/)[0] || "")) return "#フォトウォーク";
  if (item.portrait) return "#ポートレート";
  const base = new Set(String(baseTags || "").split(/\s+/));
  const extra = (cap.match(/#[^\s#]+/g) || []).find((t) => !base.has(t));
  if (extra) return extra;
  if (item.tone === "dark") return "#夜景";
  return "#ストリートスナップ";
}

// 返信する（文字だけ）
async function replyTo({ token, userId, replyToId, text }) {
  const id = (await call("POST", `/${userId}/threads`, { media_type: "TEXT", text: String(text).slice(0, 500), reply_to_id: replyToId }, token)).id;
  await waitReady(id, token);
  return (await call("POST", `/${userId}/threads_publish`, { creation_id: id }, token)).id;
}
// 返信を非表示／表示に戻す
async function hideReply({ token, replyId, hide }) {
  return call("POST", `/${replyId}/manage_reply`, { hide: hide ? "true" : "false" }, token);
}
// 自分の最近の投稿と、その反応・返信（他の人から）
async function recent({ token, me, limit = 20 }) {
  const list = (await call("GET", "/me/threads", { fields: "id,permalink,timestamp,media_url,thumbnail_url,text,is_reply", limit: String(limit) }, token)).data || [];
  const posts = [];
  const replies = [];
  for (const p of list.filter((x) => !x.is_reply)) {
    const ins = await call("GET", `/${p.id}/insights`, { metric: "views,likes,replies,reposts,quotes" }, token).catch(() => ({ data: [] }));
    const v = Object.fromEntries((ins.data || []).map((m) => [m.name, m.values?.[0]?.value ?? m.total_value?.value ?? 0]));
    posts.push({ id: p.id, url: p.permalink, at: p.timestamp, img: p.media_url || p.thumbnail_url || null, text: (p.text || "").slice(0, 80), ...v });
    if (!v.replies) continue;
    const conv = (await call("GET", `/${p.id}/conversation`, { fields: "id,text,username,timestamp,replied_to,hide_status", limit: "100" }, token).catch(() => ({ data: [] }))).data || [];
    const mine = new Set(conv.filter((c) => c.username === me).map((c) => c.replied_to?.id));
    for (const c of conv.filter((c) => c.username !== me))
      replies.push({ id: "th:" + c.id, src: "threads", mediaId: p.id, url: p.permalink, img: p.media_url || p.thumbnail_url || null, username: c.username, text: c.text, at: c.timestamp, hidden: c.hide_status === "HIDDEN", replied: mine.has(c.id) });
  }
  return { posts, replies };
}

module.exports = { postToThreads, refreshToken, threadsText, replyTo, hideReply, recent };
