// Lightroom（クラウド）API: 指定アルバムの新しい写真をダウンロードする。
// 認証情報は photo-publisher と共有（lr-cloud.config.json）。
// Adobeのリフレッシュトークンは約2週間で切れるので、新しいトークンが返ってきたら毎回保存して延命する。
const fs = require("fs");
const path = require("path");

const IMS = "https://ims-na1.adobelogin.com/ims";
const LR = "https://lr.adobe.io";
const SCOPES = "openid,AdobeID,offline_access,lr_partner_apis,lr_partner_rendition_apis";

// 次ページのURL（href は page.base からの相対パスで返ってくる）
function nextPath(page) {
  const href = page.links?.next?.href;
  if (!href) return null;
  const u = new URL(href, page.base || "https://lr.adobe.io/v2/");
  return u.pathname + u.search;
}
const strip = (t) => t.replace(/^while\s*\(1\)\s*\{\}\s*/, "");

async function connect(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const r = await fetch(`${IMS}/token/v3`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      scope: SCOPES,
    }),
  });
  if (!r.ok) {
    const err = new Error(`Lightroomの認証が切れています（${r.status}）。photo-publisher で npm run lr:auth を実行してください。`);
    err.code = "LR_AUTH";
    throw err;
  }
  const tok = await r.json();
  if (tok.refresh_token && tok.refresh_token !== cfg.refreshToken) {
    cfg.refreshToken = tok.refresh_token;
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  }
  const headers = { "X-API-Key": cfg.clientId, Authorization: `Bearer ${tok.access_token}` };
  const get = async (p) => {
    const res = await fetch(`${LR}${p}`, { headers });
    const txt = await res.text();
    if (!res.ok) throw new Error(`Lightroom API ${p} → ${res.status}: ${txt.slice(0, 200)}`);
    return JSON.parse(strip(txt));
  };
  const catalogId = (await get("/v2/catalog")).id;
  return { cfg, headers, get, catalogId };
}

// payload の中から緯度経度っぽい値を探す（APIの形が版で揺れても拾えるように）
function findGps(payload) {
  let found = null;
  const walk = (o) => {
    if (!o || typeof o !== "object" || found) return;
    const lat = o.latitude ?? o.lat ?? o.GPSLatitude;
    const lng = o.longitude ?? o.lng ?? o.lon ?? o.GPSLongitude;
    if (typeof lat === "number" && typeof lng === "number") return (found = { lat, lng });
    for (const v of Object.values(o)) walk(v);
  };
  walk(payload);
  return found;
}

// アルバムの写真のうち、まだ取り込んでいないものをダウンロード
async function pullAlbum({ configPath, albumName, outDir, doneIds }) {
  const lr = await connect(configPath);
  const albums = await lr.get(`/v2/catalogs/${lr.catalogId}/albums`);
  const album = (albums.resources || []).find((a) => a.payload?.name === albumName);
  if (!album) {
    console.log(`  Lightroomにアルバム「${albumName}」がありません（スキップ）`);
    return [];
  }
  const got = [];
  let next = `/v2/catalogs/${lr.catalogId}/albums/${album.id}/assets?subtype=image&embed=asset&limit=100`;
  while (next) {
    const page = await lr.get(next);
    for (const res of page.resources || []) {
      const asset = res.asset || res;
      if (!asset.id || doneIds.has(asset.id)) continue;
      const base = (asset.payload?.importSource?.fileName || asset.id).replace(/\.[^.]+$/, "");
      const rr = await fetch(`${LR}/v2/catalogs/${lr.catalogId}/assets/${asset.id}/renditions/2048`, { headers: lr.headers });
      if (!rr.ok) {
        console.log(`  skip ${base}（rendition ${rr.status}・Lightroomでプレビュー生成待ちの可能性）`);
        continue;
      }
      const file = path.join(outDir, `${base}.jpg`);
      fs.writeFileSync(file, Buffer.from(await rr.arrayBuffer()));
      got.push({
        file,
        lrId: asset.id,
        takenAt: asset.payload?.captureDate || null,
        gps: findGps(asset.payload),
      });
      console.log(`  + ${base}.jpg`);
    }
    next = nextPath(page);
  }
  return got;
}

module.exports = { pullAlbum, connect };
