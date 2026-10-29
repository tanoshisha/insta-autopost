// リールを After Effects で作る（PCだけ）。lib/reel.js と同じ形で呼べる
//   ① After Effects（AfterFX -r）が写真・文字・動き（キーフレーム）を並べたプロジェクトを保存して閉じる
//   ② aerender（画面なし）が書き出す → ffmpeg でインスタ向けに軽くする
//   ffmpeg版との違い：本物のモーションブラー（流れる切り替え・パン）・なめらかな加減速・ネオンのグロー・きれいな文字
//   After Effects を別の作業で開いている時・使えない時は ffmpeg版で作る
const fs = require("fs");
const path = require("path");
const { execFileSync, execSync, spawn } = require("child_process");
const sharp = require("sharp");
sharp.cache(false);

const BIN = "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files";
const AE = `${BIN}/AfterFX.exe`;
const AER = `${BIN}/aerender.exe`;
const WORK = path.join(__dirname, "..", "ae", "work");
const W = 1080;
const H = 1920;
const FPS = 30;
const BIG = 1.6;

const available = () => fs.existsSync(AE) && fs.existsSync(AER);
function aeRunning() {
  try {
    return /AfterFX\.exe/i.test(execSync('tasklist /FI "IMAGENAME eq AfterFX.exe" /FO CSV /NH', { encoding: "utf8" }));
  } catch {
    return false;
  }
}
const ffmpeg = () => {
  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const beatsPerCut = (bpm) => Math.max(1, Math.round((0.6 * bpm) / 60));

function splitLines(text, max = 11) {
  const t = String(text || "").trim();
  if (t.includes("\n")) return t.split("\n").slice(0, 3);
  if (t.length <= max) return [t];
  const cut = [...t.matchAll(/[、。！？ 　]/g)].map((m) => m.index + 1).filter((i) => i >= 3 && i <= t.length - 2);
  const at = cut.sort((a, b) => Math.abs(a - t.length / 2) - Math.abs(b - t.length / 2))[0] || Math.ceil(t.length / 2);
  return [t.slice(0, at).trim(), t.slice(at).trim()];
}

// After Effects の中で動かす台本（データは D）
const JSX = String.raw`
(function () {
  var log = new File(D.log);
  log.open("w");
  try {
    app.beginSuppressDialogs();
    app.newProject();
    var comp = app.project.items.addComp("reel", D.W, D.H, 1, D.total, D.fps);
    comp.motionBlur = true;
    comp.shutterAngle = 270;
    comp.shutterPhase = -135;
    var fr = 1 / D.fps;
    function setEase(prop, inf) {
      for (var k = 1; k <= prop.numKeys; k++) {
        for (var n = 1; n <= 3; n++) {
          var arr = [];
          for (var j = 0; j < n; j++) arr.push(new KeyframeEase(0, inf || 70));
          try { prop.setTemporalEaseAtKey(k, arr, arr); break; } catch (e) {}
        }
      }
    }
    function tr(L, name) { return L.property("ADBE Transform Group").property(name); }
    function textLayer(str, font, size, pos, left, tracking) {
      var t = comp.layers.addText(str);
      var p = t.property("ADBE Text Properties").property("ADBE Text Document");
      var d = p.value;
      d.resetCharStyle();
      d.font = font;
      d.fontSize = size;
      d.fillColor = [1, 1, 1];
      d.applyFill = true;
      d.applyStroke = false;
      d.tracking = tracking || 0;
      d.justification = left ? ParagraphJustification.LEFT_JUSTIFY : ParagraphJustification.CENTER_JUSTIFY;
      p.setValue(d);
      tr(t, "ADBE Position").setValue(pos);
      var sh = t.property("ADBE Effect Parade").addProperty("ADBE Drop Shadow");
      sh.property(2).setValue(60 * 2.55);
      sh.property(4).setValue(4);
      sh.property(5).setValue(26);
      return t;
    }
    function fadeIn(L, t0, dur, dy, pop) {
      var op = tr(L, "ADBE Opacity");
      op.setValueAtTime(t0, 0);
      op.setValueAtTime(t0 + dur, 100);
      setEase(op, 80);
      if (dy) {
        var ps = tr(L, "ADBE Position");
        var v = ps.value;
        ps.setValueAtTime(t0, [v[0], v[1] + dy]);
        ps.setValueAtTime(t0 + dur * 1.4, v);
        setEase(ps, 85);
      }
      if (pop) {
        var sc = tr(L, "ADBE Scale");
        sc.setValueAtTime(t0, [pop, pop]);
        sc.setValueAtTime(t0 + dur * 1.4, [100, 100]);
        setEase(sc, 85);
      }
    }
    for (var i = 0; i < D.clips.length; i++) {
      var c = D.clips[i];
      var foot = app.project.importFile(new ImportOptions(new File(c.file)));
      var L = comp.layers.add(foot);
      L.moveToEnd();
      L.startTime = c.t0;
      L.inPoint = c.t0;
      L.outPoint = c.t1;
      L.motionBlur = true;
      var sc = tr(L, "ADBE Scale");
      var ps = tr(L, "ADBE Position");
      sc.setValueAtTime(c.t0, [D.base * c.z0, D.base * c.z0]);
      sc.setValueAtTime(c.t1, [D.base * c.z1, D.base * c.z1]);
      setEase(sc, 40);
      ps.setValueAtTime(c.t0, [D.W / 2 + c.x0, D.H / 2]);
      ps.setValueAtTime(c.t1, [D.W / 2 + c.x1, D.H / 2]);
      setEase(ps, 40);
      // ウィップ：前の1枚が右へ流れ去り、次の1枚が左から流れ込む（本物のモーションブラー）
      if (c.wo) {
        ps.setValueAtTime(c.t1 - 4 * fr, [D.W / 2 + c.x1, D.H / 2]);
        ps.setValueAtTime(c.t1, [D.W / 2 + c.x1 + D.W * 0.9, D.H / 2]);
      }
      if (c.wi) {
        ps.setValueAtTime(c.t0, [D.W / 2 + c.x0 - D.W * 0.9, D.H / 2]);
        ps.setValueAtTime(c.t0 + 4 * fr, [D.W / 2 + c.x0, D.H / 2]);
      }
      if (c.blur) {
        var gb = L.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2");
        gb.property(1).setValueAtTime(c.t0, 140);
        gb.property(1).setValueAtTime(c.t0 + 0.6, 140);
        gb.property(1).setValueAtTime(c.t0 + 1.6, 0);
        setEase(gb.property(1), 75);
        try { gb.property(3).setValue(true); } catch (e) {}
      }
    }
    if (D.flashAt) {
      var fl = comp.layers.addSolid([1, 1, 1], "flash", D.W, D.H, 1, D.total);
      var op = tr(fl, "ADBE Opacity");
      op.setValueAtTime(0, 0);
      op.setValueAtTime(D.flashAt - fr, 0);
      op.setValueAtTime(D.flashAt, 75);
      op.setValueAtTime(D.flashAt + 4 * fr, 0);
    }
    for (var j = 0; j < D.texts.length; j++) {
      var T = D.texts[j];
      var t = textLayer(T.text, T.font, T.size, T.pos, T.left, T.tracking);
      t.inPoint = T.t0;
      t.outPoint = T.t1;
      fadeIn(t, T.t0 + (T.delay || 0), T.dur || 0.25, T.dy || 0, T.pop || 0);
    }
    var adj = comp.layers.addSolid([0, 0, 0], "finish", D.W, D.H, 1, D.total);
    adj.adjustmentLayer = true;
    var fx = adj.property("ADBE Effect Parade");
    try { var gl = fx.addProperty("ADBE Glo2"); gl.property(2).setValue(72 * 2.55); gl.property(3).setValue(45); gl.property(4).setValue(0.35); } catch (e) { log.writeln("glow " + e); }
    try { fx.addProperty("CC Vignette").property(1).setValue(28); } catch (e) { log.writeln("vig " + e); }
    try { fx.addProperty("ADBE Noise").property(1).setValue(2.5); } catch (e) { log.writeln("noise " + e); }
    adj.moveToBeginning();
    app.project.save(new File(D.aep));
    log.writeln("saved");
  } catch (e) {
    log.writeln("ERR " + e.toString() + " line " + e.line);
  }
  log.close();
  app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
  app.quit();
})();
`;

async function makeReelAE(items, out, root, opts = {}) {
  if (!available() || aeRunning()) {
    console.log("After Effects が使えない（開いている）ので、ffmpeg版で作ります");
    return require("./reel").makeReel(items, out, root, opts);
  }
  items = items.map((x) => (typeof x === "string" ? { src: x } : x));
  const format = opts.format || "dump";
  const bpm = Math.min(Math.max(Number(opts.bpm) || 100, 50), 200);
  const beat = 60 / bpm;
  const per = Math.max(1, Number(opts.beats) || (format === "settings" ? Math.max(2, beatsPerCut(bpm)) : beatsPerCut(bpm)));
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const P = (f) => path.join(WORK, f).replace(/\\/g, "/");

  // 最後は1枚目に戻る（ループすると切れ目が分からない）
  const seq = [...items, { ...items[0], loop: true }];
  const files = [];
  for (const [i, it] of seq.entries()) {
    const f = P(`${i}.jpg`);
    if (it.loop) fs.copyFileSync(files[0], f);
    else await sharp(fs.readFileSync(it.src)).rotate().resize(Math.round(W * BIG), Math.round(H * BIG), { fit: "cover", position: sharp.strategy.attention }).jpeg({ quality: 94 }).toFile(f);
    files.push(f);
  }
  const hookBeats = Math.max(2, Math.ceil((format === "quiz" ? 2.2 : 1.4) / beat));
  const ansAt = seq.length - 2;
  const lens = seq.map((it, i) => (i === 0 ? hookBeats : it.loop ? 1 : format === "quiz" && i === ansAt ? Math.max(per, Math.ceil(1.6 / beat)) : per));
  const snap = (t) => Math.round(t * FPS) / FPS;
  const bounds = [0];
  for (const l of lens) bounds.push(snap(bounds[bounds.length - 1] + l * beat));
  const total = bounds[bounds.length - 1];
  const whip = (i) => i >= 2 && i < seq.length - 1 && i % 4 === 0;
  const base = 100 / BIG;
  const kinds = ["push", "pull", "panL", "push", "panR", "pull"];
  const clips = files.map((file, i) => {
    const k = i === 0 ? "push" : kinds[i % kinds.length];
    const z0 = { push: 1.03, pull: 1.12, panL: 1.12, panR: 1.12 }[k];
    const z1 = { push: 1.11, pull: 1.04, panL: 1.12, panR: 1.12 }[k];
    const room = (W * z0 - W) / 2;
    const x0 = { push: 0, pull: 0, panL: room * 0.8, panR: -room * 0.8 }[k];
    const x1 = { push: 0, pull: 0, panL: -room * 0.8, panR: room * 0.8 }[k];
    return { file, t0: bounds[i], t1: bounds[i + 1], z0, z1, x0, x1, wo: whip(i + 1), wi: whip(i), blur: i === 0 && format === "quiz" };
  });

  const SANSB = "YuGothic-Bold";
  const SANSM = "YuGothic-Medium";
  const SERIF = "YuMincho-Demibold";
  const texts = [];
  if (opts.hook) {
    const ls = splitLines(opts.hook);
    const size = Math.min(100, Math.floor(960 / Math.max(...ls.map((l) => l.length)) / 1.05));
    texts.push({ text: ls.join("\r"), font: SANSB, size, pos: [W / 2, 640], t0: 0, t1: bounds[1], delay: format === "quiz" ? 0.1 : 0.12, dur: 0.3, dy: 50, pop: 108, tracking: 20 });
    if (opts.sub && format !== "quiz") texts.push({ text: opts.sub, font: SANSM, size: 32, pos: [W / 2, 640 + ls.length * size * 1.25 + 10], t0: 0, t1: bounds[1], delay: 0.3, dur: 0.3, tracking: 300 });
  }
  if (format === "settings")
    seq.forEach((it, i) => {
      if (i === 0 || it.loop || !it.shot) return;
      texts.push({ text: String(it.shot).split("／").join("   "), font: SANSB, size: 50, pos: [90, 1650], left: true, t0: bounds[i], t1: bounds[i + 1], dur: 0.15, dy: 16, tracking: 40 });
      if (it.place) texts.push({ text: it.place, font: SANSM, size: 34, pos: [90, 1570], left: true, t0: bounds[i], t1: bounds[i + 1], dur: 0.15, tracking: 60 });
    });
  if (format === "quiz" && opts.answer) {
    texts.push({ text: "答え", font: SANSB, size: 40, pos: [W / 2, 860], t0: bounds[ansAt], t1: bounds[ansAt + 1], dur: 0.2, tracking: 400 });
    texts.push({ text: opts.answer, font: SERIF, size: Math.min(110, Math.floor(900 / opts.answer.length / 1.02)), pos: [W / 2, 1000], t0: bounds[ansAt], t1: bounds[ansAt + 1], delay: 0.1, dur: 0.3, dy: 30, pop: 106, tracking: 60 });
  }

  // ① プロジェクトを作って保存（After Effects の画面が少しだけ開いて閉じる）
  const D = { W, H, fps: FPS, base, total, clips, texts, flashAt: bounds[1], aep: P("reel.aep"), log: P("ae.log") };
  const jsx = P("reel.jsx");
  fs.writeFileSync(jsx, "\ufeffvar D = " + JSON.stringify(D) + ";\n" + JSX, "utf8");
  const p = spawn(AE, ["-r", jsx], { stdio: "ignore" });
  let exited = false;
  p.on("exit", () => (exited = true));
  const t0 = Date.now();
  const readLog = () => (fs.existsSync(D.log) ? fs.readFileSync(D.log, "utf8") : "");
  while (!exited && Date.now() - t0 < 5 * 60e3) await sleep(1000);
  if (!exited) {
    // 閉じない時は、まず普通に閉じるよう頼む（強制終了すると次に「クラッシュ修復」の画面が出るため）
    try {
      execSync("taskkill /IM AfterFX.exe", { stdio: "ignore" });
    } catch {}
    for (let i = 0; i < 30 && !exited; i++) await sleep(1000);
  }
  if (!/saved/.test(readLog()) || !fs.existsSync(D.aep)) throw new Error("After Effects でプロジェクトを作れませんでした: " + readLog().slice(0, 300));

  // ② 書き出し（画面なし）
  const raw = P("render.mp4");
  execFileSync(AER, ["-project", D.aep, "-comp", "reel", "-OMtemplate", "H.264 - レンダリング設定を一致 - 40 Mbps", "-output", raw], { stdio: "pipe", timeout: 15 * 60e3, maxBuffer: 1 << 26 });
  if (!fs.existsSync(raw)) throw new Error("After Effects で書き出せませんでした");
  execFileSync(ffmpeg(), ["-y", "-loglevel", "error", "-i", raw, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", path.resolve(out)]);
  const cover = out.replace(/\.mp4$/, "-cover.jpg");
  execFileSync(ffmpeg(), ["-y", "-loglevel", "error", "-ss", String(Math.min(bounds[1] - 0.1, 0.9)), "-i", path.resolve(out), "-frames:v", "1", "-q:v", "3", cover]);
  fs.rmSync(WORK, { recursive: true, force: true });
  return { seconds: +total.toFixed(2), bpm, beats: per, cover, engine: "ae" };
}

module.exports = { makeReelAE, available };
