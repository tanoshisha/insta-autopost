// クラウド版 Lightroom に「リール」フォルダと回ごとのアルバムを作って、写真を入れる（Edits で組む前に、iPhone の Lightroom で直せるように）
//   ・クラウドにもうある写真（「インスタ投稿」アルバムから来た queue の写真）は、そのままアルバムに追加
//   ・ない写真は、Classic で現像した見た目の JPEG（長辺2560）をアップロード（RAW は容量を食うので上げない）
//   ・アップロード済みの写真はファイル名で見分けて使い回す（作り直しても増えない）。並びから外れた写真はアルバムから外す
//   外部アプリから作れるのは project_set（フォルダ）と project（アルバム）だけ
const fs = require("fs");
const crypto = require("crypto");
const { connect } = require("./lightroom");
const LR = "https://lr.adobe.io";
const strip = (t) => t.replace(/^while\s*\(1\)\s*\{\}\s*/, "");
const newId = () => crypto.randomUUID().replace(/-/g, "");
const now = () => new Date().toISOString();

async function api(lr, method, p, body, type = "application/json") {
  const res = await fetch(`${LR}${p}`, { method, headers: { ...lr.headers, "Content-Type": type }, body: body == null ? undefined : type === "application/json" ? JSON.stringify(body) : body });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Lightroom API ${method} ${p} → ${res.status}: ${txt.slice(0, 900)}`);
  const t = strip(txt).trim();
  return t ? JSON.parse(t) : null;
}
const rel = (page, href) => {
  const u = new URL(href, page.base || "https://lr.adobe.io/v2/");
  return u.pathname + u.search;
};
async function all(lr, first) {
  const out = [];
  let next = first;
  while (next) {
    const page = await lr.get(next);
    out.push(...(page.resources || []));
    next = page.links?.next?.href ? rel(page, page.links.next.href) : null;
  }
  return out;
}
async function ensureAlbum(lr, list, name, subtype, parentId) {
  const hit = list.find((a) => a.payload?.name === name && a.subtype === subtype && (a.payload?.parent?.id || null) === (parentId || null));
  if (hit) return hit.id;
  const id = newId();
  const payload = { userCreated: now(), userUpdated: now(), name };
  if (parentId) payload.parent = { id: parentId };
  if (subtype === "project") payload.publishInfo = { serviceId: lr.cfg.clientId, servicePayload: "naoe-reel", created: now(), updated: now(), remoteLinks: {} };
  await api(lr, "PUT", `/v2/catalogs/${lr.catalogId}/albums/${id}`, { subtype, serviceId: lr.cfg.clientId, payload });
  list.push({ id, subtype, payload });
  return id;
}
async function uploadJpeg(lr, file, name, captureDate) {
  const id = newId();
  await api(lr, "PUT", `/v2/catalogs/${lr.catalogId}/assets/${id}`, {
    subtype: "image",
    payload: { captureDate: captureDate || "0000-00-00T00:00:00", userCreated: now(), userUpdated: now(), importSource: { fileName: name, importTimestamp: now(), importedBy: lr.cfg.clientId, importedOnDevice: "NAOE-PC" } },
  });
  await api(lr, "PUT", `/v2/catalogs/${lr.catalogId}/assets/${id}/master`, fs.readFileSync(file), "image/jpeg");
  return id;
}
// items: [{ file, name, assetId?, captureDate?, oldNames? }] を「リール/<albumName>」に
async function putReelAlbum(configPath, albumName, items) {
  const lr = await connect(configPath);
  const list = await all(lr, `/v2/catalogs/${lr.catalogId}/albums?limit=500`);
  const folder = await ensureAlbum(lr, list, "リール", "project_set", null);
  const album = await ensureAlbum(lr, list, albumName, "project", folder);
  // もうアルバムに入っている写真（ファイル名 → id）
  const inAlbum = await all(lr, `/v2/catalogs/${lr.catalogId}/albums/${album}/assets?embed=asset&limit=500`);
  const byName = {};
  for (const r of inAlbum) {
    const fn = r.asset?.payload?.importSource?.fileName;
    if (fn) byName[fn] = r.asset.id;
  }
  const ids = [];
  let uploaded = 0;
  for (const it of items) {
    let id = it.assetId || byName[it.name] || (it.oldNames || []).map((n) => byName[n]).find(Boolean);
    if (!id) {
      id = await uploadJpeg(lr, it.file, it.name, it.captureDate);
      uploaded++;
    }
    ids.push(id);
  }
  const have = new Set(inAlbum.map((r) => r.asset?.id).filter(Boolean));
  const add = ids.filter((id) => !have.has(id));
  if (add.length) await api(lr, "PUT", `/v2/catalogs/${lr.catalogId}/albums/${album}/assets`, { resources: add.map((id) => ({ id, payload: { userCreated: now(), userUpdated: now() } })) });
  // 並びから外れた写真はアルバムから外す（写真そのものはクラウドに残る）
  const extra = inAlbum.map((r) => r.asset?.id).filter((id) => id && !ids.includes(id));
  if (extra.length) {
    try {
      await api(lr, "DELETE", `/v2/catalogs/${lr.catalogId}/albums/${album}/assets?asset_ids=${extra.join(",")}`);
    } catch {}
  }
  return { album, assets: ids, uploaded, removed: extra.length };
}
module.exports = { putReelAlbum };
