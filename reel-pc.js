// reel-pc.js — リールの動画を、このPCの After Effects で作る（予約されたリール・アプリで作り直しを頼まれたリール）
//   node reel-pc.js        … 10分ごとにタスクスケジューラから（作るものが無ければすぐ終わる）
//   PCが消えている間は、GitHub（ffmpeg版）が3時間後に代わりに作る（post.js の buildReels）
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { makeSync } = require("./lib/sync");
const { makeReelAE, available } = require("./lib/reel-ae");
const ROOT = __dirname;
const git = (args, opts = {}) => execFileSync("git", args, { cwd: ROOT, maxBuffer: 1 << 28, ...opts });
const remote = (f, d) => {
  try {
    return JSON.parse(git(["show", `origin/main:${f}`], { encoding: "utf8" }));
  } catch {
    return d;
  }
};
const LOCK = path.join(ROOT, ".work", "reel-pc.lock");
// iPhone の「ファイル」→ iCloud Drive →「リール」に、各回の写真と完成動画を置く（Edits で自分で組む用）
const KIT_ROOT = path.join(require("os").homedir(), "iCloudDrive", "リール");
try {
  fs.mkdirSync(KIT_ROOT, { recursive: true });
} catch {}

// Lightroom Classic のプラグインが読む一覧：コレクションセット「リール」の中の、回ごとのコレクション
function writeClassicReels(specials) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("C:/Lightroom/Lightroom Catalog.lrcat", { readOnly: true });
    const q = db.prepare("select id_global u from Adobe_images where id_local = ?");
    const lines = [];
    for (const x of specials.filter((s) => s.kind === "reel" && !s.skipped && s.kitDir && s.lrIds?.length && s.postAt > new Date(Date.now() - 2 * 864e5).toISOString())) {
      const uu = x.lrIds.filter(Boolean).map((id) => q.get(+id)?.u).filter(Boolean);
      if (uu.length) lines.push(`${x.kitDir.replace("_", " ")}\t${uu.join(",")}`);
    }
    fs.writeFileSync(path.join(ROOT, "classic-reels.tsv"), lines.join("\n") + "\n");
  } catch (e) {
    console.log("Classic の一覧を書けませんでした：" + e.message);
  }
}

(async () => {
  if (!available()) return;
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  if (fs.existsSync(LOCK)) {
    // 前の分がまだ動いているか（プロセスが生きているか）で判断する（時間だけで判断すると、長い作り直しの途中で2つ同時に動いて写真が混ざる）
    const pid = Number(fs.readFileSync(LOCK, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive && Date.now() - fs.statSync(LOCK).mtimeMs < 3 * 3600e3) return;
  }
  fs.writeFileSync(LOCK, String(process.pid));
  try {
    git(["fetch", "-q", "origin", "main"]);
    // 動画は作らない（本人が Edits で組む）。写真セットだけを iCloud Drive「リール」へ。config.reelVideo: true で動画も
    const VIDEO = remote("config.json", {}).reelVideo === true;
    const list = remote("specials.json", []).filter((s) => s.kind === "reel" && !s.skipped && s.postAt > new Date().toISOString() && (s.rebuild || (VIDEO ? !s.video : !s.kitAt)) && s.images?.length);
    for (const x of list) {
      fs.writeFileSync(LOCK, String(process.pid)); // 動いている印を新しく
      const tmp = path.join(ROOT, ".work", "reel-src", x.id);
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      const items = x.images.map((p, i) => {
        const f = path.join(tmp, `${i}.jpg`);
        fs.writeFileSync(f, git(["show", `origin/main:${p}`]));
        return { src: f, shot: x.shots?.[i] || null, place: x.places?.[i] || null };
      });
      const n = (x.rev || 0) + 1;
      const video = `specials/${x.id}/reel-${n}.mp4`;
      fs.mkdirSync(path.join(ROOT, path.dirname(video)), { recursive: true });
      const label = String(x.title || "").replace(/^リール[：:（(]?/, "").replace(/[（(]\d+枚[）)]?$/, "").replace(/[）)]$/, "").replace(/^\d+\/\d+の/, "").replace(/[\\/:*?"<>|]/g, "").slice(0, 40) || x.id;
      const kitDir = fs.existsSync(KIT_ROOT) ? path.join(KIT_ROOT, `${x.postAt.slice(5, 7)}${x.postAt.slice(8, 10)}_${label}`) : null;
      if (kitDir) for (const d of fs.readdirSync(KIT_ROOT)) if (d.startsWith(x.postAt.slice(5, 7) + x.postAt.slice(8, 10) + "_") && path.join(KIT_ROOT, d) !== kitDir) fs.rmSync(path.join(KIT_ROOT, d), { recursive: true, force: true }); // 同じ日の古いフォルダ（中身が変わった時）
      if (!VIDEO) {
        if (!kitDir) throw new Error("iCloud Drive のフォルダがありません");
        await require("./lib/reel-kit").makeKit(items, kitDir, { layout: x.layout || null });
        // クラウド版 Lightroom の「リール」フォルダにも（iPhone の Lightroom で直してから Edits へ）
        try {
          const cfgL = remote("config.json", {}).lightroom;
          if (false && cfgL?.configPath && fs.existsSync(cfgL.configPath)) { // 外部アプリのアルバムは Lightroom のアプリに出ないのでやめた（Classic のコレクション経由に）
            const arr = (j) => (Array.isArray(j) ? j : Object.values(j || {}));
            const cloud = Object.fromEntries([...arr(remote("pool.json", [])), ...arr(remote("queue.json", []))].filter((p) => p.image && /^[0-9a-f]{32}$/.test(String(p.lrId))).map((p) => [p.image, p.lrId]));
            const kitName = path.basename(kitDir);
            const its = x.images.map((p, i) => ({
              file: items[i].src,
              name: `${x.id}_${path.basename(p)}`,
              oldNames: [`${kitName}_${String(i + 1).padStart(2, "0")}.jpg`],
              assetId: cloud[p] || null,
              captureDate: x.sourceDate ? `${x.sourceDate}T19:00:${String(i).padStart(2, "0")}` : undefined,
            }));
            const albumName = kitName.replace("_", " ");
            const c = await require("./lib/lr-cloud").putReelAlbum(cfgL.configPath, albumName, its);
            console.log(`  クラウド版 Lightroom「リール/${albumName}」：${c.assets.length}枚（新しくアップロード${c.uploaded}枚）`);
          }
        } catch (e) {
          console.log("  クラウド版 Lightroom に入れられませんでした：" + e.message.slice(0, 160));
        }
        let lrIds = null;
        try {
          const arr = (j) => (Array.isArray(j) ? j : Object.values(j || {}));
          lrIds = await require("./lib/reel-lrids").resolveLrIds(x, items.map((it) => it.src), [...arr(remote("pool.json", [])), ...arr(remote("queue.json", []))]);
        } catch (e) {
          console.log("  Lightroom の写真と対応が取れませんでした：" + e.message.slice(0, 120));
        }
        makeSync(ROOT)(`reel photos ${x.id}`, [], (rm) => {
          const sp = rm("specials.json", []);
          const k = sp.findIndex((y) => y.id === x.id);
          if (k === -1) return {};
          const again = ["images", "layout"].some((f) => JSON.stringify(sp[k][f]) !== JSON.stringify(x[f]));
          sp[k] = { ...sp[k], kitAt: new Date().toISOString(), kitDir: path.basename(kitDir), rebuild: again, ...(lrIds ? { lrIds } : {}) };
          return { "specials.json": sp };
        });
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log(`リールの写真を用意しました ${x.id}（${items.length}枚 → ${path.basename(kitDir)}）`);
        continue;
      }
      const r = await makeReelAE(items, path.join(ROOT, video), ROOT, { kitDir, durations: x.durations || null, style: x.style || "oto", format: x.format || "dump", hook: x.hook || x.reelTitle || "", sub: x.reelSub || "", answer: x.answer || null, bpm: x.bpm, beats: x.beats, layout: x.layout || null, rhythm: x.rhythm || undefined });
      const cover = video.replace(/\.mp4$/, "-cover.jpg");
      const old = [x.video, x.cover].filter(Boolean);
      makeSync(ROOT)(`reel video ${x.id} (${r.engine || "ffmpeg"} ${r.bpm}bpm)`, [video, cover], (rm) => {
        const sp = rm("specials.json", []);
        const k = sp.findIndex((y) => y.id === x.id);
        if (k === -1) return {};
        const again = ["bpm", "beats", "hook", "reelTitle", "reelSub", "answer", "format", "style", "durations", "images", "layout", "rhythm"].some((f) => JSON.stringify(sp[k][f]) !== JSON.stringify(x[f]));
        sp[k] = { ...sp[k], video, cover, rev: n, seconds: r.seconds, beatsUsed: r.beats, engine: r.engine || "ffmpeg", rebuild: again, builtAt: new Date().toISOString() };
        const out = { "specials.json": sp };
        for (const f of old) out[f] = null;
        return out;
      });
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log(`リールの動画を作りました ${x.id}（${r.engine || "ffmpeg"}・${r.seconds}秒・${r.bpm}bpm）`);
    }
    git(["fetch", "-q", "origin", "main"]);
    writeClassicReels(remote("specials.json", []));
  } catch (e) {
    console.error("リールの動画づくりに失敗: " + e.message);
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
  process.exit(0); // 開いたままの After Effects を待たずに終わる
})();
