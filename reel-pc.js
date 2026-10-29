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

(async () => {
  if (!available()) return;
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 30 * 60e3) return; // 前の分がまだ動いている
  fs.writeFileSync(LOCK, String(process.pid));
  try {
    git(["fetch", "-q", "origin", "main"]);
    const list = remote("specials.json", []).filter((s) => s.kind === "reel" && !s.skipped && (s.rebuild || !s.video) && s.images?.length);
    for (const x of list) {
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
      const r = await makeReelAE(items, path.join(ROOT, video), ROOT, { durations: x.durations || null, style: x.style || "oto", format: x.format || "dump", hook: x.hook || x.reelTitle || "", sub: x.reelSub || "", answer: x.answer || null, bpm: x.bpm, beats: x.beats });
      const cover = video.replace(/\.mp4$/, "-cover.jpg");
      const old = [x.video, x.cover].filter(Boolean);
      makeSync(ROOT)(`reel video ${x.id} (${r.engine || "ffmpeg"} ${r.bpm}bpm)`, [video, cover], (rm) => {
        const sp = rm("specials.json", []);
        const k = sp.findIndex((y) => y.id === x.id);
        if (k === -1) return {};
        const again = ["bpm", "beats", "hook", "reelTitle", "reelSub", "answer", "format", "style", "durations", "images"].some((f) => JSON.stringify(sp[k][f]) !== JSON.stringify(x[f]));
        sp[k] = { ...sp[k], video, cover, rev: n, seconds: r.seconds, beatsUsed: r.beats, engine: r.engine || "ffmpeg", rebuild: again, builtAt: new Date().toISOString() };
        const out = { "specials.json": sp };
        for (const f of old) out[f] = null;
        return out;
      });
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log(`リールの動画を作りました ${x.id}（${r.engine || "ffmpeg"}・${r.seconds}秒・${r.bpm}bpm）`);
    }
  } catch (e) {
    console.error("リールの動画づくりに失敗: " + e.message);
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
})();
