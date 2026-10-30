// クラウド版 Lightroom の「リール」アルバム（本人が Lightroom のアプリで作った普通のアルバム）に、リールの写真を入れる
//   ・外部アプリからは普通のアルバムを作れない（作れるのはアプリに出ない種類だけ）ので、アルバムは本人が1つ作ったものを使う
//   ・クラウドにもうある写真（「インスタ投稿」から来た queue の写真）は、そのままアルバムに追加
//   ・ない写真は、Classic で現像した見た目の JPEG（長辺2560）をアップロード（RAW は容量を食うので上げない）
//   ・アップロード済みの写真は lr-cloud-ids.json（ファイル名 → クラウドの id）で覚えて使い回す
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { connect } = require("./lightroom");
const LR = "https://lr.adobe.io";
const IDS = path.join(__dirname, "..", "lr-cloud-ids.json");
const strip = (t) => t.replace(/^while\s*\(1\)\s*\{\}\s*/, "");
const newId = () => crypto.randomUUID().replace(/-/g, "");
const now = () => new Date().toISOString();

async function api(lr, method, p, body, type = "application/json") {
  const res = await fetch(`${LR}${p}`, { method, headers: { ...lr.headers, "Content-Type": type }, body: body == null ? undefined : type === "application/json" ? JSON.stringify(body) : body });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Lightroom API ${method} ${p} → ${res.status}: ${txt.slice(0, 300)}`);
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
async function uploadJpeg(lr, file, name, captureDate) {
  const id = newId();
  await api(lr, "PUT", `/v2/catalogs/${lr.catalogId}/assets/${id}`, {
    subtype: "image",
    payload: { captureDate: captureDate || "0000-00-00T00:00:00", userCreated: now(), userUpdated: now(), importSource: { fileName: name, importTimestamp: now(), importedBy: lr.cfg.clientId, importedOnDevice: "NAOE-PC" } },
  });
  await api(lr, "PUT", `/v2/catalogs/${lr.catalogId}/assets/${id}/master`, fs.readFileSync(file), "image/jpeg");
  return id;
}
const loadIds = () => {
  try {
    return JSON.parse(fs.readFileSync(IDS, "utf8"));
  } catch {
    return {};
  }
};

// items: [{ file, name, assetId?, captureDate?, oldNames? }] を、クラウドのアルバム albumName（普通のアルバム）へ
async function putIntoAlbum(configPath, albumName, items) {
  const lr = await connect(configPath);
  const albums = await all(lr, `/v2/catalogs/${lr.catalogId}/albums?limit=500`);
  const album = albums.find((a) => a.subtype === "collection" && a.payload?.name === albumName);
  if (!album) throw new Error(`クラウドの Lightroom にアルバム「${albumName}」がありません（Lightroom のアプリで作ってください）`);
  const ids = loadIds();
  const inAlbum = new Set((await all(lr, `/v2/catalogs/${lr.catalogId}/albums/${album.id}/assets?limit=500`)).map((r) => r.asset?.id || r.id));
  const out = [];
  let uploaded = 0;
  for (const it of items) {
    let id = it.assetId || ids[it.name] || (it.oldNames || []).map((n) => ids[n]).find(Boolean);
    if (!id) {
      id = await uploadJpeg(lr, it.file, it.name, it.captureDate);
      ids[it.name] = id;
      fs.writeFileSync(IDS, JSON.stringify(ids, null, 1));
      uploaded++;
    }
    out.push(id);
  }
  const add = out.filter((id) => !inAlbum.has(id));
  if (add.length) await api(lr, "PUT", `/v2/catalogs/${lr.catalogId}/albums/${album.id}/assets`, { resources: add.map((id) => ({ id, payload: { userCreated: now(), userUpdated: now() } })) });
  return { assets: out, uploaded, added: add.length };
}

// これまでに上げた写真（このPCの仕組みが上げたもの）を、ファイル名 → id で覚え直す
async function rememberUploaded(configPath, since) {
  const lr = await connect(configPath);
  const ids = loadIds();
  const list = await all(lr, `/v2/catalogs/${lr.catalogId}/assets?subtype=image&limit=100&updated_since=${encodeURIComponent(since)}`);
  let n = 0;
  for (const r of list) {
    const s = r.payload?.importSource;
    if (s?.importedBy === lr.cfg.clientId && s.fileName && !ids[s.fileName]) (ids[s.fileName] = r.id), n++;
  }
  fs.writeFileSync(IDS, JSON.stringify(ids, null, 1));
  return n;
}
module.exports = { putIntoAlbum, rememberUploaded };
