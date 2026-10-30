// crop-lock.js — インスタやサイトに載せた写真の「トリミング」を記録する（レタッチし直してもトリミングは載せた時と全く同じにするため）
//   ① クラウド版 Lightroom にある写真：クラウドのトリミングの数値（上下左右・角度）をそのまま使う
//   ② それ以外：あとで元の写真と見比べて求める（crop-fit.js）
//   node crop-lock.js → crop-lock.json（ファイル名・撮影時刻 → トリミング・どこに載せたか）
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
sharp.cache(false);
const { dhash, dist } = require("./lib/dedupe");
const { connect } = require("./lib/lightroom");
const cfg = require("./config.json");
const W = path.join(__dirname, ".work");
const CT = path.join(W, "cloudthumbs");
const OUT = path.join(__dirname, "crop-lock.json");
const SITES = [
  ["portfolio", "C:/Users/tanos/sites/portfolio-site/public/images"],
  ["portfolio", "C:/Users/tanos/sites/portfolio-site/public/images/gallery"],
  ["tpw", "C:/Users/tanos/sites/tpw-site/images"],
];

(async () => {
  fs.mkdirSync(CT, { recursive: true });
  const lr = await connect(cfg.lightroom.configPath);
  const C = `/v2/catalogs/${lr.catalogId}/assets`;
  const assets = JSON.parse(fs.readFileSync(path.join(W, "cloud-assets.json"), "utf8"));
  // クラウドの写真の小さい見本（トリミング・レタッチ後の見た目）
  for (const a of assets) {
    const f = path.join(CT, `${a.id}.jpg`);
    if (fs.existsSync(f)) continue;
    const r = await fetch(`https://lr.adobe.io${C}/${a.id}/renditions/640`, { headers: lr.headers });
    if (r.ok) fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  const ch = [];
  for (const a of assets) {
    const f = path.join(CT, `${a.id}.jpg`);
    if (fs.existsSync(f)) ch.push({ ...a, h: await dhash(f), ar: await sharp(f).metadata().then((m) => m.width / m.height) });
  }
  // 載せた写真の一覧（インスタ＋サイト）
  const refs = [];
  const ig = JSON.parse(fs.readFileSync(path.join(W, "igposted", "list.json"), "utf8"));
  for (const x of ig) refs.push({ where: "instagram", file: path.join(W, "igposted", `${x.id}.jpg`), link: x.link, at: x.at, n: x.n });
  for (const [where, dir] of SITES)
    for (const f of fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f))) refs.push({ where, file: path.join(dir, f), name: path.parse(f).name });
  const out = [];
  for (const r of refs) {
    if (!fs.existsSync(r.file)) continue;
    const h = await dhash(r.file);
    const m = await sharp(r.file).metadata();
    const ar = m.width / m.height;
    // 見た目が同じで、縦横の比率も同じ（＝同じトリミング）クラウドの写真
    let best = null;
    for (const c of ch) {
      const d = dist(h, c.h);
      if (Math.abs(c.ar - ar) < 0.03 && (!best || d < best.d)) best = { c, d };
    }
    const hit = best && best.d <= 10 ? best.c : null;
    out.push({ ...r, w: m.width, h: m.height, cloud: hit ? { id: hit.id, name: hit.name, t: hit.t, d: best.d } : null });
  }
  // クラウドで見つかった写真は、トリミングの数値を取る
  const crops = {};
  for (const o of out.filter((o) => o.cloud)) {
    const id = o.cloud.id;
    if (!crops[id]) {
      const r = await fetch(`https://lr.adobe.io${C}/${id}/xmp/develop`, { headers: lr.headers });
      const t = r.ok ? await r.text() : "";
      const g = (k) => (t.match(new RegExp(`crs:${k}="([^"]*)"`)) || [])[1];
      crops[id] = { top: +(g("CropTop") ?? 0), left: +(g("CropLeft") ?? 0), bottom: +(g("CropBottom") ?? 1), right: +(g("CropRight") ?? 1), angle: +(g("CropAngle") ?? 0), has: g("HasCrop") === "True" };
    }
    o.crop = crops[id];
    o.how = "cloud";
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  const by = (w) => out.filter((o) => o.where === w);
  for (const w of ["instagram", "portfolio", "tpw"]) console.log(`${w}: ${by(w).length}枚 → クラウドで数値が取れた ${by(w).filter((o) => o.crop).length}枚`);
})();
