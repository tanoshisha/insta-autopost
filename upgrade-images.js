// upgrade-images.js — 予約中・見送り中の画像を、Lightroomの長辺2560pxから作り直す（1回だけ使う移行用）。
//   以前は2048pxから作っていたため、縦位置の写真が幅1365pxになっていた。
//   4:5に切り抜いた写真は、今の画像と見比べて同じ位置で切り抜く（構図は変えない）。
//   node upgrade-images.js [--dry]
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const sharp = require("sharp");
sharp.cache(false); // Windowsで、読んだ画像を同じ場所に書き戻せるように（ファイルを掴みっぱなしにしない）
const { connect, listAlbum, fetchRendition, requestRenditions } = require("./lib/lightroom");
const { makeSync } = require("./lib/sync");

const ROOT = __dirname;
const DRY = process.argv.includes("--dry");
const LIMIT = +(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] || Infinity);
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const git = (a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const remote = (p, d) => {
  try {
    return JSON.parse(git(["show", `origin/main:${p}`]));
  } catch {
    return d;
  }
};

// 今の画像が、新しい元画像のどの高さで切り抜かれていたかを探す（小さくして差が一番小さい位置）
async function findTop(srcBuf, w, h, curPath) {
  const SW = 96;
  const ch = Math.round(w / 0.8);
  const hs = Math.round((h * SW) / w);
  const hc = Math.round((ch * SW) / w);
  const big = await sharp(srcBuf).resize(SW, hs, { fit: "fill" }).greyscale().raw().toBuffer();
  const cur = await sharp(fs.readFileSync(curPath)).resize(SW, hc, { fit: "fill" }).greyscale().raw().toBuffer();
  let best = 0;
  let bestD = Infinity;
  for (let off = 0; off <= hs - hc; off++) {
    let d = 0;
    for (let i = 0; i < cur.length && d < bestD; i++) d += Math.abs(cur[i] - big[off * SW + i]);
    if (d < bestD) (bestD = d), (best = off);
  }
  return Math.min(Math.max(Math.round((best * h) / hs), 0), h - ch);
}

async function makeImage(srcBuf, dest, curPath) {
  const buf = await sharp(srcBuf).rotate().toBuffer();
  const { width: w, height: h } = await sharp(buf).metadata();
  let img = sharp(buf);
  if (w / h < 0.8) {
    const ch = Math.round(w / 0.8);
    const top = fs.existsSync(curPath) ? await findTop(buf, w, h, curPath) : Math.round((h - ch) / 2);
    img = img.extract({ left: 0, top, width: w, height: ch });
  } else if (w / h > 1.91) {
    const cw = Math.round(h * 1.91);
    img = img.extract({ left: Math.round((w - cw) / 2), top: 0, width: cw, height: h });
  }
  const out = await img
    .resize({ width: cfg.image.width, withoutEnlargement: true, kernel: "lanczos3" })
    .sharpen({ sigma: 0.5 })
    .toColorspace("srgb")
    .jpeg({ quality: cfg.image.quality, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toBuffer();
  fs.writeFileSync(dest, out);
  return sharp(out).metadata();
}

async function main() {
  git(["fetch", "-q", "origin", "main"]);
  const items = [...remote("queue.json", []), ...remote("pool.json", [])];
  const byHash = new Map(items.map((x) => [x.id.split("_").pop(), x]));
  const byLr = new Map(items.filter((x) => x.lrId).map((x) => [x.lrId, x]));
  console.log(`予約・見送り ${items.length}枚`);

  const lr = await connect(cfg.lightroom.configPath);
  const assets = await listAlbum(lr, cfg.lightroom.albumName);
  console.log(`Lightroomのアルバム ${assets.length}枚 → 対応を調べています…`);
  // まだ lrId を知らない写真は、2048px（前回と同じ画像）のハッシュで対応づける
  const pairs = [];
  for (const a of assets) {
    if (pairs.length >= LIMIT) break;
    let it = byLr.get(a.id);
    if (!it) {
      const r = await fetch(`https://lr.adobe.io/v2/catalogs/${lr.catalogId}/assets/${a.id}/renditions/2048`, { headers: lr.headers });
      if (!r.ok) continue;
      const hash = crypto.createHash("sha1").update(Buffer.from(await r.arrayBuffer())).digest("hex").slice(0, 12);
      it = byHash.get(hash);
    }
    if (it) pairs.push({ it, lrId: a.id });
  }
  console.log(`対応がとれた写真 ${pairs.length}枚（iPhoneから追加した写真などは対象外）`);

  const requested = new Set(pairs.map((p) => p.lrId));
  for (let i = 0; i < pairs.length; i += 20) await requestRenditions(lr, pairs.slice(i, i + 20).map((p) => p.lrId));

  const outDir = DRY ? path.join(ROOT, ".work", "upgrade") : ROOT;
  fs.mkdirSync(path.join(outDir, "queue", "thumbs"), { recursive: true });
  const files = [];
  const lrIds = {};
  let n = 0;
  for (const { it, lrId } of pairs) {
    const r = await fetchRendition(lr, lrId, requested);
    n++;
    if (!r || r.size !== "2560") {
      console.log(`  - ${it.id} 2560が取れず、そのまま`);
      continue;
    }
    const dest = path.join(outDir, it.image);
    const m = await makeImage(r.buf, dest, path.join(ROOT, it.image));
    await sharp(dest).resize({ width: 480 }).jpeg({ quality: 78 }).toFile(path.join(outDir, it.thumb || `queue/thumbs/${it.id}.jpg`));
    files.push(it.image, it.thumb || `queue/thumbs/${it.id}.jpg`);
    lrIds[it.id] = lrId;
    console.log(`  ✓ ${n}/${pairs.length} ${it.id} → ${m.width}x${m.height}`);
  }
  if (DRY) return console.log(`[お試し] ${Object.keys(lrIds).length}枚を .work/upgrade に作りました`);
  const ok = makeSync(ROOT)(`画像を高画質に作り直し（${Object.keys(lrIds).length}枚）`, files, (rem) => {
    const add = (x) => (lrIds[x.id] ? { ...x, lrId: lrIds[x.id] } : x);
    return { "queue.json": rem("queue.json", []).map(add), "pool.json": rem("pool.json", []).map(add) };
  });
  console.log(ok ? `✅ ${Object.keys(lrIds).length}枚を作り直しました` : "変更なし");
}

main().catch((e) => {
  console.error("エラー: " + e.message);
  process.exit(1);
});
