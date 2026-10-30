// crop-lock-fit.js — 載せた写真が Classic のどの写真か特定して、トリミングの数値を決める（crop-lock.json に書き足す）
//   クラウドに数値がある写真はそれを使う。ない写真は、元の写真と見比べて求める（lib/crop-fit.js）
//   候補：サイトの写真はファイル名、インスタの写真は CLIP で似ている写真（＋その前後20秒の写真＝連写の別のコマ）
//   node crop-lock-fit.js
const fs = require("fs");
const path = require("path");
const { fitCrop, toLrCrop } = require("./lib/crop-fit");
const { fullFrame, byId, byName, near } = require("./lib/fullframe");
const OUT = path.join(__dirname, "crop-lock.json");
const refs = JSON.parse(fs.readFileSync(OUT, "utf8"));
const save = () => fs.writeFileSync(OUT, JSON.stringify(refs, null, 1));
const closest = (rows, t) => rows.sort((a, b) => Math.abs(Date.parse(a.t) - Date.parse(t)) - Math.abs(Date.parse(b.t) - Date.parse(t)))[0];
const MIN = 30; // 合った特徴点がこれ未満なら、別の写真とみなす

(async () => {
  const srcCache = new Map();
  const src = async (row) => {
    if (!srcCache.has(row.id)) {
      if (srcCache.size > 30) srcCache.delete(srcCache.keys().next().value);
      srcCache.set(row.id, await fullFrame(row).catch(() => null));
    }
    return srcCache.get(row.id);
  };
  let done = 0;
  for (const r of refs) {
    if (r.lr) continue;
    // ① クラウドに数値がある
    if (r.crop && r.cloud) {
      const base = r.cloud.name.replace(/\.[^.]+$/, "").replace(/-Enhanced-SR$/, "");
      const row = closest(byName(base), r.cloud.t);
      r.lr = row ? { id: row.id, name: row.name, t: row.t, crop: { left: r.crop.left, top: r.crop.top, right: r.crop.right, bottom: r.crop.bottom, angle: r.crop.angle }, how: "cloud" } : { none: "Classic にない" };
      continue;
    }
    // ② 候補を集める
    let rows = [];
    if (r.name) rows = byName(r.name);
    if (!rows.length && r.cands?.[0]?.s >= 0.8) {
      for (const c of r.cands.filter((c) => c.s >= 0.8)) {
        const b = byId(c.id);
        if (b) rows.push(b, ...near(b.t, 20));
      }
    }
    // 同じ撮影時刻（RAW と JPEG の組）は1つに
    const seen = new Set();
    rows = rows.filter((x) => (seen.has(x.t) ? false : seen.add(x.t)));
    if (!rows.length) {
      r.lr = { none: "候補なし（人が写っている写真など、レタッチし直さない写真）" };
      continue;
    }
    let best = null;
    for (const row of rows.slice(0, 12)) {
      const s = await src(row);
      if (!s) continue;
      const f = await fitCrop(r.file, s).catch(() => null);
      if (f?.ok && (!best || f.inliers > best.f.inliers)) best = { row, f };
    }
    if (best && best.f.inliers >= MIN) {
      r.lr = { id: best.row.id, name: best.row.name, t: best.row.t, crop: toLrCrop(best.f, best.row.o), how: "fit", inliers: best.f.inliers };
    } else r.lr = { none: "元の写真が見つからない", tried: rows.length, inliers: best?.f.inliers || 0 };
    if (++done % 10 === 0) save(), console.log(`${done}枚…`);
  }
  save();
  const ok = refs.filter((r) => r.lr?.crop);
  for (const w of ["instagram", "portfolio", "tpw"]) {
    const a = refs.filter((r) => r.where === w);
    console.log(`${w}: ${a.length}枚 → トリミングが決まった ${a.filter((r) => r.lr?.crop).length}枚`);
  }
  console.log(`合計 ${ok.length}枚（Classic の写真 ${new Set(ok.map((r) => r.lr.id)).size}枚）`);
  process.exit(0);
})();
