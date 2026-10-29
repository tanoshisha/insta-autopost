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
  return (await call("POST", `/${userId}/threads_publish`, { creation_id: id }, token)).id;
}

// 60日の期限を延ばす（新しいトークンが返る）
async function refreshToken(token) {
  const r = await (await fetch(`https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${token}`)).json();
  if (!r.access_token) throw new Error("スレッズのトークンを更新できません: " + JSON.stringify(r).slice(0, 150));
  return r.access_token;
}

// スレッズ用の本文：「10/4 鎌倉で撮った一枚📷」＋ハッシュタグ1つ
function threadsText(item, baseTags) {
  const cap = item.caption || "";
  const head = cap.split(/\n\s*\n/)[0] || "";
  const ev = /東京フォトウォークサークル/.test(head) ? head.replace(/📷/g, "").replace(/\s*\n\s*/g, " ").trim() : "";
  const md = item.date ? `${+item.date.slice(5, 7)}/${+item.date.slice(8, 10)}` : "";
  const place = item.locationName || "";
  const line = ev ? `${ev}で撮った一枚📷` : place ? `${md ? md + " " : ""}${place}で撮った一枚📷` : `${md ? md + "に" : ""}撮った一枚📷`;
  const base = new Set(String(baseTags || "").split(/\s+/));
  const extra = (cap.match(/#[^\s#]+/g) || []).find((t) => !base.has(t));
  const tag = extra || (place ? `#${place.replace(/\s+/g, "")}` : "#写真");
  return `${line}\n${tag}`;
}

module.exports = { postToThreads, refreshToken, threadsText };
