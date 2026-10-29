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

// 撮影データ「85mm／f1.8／1/160秒／ISO1600」（機材名は入れない）。Lightroom の xmp.exif でも exifr の結果でも読める
const num = (v) => (Array.isArray(v) ? v[0] / v[1] : typeof v === "string" && v.includes("/") ? +v.split("/")[0] / +v.split("/")[1] : Number(v));
function shotLine(ex) {
  if (!ex) return null;
  const fl = num(ex.FocalLength);
  const f = num(ex.FNumber);
  const t = num(ex.ExposureTime);
  const iso = Array.isArray(ex.ISOSpeedRatings) ? ex.ISOSpeedRatings[0] : ex.ISOSpeedRatings ?? ex.ISO;
  const parts = [];
  if (fl > 0) parts.push(`${Math.round(fl)}mm`);
  if (f > 0) parts.push(`f${+f.toFixed(1)}`);
  if (t > 0) parts.push(t >= 1 ? `${+t.toFixed(1)}秒` : `1/${Math.round(1 / t)}秒`);
  if (iso > 0) parts.push(`ISO${iso}`);
  return parts.length >= 3 ? parts.join("／") : null;
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

// インスタ用は長辺2560pxで取る（縦位置でも幅1440px以上を確保。2048だと縦写真が幅1365pxになり画質が落ちる）。
// 2560 はLightroomに作成を頼んでから数秒〜数十秒でできるので、まとめて頼んでから順に取りに行く。
async function fetchRendition(lr, assetId, requested) {
  const base = `${LR}/v2/catalogs/${lr.catalogId}/assets/${assetId}/renditions`;
  for (let i = 0; i < 25; i++) {
    const rr = await fetch(`${base}/2560`, { headers: lr.headers });
    if (rr.ok) return { buf: Buffer.from(await rr.arrayBuffer()), size: "2560" };
    if (!requested.has(assetId)) {
      requested.add(assetId);
      await requestRenditions(lr, [assetId]);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  const rr = await fetch(`${base}/2048`, { headers: lr.headers });
  if (rr.ok) return { buf: Buffer.from(await rr.arrayBuffer()), size: "2048" };
  return null;
}
async function requestRenditions(lr, ids) {
  await Promise.all(
    ids.map((id) =>
      fetch(`${LR}/v2/catalogs/${lr.catalogId}/assets/${id}/renditions`, {
        method: "POST",
        headers: { ...lr.headers, "X-Generate-Renditions": "2560", "Content-Length": "0" },
      }).catch(() => null)
    )
  );
}

// アルバムの写真の一覧（asset）
async function listAlbum(lr, albumName) {
  const albums = await lr.get(`/v2/catalogs/${lr.catalogId}/albums`);
  const album = (albums.resources || []).find((a) => a.payload?.name === albumName);
  if (!album) return null;
  const out = [];
  let next = `/v2/catalogs/${lr.catalogId}/albums/${album.id}/assets?subtype=image&embed=asset&limit=100`;
  while (next) {
    const page = await lr.get(next);
    for (const res of page.resources || []) {
      const asset = res.asset || res;
      if (asset.id) out.push(asset);
    }
    next = nextPath(page);
  }
  return out;
}

// アルバムの写真のうち、まだ取り込んでいないものをダウンロード
async function pullAlbum({ configPath, albumName, outDir, doneIds }) {
  const lr = await connect(configPath);
  const assets = await listAlbum(lr, albumName);
  if (!assets) {
    console.log(`  Lightroomにアルバム「${albumName}」がありません（スキップ）`);
    return [];
  }
  const todo = assets.filter((a) => !doneIds.has(a.id));
  // 先に全部まとめて 2560 の作成を頼んでおく
  const requested = new Set();
  for (let i = 0; i < todo.length; i += 20) {
    const ids = todo.slice(i, i + 20).map((a) => a.id);
    await requestRenditions(lr, ids);
    ids.forEach((id) => requested.add(id));
  }
  const got = [];
  for (const asset of todo) {
    const base = (asset.payload?.importSource?.fileName || asset.id).replace(/.[^.]+$/, "");
    const r = await fetchRendition(lr, asset.id, requested);
    if (!r) {
      console.log(`  skip ${base}（Lightroomでプレビュー生成待ちの可能性）`);
      continue;
    }
    const file = path.join(outDir, `${base}.jpg`);
    fs.writeFileSync(file, r.buf);
    got.push({ file, lrId: asset.id, lrEdited: asset.payload?.develop?.userUpdated || null, takenAt: asset.payload?.captureDate || null, gps: findGps(asset.payload), shot: shotLine(asset.payload?.xmp?.exif) });
    console.log(`  + ${base}.jpg${r.size === "2560" ? "" : "（2048）"}`);
  }
  return got;
}

// Lightroomで編集し直した写真の、新しい編集が反映された 2560 を取る（since より新しくなるまで待つ）
async function fetchFresh(lr, assetId, since) {
  const url = `${LR}/v2/catalogs/${lr.catalogId}/assets/${assetId}/renditions/2560`;
  await requestRenditions(lr, [assetId]);
  const t = Date.parse(since) - 60e3;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const r = await fetch(url, { headers: lr.headers });
    if (r.ok && Date.parse(r.headers.get("last-modified") || 0) >= t) return Buffer.from(await r.arrayBuffer());
    if (i === 10) await requestRenditions(lr, [assetId]);
  }
  return null;
}

module.exports = { shotLine, pullAlbum, connect, listAlbum, fetchRendition, requestRenditions, fetchFresh };
