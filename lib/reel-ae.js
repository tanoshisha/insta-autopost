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
      L.inPoint = c.wi === "fade" ? Math.max(0, c.t0 - D.fade * fr) : c.t0;
      L.outPoint = c.t1;
      L.motionBlur = true;
      if (c.wo === "fade") {
        var lop = tr(L, "ADBE Opacity");
        lop.setValueAtTime(c.t1 - D.fade * fr, 100);
        lop.setValueAtTime(c.t1, 0);
        setEase(lop, 50);
      }
      var sc = tr(L, "ADBE Scale");
      var ps = tr(L, "ADBE Position");
      sc.setValueAtTime(c.t0, [D.base * c.z0, D.base * c.z0]);
      sc.setValueAtTime(c.t1, [D.base * c.z1, D.base * c.z1]);
      setEase(sc, 40);
      ps.setValueAtTime(c.t0, [D.W / 2 + c.x0, D.H / 2]);
      ps.setValueAtTime(c.t1, [D.W / 2 + c.x1, D.H / 2]);
      setEase(ps, 40);
      // 切り替え（本物のモーションブラー）
      //   whip … 前の1枚が右へ流れ去り、次の1枚が左から流れ込む
      //   zoom … 前の1枚に突っ込むように拡大して抜け、次の1枚が大きいところから戻る（ズームスルー）
      if (c.wo === "whip") {
        ps.setValueAtTime(c.t1 - 4 * fr, [D.W / 2 + c.x1, D.H / 2]);
        ps.setValueAtTime(c.t1, [D.W / 2 + c.x1 + D.W * 0.9, D.H / 2]);
      }
      if (c.wi === "whip") {
        ps.setValueAtTime(c.t0, [D.W / 2 + c.x0 - D.W * 0.9, D.H / 2]);
        ps.setValueAtTime(c.t0 + 4 * fr, [D.W / 2 + c.x0, D.H / 2]);
      }
      if (c.wo === "zoom") {
        var zz = c.z0 + (c.z1 - c.z0) * 0.9;
        sc.setValueAtTime(c.t1 - 4 * fr, [D.base * zz, D.base * zz]);
        sc.setValueAtTime(c.t1, [D.base * zz * 2.3, D.base * zz * 2.3]);
      }
      if (c.wi === "zoom") {
        sc.setValueAtTime(c.t0, [D.base * c.z0 * 1.9, D.base * c.z0 * 1.9]);
        sc.setValueAtTime(c.t0 + 5 * fr, [D.base * c.z0, D.base * c.z0]);
      }
      // 速い寄りは、最初に勢いよく・あとはゆっくり（スピードランプ）
      for (var kk = 1; kk <= sc.numKeys; kk++) {
        try { sc.setTemporalEaseAtKey(kk, [new KeyframeEase(0, 85), new KeyframeEase(0, 85), new KeyframeEase(0, 85)], [new KeyframeEase(0, 85), new KeyframeEase(0, 85), new KeyframeEase(0, 85)]); } catch (e1) {
          try { sc.setTemporalEaseAtKey(kk, [new KeyframeEase(0, 85), new KeyframeEase(0, 85)], [new KeyframeEase(0, 85), new KeyframeEase(0, 85)]); } catch (e2) {}
        }
      }
      // 3Dパララックス：奥行き（近い所ほど白い）で画素をずらし、手前と奥を別々に動かす
      if (c.depth) {
        var df = app.project.importFile(new ImportOptions(new File(c.depth)));
        var DL = comp.layers.add(df);
        DL.startTime = c.t0;
        DL.inPoint = c.t0;
        DL.outPoint = c.t1;
        DL.enabled = false;
        DL.moveToEnd();
        var dm = L.property("ADBE Effect Parade").addProperty("ADBE Displacement Map");
        dm.property(1).setValue(DL.index);
        try { dm.property(2).setValue(5); dm.property(4).setValue(5); } catch (e) {} // 明るさで
        try { dm.property(6).setValue(2); } catch (e) {} // 画像の大きさに合わせる
        dm.property(3).setValueAtTime(c.t0, c.d0);
        dm.property(3).setValueAtTime(c.t1, c.d1);
        setEase(dm.property(3), 40);
        dm.property(5).setValueAtTime(c.t0, c.v0);
        dm.property(5).setValueAtTime(c.t1, c.v1);
        setEase(dm.property(5), 40);
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
    // 拍に合わせた揺れ：切り替わった直後の数フレームだけ画面が揺れる（写真だけ。文字は揺らさない）
    var shake = comp.layers.addSolid([0, 0, 0], "shake", D.W, D.H, 1, D.total);
    shake.adjustmentLayer = true;
    var gtr = shake.property("ADBE Effect Parade").addProperty("ADBE Geometry2");
    var gp = gtr.property(2); // 位置
    var gs = gtr.property(4); // スケール（揺れで端が見えないように少し拡大）
    gs.setValue(103);
    gp.setValueAtTime(0, [D.W / 2, D.H / 2]);
    for (var si = 0; si < D.shakes.length; si++) {
      var s0 = D.shakes[si];
      var amp = [[14, -9], [-10, 7], [6, -4], [-3, 2], [0, 0]];
      for (var sj = 0; sj < amp.length; sj++) gp.setValueAtTime(s0 + sj * fr, [D.W / 2 + amp[sj][0], D.H / 2 + amp[sj][1]]);
    }
    try { gtr.property(11).setValue(false); gtr.property(12).setValue(270); } catch (e) {} // コンポのシャッター角を使わず 270°
    // 文字の後ろを少し暗く（どんな写真でも一言が読めるように）
    if (D.hookDark) {
      var dk = comp.layers.addSolid([0, 0, 0], "hookdark", D.W, D.H, 1, D.total);
      dk.outPoint = D.hookDark;
      var mk = dk.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
      var shp = new Shape();
      shp.vertices = [[-200, -200], [D.W + 200, -200], [D.W + 200, 1050], [-200, 1050]];
      shp.closed = true;
      mk.property("ADBE Mask Shape").setValue(shp);
      mk.property("ADBE Mask Feather").setValue([0, 520]);
      var dko = tr(dk, "ADBE Opacity");
      dko.setValueAtTime(0, 0);
      dko.setValueAtTime(0.25, 42);
      dko.setValueAtTime(D.hookDark - 3 * fr, 42);
      dko.setValueAtTime(D.hookDark, 0);
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
      if (T.kinetic) {
        // 1文字ずつ、ぼかしから・少し下から・ふわっと現れる（範囲セレクターの開始を 0→100%）
        var ta = t.property("ADBE Text Properties").property("ADBE Text Animators").addProperty("ADBE Text Animator");
        var ap = ta.property("ADBE Text Animator Properties");
        ap.addProperty("ADBE Text Opacity").setValue(0);
        ap.addProperty("ADBE Text Blur").setValue([24, 24]);
        ap.addProperty("ADBE Text Position 3D").setValue([0, 46, 0]);
        ap.addProperty("ADBE Text Scale 3D").setValue([120, 120, 100]);
        var sel = ta.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
        var st = sel.property("ADBE Text Percent Start");
        var ks = T.t0 + (T.delay || 0);
        st.setValueAtTime(ks, 0);
        st.setValueAtTime(ks + (T.dur || 0.5), 100);
        setEase(st, 60);
        // 出たあとは、ほんの少しずつ大きく（止まって見えない）
        var tsc = tr(t, "ADBE Scale");
        tsc.setValueAtTime(ks, [100, 100]);
        tsc.setValueAtTime(T.t1, [104, 104]);
      } else {
        fadeIn(t, T.t0 + (T.delay || 0), T.dur || 0.25, T.dy || 0, T.pop || 0);
      }
    }
    if (D.finish) {
    var adj = comp.layers.addSolid([0, 0, 0], "finish", D.W, D.H, 1, D.total);
    adj.adjustmentLayer = true;
    var fx = adj.property("ADBE Effect Parade");
    try { var gl = fx.addProperty("ADBE Glo2"); gl.property(2).setValue(72 * 2.55); gl.property(3).setValue(45); gl.property(4).setValue(0.35); } catch (e) { log.writeln("glow " + e); }
    try { fx.addProperty("CC Vignette").property(1).setValue(28); } catch (e) { log.writeln("vig " + e); }
    try { fx.addProperty("ADBE Noise").property(1).setValue(2.5); } catch (e) { log.writeln("noise " + e); }
    adj.moveToBeginning();
    }
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

// リズムのひな形（秒）。構想：最初と最後はメイン0.5秒・中メイン0.3〜0.4秒・ほかは0.2秒前後
//   steady … noa.jp2000 風（約0.5秒 → 0.7秒の一定のリズム）
//   accel  … kai__photo1 風（約0.4秒で始めて、0.23秒でたたみかける）
function rhythm(kind, n) {
  const d = [];
  for (let i = 0; i < n; i++) {
    if (kind === "steady") d.push(i < 4 ? 0.5 : 0.7);
    else d.push(i < 5 ? [0.43, 0.47, 0.37, 0.43, 0.33][i] : 0.233);
  }
  if (kind !== "steady" && n > 8) d[Math.floor(n * 0.6)] = 0.37; // 中メイン（一瞬だけ長く）
  d[n - 1] = Math.max(d[n - 1], 0.5); // 最後はメイン
  return d;
}

// hisato型（参考：hisato.1009 の振り返りリール）
//   つかみ4枚（1カットずつ）→ 1枚を長めに見せる → 超高速の点滅3枚 → 一定のカット（途中にもう一度点滅）→ 最後は2カット → 1枚目に戻ってループ
//   1カット = 拍・半拍・2拍のうち 0.33秒にいちばん近い長さ（曲のテンポにぴったり）
function hisatoUnit(bpm) {
  const b = 60 / bpm;
  return [b / 2, b, b * 2].filter((x) => x >= 0.25).sort((x, y) => Math.abs(x - 0.34) - Math.abs(y - 0.34))[0] || b;
}
function hisatoU(n, bpm, u) {
  // n はループの1枚（最後）を含む枚数
  const F = 2 / 30; // 点滅は1枚2コマ
  const m = n - 1;
  const d = new Array(n).fill(u);
  if (m < 8) {
    d[m - 1] = u * 2;
    return d;
  }
  let i = 0;
  const hook = m >= 12 ? 4 : 2;
  i += hook; // つかみ
  d[i++] = u * Math.max(2, Math.round(1.6 / u)); // 長めに見せる1枚
  const burst = () => {
    d[i++] = F;
    d[i++] = F;
    d[i++] = Math.max(F, u - 2 * F);
  };
  if (m - i >= 6) burst();
  const rest = m - 1 - i; // 最後のメインを除いた残り
  const mid = rest >= 9 ? i + Math.floor((rest - 3) / 2) : -1;
  while (i < m - 1) {
    if (i === mid && m - 1 - i >= 4) {
      burst();
      continue;
    }
    d[i++] = u;
  }
  d[m - 1] = u * 2; // 最後のメイン
  d[m] = u; // ループの1枚
  return d;
}

function hisato(n, bpm) {
  const b = 60 / (bpm || 100);
  const us = [b / 2, b, b * 2].filter((x) => x >= 0.25 && x <= 0.8).sort((x, y) => Math.abs(x - 0.34) - Math.abs(y - 0.34));
  if (!us.length) us.push(b);
  // 0.34秒に近い順に試して、7.5秒以上になる長さを使う（なければいちばん長いもの）
  for (const u of us) {
    const d = hisatoU(n, bpm, u);
    if (d.reduce((a, c) => a + c, 0) >= 7.5) return d;
  }
  return hisatoU(n, bpm, Math.max(...us));
}

function even(n, bpm, target = 0.43) {
  const b = 60 / bpm;
  const us = [b / 2, b, b * 2].filter((x) => x >= 0.25 && x <= 0.8).sort((x, y) => Math.abs(x - target) - Math.abs(y - target));
  if (!us.length) us.push(b);
  const mk = (u) => {
    const d = new Array(n).fill(u);
    d[n - 1] = u * 2;
    return d;
  };
  // 枚数が少なくて6.5秒に届かない時は、1カットを長く（0.8秒まで）
  for (const u of us) if (mk(u).reduce((a, c) => a + c, 0) >= 6.5) return mk(u);
  return mk(Math.max(...us));
}

// じっくり型：1枚を約2.7秒（拍の2・3・4・6・8個分のうち近い長さ＝小節の頭で切れる）、最初の1枚は1.5倍、最後は1.3倍
function slow(n, bpm) {
  const b = 60 / (bpm || 100);
  const bar = [2, 3, 4, 6, 8].map((k) => b * k).sort((x, y) => Math.abs(x - 2.7) - Math.abs(y - 2.7))[0];
  const d = new Array(n).fill(bar);
  d[0] = bar * 1.5;
  if (n > 1) d[n - 1] = bar * 1.3;
  return d;
}

async function makeReelAE(items, out, root, opts = {}) {
  if (!available()) {
    console.log("After Effects が使えないので、ffmpeg版で作ります");
    return require("./reel").makeReel(items, out, root, opts);
  }
  items = items.map((x) => (typeof x === "string" ? { src: x } : x));
  // ほぼ同じ写真は1枚に・似た写真は続けない（音ハメ画面で長さを決めた時は、その並びのまま）
  if (!opts.durations?.length && items.length > 3) {
    const r = await require("./dedupe").dedupe(items);
    if (r.removed) console.log(`ほぼ同じ写真を${r.removed}枚外しました`);
    items = r.items;
  }
  const format = opts.format || "dump";
  const bpm = Math.min(Math.max(Number(opts.bpm) || 100, 50), 200);
  const beat = 60 / bpm;
  // 見せ方：mv（おしゃれなMV。1枚1.2秒くらい・ディゾルブ・フラッシュや揺れなし）/ hype（ノリ重視。拍ごと・ウィップ・ズーム・揺れ）
  // 見せ方：oto（音ハメの写真まとめ。曲のアクセントでハードカット・写真はほぼ止めて見せる）/ mv（おしゃれなMV）/ hype（ノリ重視）
  const style = opts.style || "oto";
  const oto = style === "oto";
  const mv = style === "mv";
  const per = Math.max(1, Number(opts.beats) || (oto ? Math.max(1, Math.round((0.55 * bpm) / 60)) : mv ? Math.max(2, Math.round((1.2 * bpm) / 60)) : format === "settings" ? Math.max(2, beatsPerCut(bpm)) : beatsPerCut(bpm)));
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const P = (f) => path.join(WORK, f).replace(/\\/g, "/");

  // 最後は1枚目に戻る（ループすると切れ目が分からない）。音ハメ（文字なし）は参考リールどおり戻さない
  const plain0 = oto && !opts.text;
  const rh = opts.rhythm || (plain0 && format === "dump" && !opts.durations?.length ? "hisato" : null);
  const seq = plain0 && rh !== "hisato" && !opts.loop ? [...items] : [...items, { ...items[0], loop: true }];
  // 色味：ジャンルで分ける（夜=青緑 / 昼=やわらかいフィルム）。リール全体で1つにそろえる
  let look = opts.look || "auto";
  if (look === "auto") {
    const ls = [];
    for (const it of items.slice(0, 8)) {
      const st = await sharp(fs.readFileSync(it.src)).stats();
      ls.push(0.299 * st.channels[0].mean + 0.587 * st.channels[1].mean + 0.114 * st.channels[2].mean);
    }
    look = ls.filter((v) => v < 100).length >= ls.length / 2 ? "vividNight" : "vivid";
  }
  const files = [];
  for (const [i, it] of seq.entries()) {
    const f = P(`${i}.jpg`);
    if (it.loop) fs.copyFileSync(files[0], f);
    else {
      const CW = Math.round(W * BIG);
      const CH = Math.round(H * BIG);
      let srcBuf = await sharp(fs.readFileSync(it.src)).rotate().toBuffer();
      if (opts.layout === "side") {
        const m = await sharp(srcBuf).metadata();
        if (m.width > m.height) srcBuf = await sharp(srcBuf).rotate(90).toBuffer(); // 見る人はスマホを横にして見る
      }
      const crop = opts.layout === "frame" ? await sharp(srcBuf).resize(Math.round(CW * 0.8), Math.round(CH * 0.62), { fit: "inside" }).toBuffer() : await sharp(srcBuf).resize(CW, CH, { fit: "cover", position: sharp.strategy.attention }).toBuffer();
      // 色味：フィルムっぽく（opts.color = "none" で元のまま）
      const graded = await (opts.color === "none" ? sharp(crop) : await require("./film-look").filmLook(crop, { look })).jpeg({ quality: 94 }).toBuffer();
      if (opts.layout === "frame") {
        // 白い紙に写真を置いた見た目（色は写真だけにかけて、白は白のまま）
        const gm = await sharp(graded).metadata();
        const bg = opts.frameColor || "#f4f2ee";
        await sharp({ create: { width: CW, height: CH, channels: 3, background: bg } })
          .composite([{ input: graded, left: Math.round((CW - gm.width) / 2), top: Math.round((CH - gm.height) / 2 - CH * 0.02) }])
          .jpeg({ quality: 94 })
          .toFile(f);
      } else fs.writeFileSync(f, graded);
    }
    files.push(f);
  }
  // 音ハメは「写真を曲に合わせて連続させるだけ」：文字・グロー・粒子なし、1枚目も他と同じ長さ（参考：noa.jp2000・kai__photo1）
  const plain = oto && !opts.text;
  const hookBeats = plain ? per : Math.max(2, Math.ceil((format === "quiz" ? 2.2 : mv ? 2.0 : oto ? 1.3 : 1.4) / beat));
  const ansAt = seq.length - 2;
  // 音ハメのリズム：基本は per 拍、ときどき半分の長さで2枚たたみかける（曲の細かいフレーズに合う）、最後の1枚は長めに止める
  const OTO = [1, 1, 0.5, 0.5, 1, 1, 1, 0.5, 0.5, 1, 1, 0.5, 0.5, 1];
  const lens = seq.map((it, i) =>
    i === 0 ? hookBeats : it.loop ? 1 : format === "quiz" && i === ansAt ? Math.max(per, Math.ceil(1.6 / beat)) : oto && format === "dump" ? (i === seq.length - 2 ? per * 2 : per * OTO[(i - 1) % OTO.length]) : per
  );
  const snap = (t) => Math.round(t * FPS) / FPS;
  const bounds = [0];
  // 表示時間を秒で決める時（iPhoneで手直しした時・リズムのひな形）は、拍ではなく秒で
  const durs = opts.durations?.length ? opts.durations : plain0 && format === "dump" ? (rh === "hisato" ? hisato(seq.length, bpm) : rh === "even" ? even(seq.length, bpm) : rh === "slow" ? slow(seq.length, bpm) : rhythm(rh || (seq.length >= 16 ? "accel" : "steady"), seq.length)) : null;
  if (durs) for (let i = 0; i < seq.length; i++) bounds.push(snap(bounds[bounds.length - 1] + Math.max(2 / 30, durs[Math.min(i, durs.length - 1)])));
  else for (const l of lens) bounds.push(snap(bounds[bounds.length - 1] + l * beat));
  const total = bounds[bounds.length - 1];
  // 切り替えの種類：4枚ごとに、ウィップとズームスルーを交互に（それ以外はハードカット）
  const trans = (i) => (oto ? null : mv ? (i >= 1 ? "fade" : null) : i >= 2 && i < seq.length - 1 && i % 4 === 0 ? ((i / 4) % 2 ? "whip" : "zoom") : null);
  const base = 100 / BIG;
  const kinds = ["push", "pull", "panL", "push", "panR", "pull"];
  const clips = files.map((file, i) => {
    const k = i === 0 ? "push" : kinds[i % kinds.length];
    // 音ハメは写真をほぼ止めて見せる（ほんの少し寄るだけ）
    // 音ハメは写真を止めて見せる（参考：noa.jp2000・kai__photo1）
    const z0 = oto ? 1.0 : { push: 1.03, pull: 1.12, panL: 1.12, panR: 1.12 }[k];
    const z1 = oto ? 1.0 : { push: 1.11, pull: 1.04, panL: 1.12, panR: 1.12 }[k];
    const room = (W * z0 - W) / 2;
    const x0 = { push: 0, pull: 0, panL: room * 0.8, panR: -room * 0.8 }[k];
    const x1 = { push: 0, pull: 0, panL: -room * 0.8, panR: room * 0.8 }[k];
    // パララックスの向き：横に流れる時は同じ向き、寄り・引きの時は上下に（縦の奥行き感）
    const A = oto ? 24 : mv ? 72 : 46; // ゆっくりの時ほど奥行きが効く
    const d = { push: [0, 0, A * 0.5, -A * 0.5], pull: [0, 0, -A * 0.5, A * 0.5], panL: [A, -A, 0, 0], panR: [-A, A, 0, 0] }[k];
    const par = i === seq.length - 1 ? { d0: 0, d1: 0, v0: A * 0.5, v1: A * 0.5 } : { d0: d[0], d1: d[1], v0: d[2], v1: d[3] }; // ループの1枚は1枚目の最初と同じ
    return { file, t0: bounds[i], t1: bounds[i + 1], z0, z1, x0, x1, wo: trans(i + 1), wi: trans(i), blur: i === 0 && format === "quiz", ...par };
  });
  // 奥行きを推定して3Dパララックス（本人の好みでふだんは使わない。opts.parallax = true の時だけ）
  if (opts.parallax) try {
    const pairs = [];
    files.forEach((f, i) => i < files.length - 1 && pairs.push(f, f.replace(/\.jpg$/, "-depth.png")));
    execFileSync(process.execPath, [path.join(__dirname, "..", "ae", "depth", "depth.mjs"), ...pairs], { cwd: path.join(__dirname, "..", "ae", "depth"), stdio: "ignore", timeout: 10 * 60e3 });
    clips.forEach((c, i) => {
      const df = (i === files.length - 1 ? files[0] : files[i]).replace(/\.jpg$/, "-depth.png");
      if (fs.existsSync(df)) c.depth = df;
    });
  } catch (e) {
    console.log("奥行きの推定に失敗（パララックスなしで作ります）: " + e.message.slice(0, 120));
  }

  const SANSB = "YuGothic-Bold";
  const SANSM = "YuGothic-Medium";
  const SERIF = "YuMincho-Demibold";
  const texts = [];
  if (opts.hook && !plain) {
    const ls = splitLines(opts.hook);
    // MVは小さめ・字間を広く・静かに（つかみは最初の0.1秒から読める速さで）
    const size = Math.min(mv || oto ? 76 : 100, Math.floor((mv || oto ? 880 : 960) / Math.max(...ls.map((l) => l.length)) / (mv || oto ? 1.15 : 1.05)));
    texts.push({ text: ls.join("\r"), font: SANSB, size, pos: [W / 2, 680], t0: 0, t1: bounds[1], delay: format === "quiz" ? 0.15 : 0.05, dur: mv ? 0.7 : oto ? 0.45 : 0.55, kinetic: true, tracking: mv || oto ? 140 : 20 });
    if (opts.sub && format !== "quiz") texts.push({ text: opts.sub, font: SANSM, size: mv || oto ? 26 : 32, pos: [W / 2, 680 + ls.length * size * 1.3 + 14], t0: 0, t1: bounds[1], delay: 0.45, dur: 0.5, tracking: mv || oto ? 600 : 300 });
  }
  if (format === "settings")
    seq.forEach((it, i) => {
      if (i === 0 || it.loop || !it.shot) return;
      texts.push({ text: String(it.shot).split("／").join("   "), font: SANSB, size: 50, pos: [90, 1650], left: true, t0: bounds[i], t1: bounds[i + 1], dur: 0.15, dy: 16, tracking: 40 });
      if (it.place) texts.push({ text: it.place, font: SANSM, size: 34, pos: [90, 1570], left: true, t0: bounds[i], t1: bounds[i + 1], dur: 0.15, tracking: 60 });
    });
  if (format === "quiz" && opts.answer) {
    texts.push({ text: "答え", font: SANSB, size: 40, pos: [W / 2, 860], t0: bounds[ansAt], t1: bounds[ansAt + 1], dur: 0.2, tracking: 400 });
    texts.push({ text: opts.answer, font: SERIF, size: Math.min(110, Math.floor(900 / opts.answer.length / 1.02)), pos: [W / 2, 1000], t0: bounds[ansAt], t1: bounds[ansAt + 1], delay: 0.12, dur: 0.5, kinetic: true, tracking: 60 });
  }

  // ① プロジェクトを作って保存（After Effects の画面が少しだけ開いて閉じる）
  // 揺れ：ハードカットの直後だけ（ウィップ・ズームの直後は動きがあるので揺らさない）
  const shakes = mv || oto ? [] : clips.filter((c, i) => i >= 2 && !c.wi).map((c) => c.t0);
  const D = { W, H, fps: FPS, base, total, clips, texts, shakes, hookDark: opts.hook && !plain ? bounds[1] : 0, finish: !plain, flashAt: mv || oto ? 0 : bounds[1], fade: 8, aep: P("reel.aep"), log: P("ae.log") };
  const jsx = P("reel.jsx");
  fs.writeFileSync(jsx, "\ufeffvar D = " + JSON.stringify(D) + ";\n" + JSX, "utf8");
  const t0 = Date.now();
  const readLog = () => (fs.existsSync(D.log) ? fs.readFileSync(D.log, "utf8") : "");
  const done = () => /saved|ERR/.test(readLog());
  let p = null;
  let exited = true;
  for (let attempt = 1; attempt <= 3 && !done(); attempt++) {
    if (attempt > 1) {
      console.log(`After Effects が受け取らなかったので、もう一度（${attempt}回目）`);
      await sleep(10000);
    }
    p = spawn(AE, ["-r", jsx], { stdio: "ignore" });
    exited = false;
    p.on("exit", () => (exited = true));
    const ta = Date.now();
    // 開いたままの After Effects があれば、そちらで実行される（-r は起動中の画面に渡る）。ログに saved が出たら次へ
    while (!done() && Date.now() - ta < 5 * 60e3) {
      await sleep(1000);
      // 起動したプロセスが終わって、After Effects もどこにもいない → 取りこぼし
      if (exited && Date.now() - ta > 15000 && !aeRunning()) break;
    }
    p.unref(); // After Effects が開いたままでも、こちらは先に進んで終われるように
  }
  if (done()) await sleep(1500);
  if (!done() && aeRunning()) {
    // 固まっている時は、まず普通に閉じるよう頼む（強制終了すると次に「クラッシュ修復」の画面が出るため）
    try {
      execSync("taskkill /IM AfterFX.exe", { stdio: "ignore" });
    } catch {}
    for (let i = 0; i < 30 && aeRunning(); i++) await sleep(1000);
  }
  if (!/saved/.test(readLog()) || !fs.existsSync(D.aep)) throw new Error("After Effects でプロジェクトを作れませんでした: " + readLog().slice(0, 300));

  // ② 書き出し（画面なし）
  const raw = P("render.mp4");
  execFileSync(AER, ["-project", D.aep, "-comp", "reel", "-OMtemplate", "H.264 - レンダリング設定を一致 - 40 Mbps", "-output", raw], { stdio: "pipe", timeout: 15 * 60e3, maxBuffer: 1 << 26 });
  if (!fs.existsSync(raw)) throw new Error("After Effects で書き出せませんでした");
  execFileSync(ffmpeg(), ["-y", "-loglevel", "error", "-i", raw, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", path.resolve(out)]);
  const cover = out.replace(/\.mp4$/, "-cover.jpg");
  execFileSync(ffmpeg(), ["-y", "-loglevel", "error", "-ss", String(Math.min(bounds[1] - 0.1, 0.9)), "-i", path.resolve(out), "-frames:v", "1", "-q:v", "3", cover]);
  if (opts.kitDir) {
    // Edits などで自分で組む用：リールと同じ色・切り抜き・順番の写真（ループ用の最後の1枚は除く）
    fs.mkdirSync(opts.kitDir, { recursive: true });
    for (const old of fs.readdirSync(opts.kitDir)) if (/^\d+\.jpg$/.test(old)) fs.rmSync(path.join(opts.kitDir, old));
    let k = 0;
    for (const [i, file] of files.entries()) {
      if (seq[i].loop) continue;
      await sharp(file).resize(W, H, { fit: "cover" }).jpeg({ quality: 92 }).toFile(path.join(opts.kitDir, `${String(++k).padStart(2, "0")}.jpg`));
    }
    fs.copyFileSync(path.resolve(out), path.join(opts.kitDir, "完成動画（音なし）.mp4"));
  }
  fs.rmSync(WORK, { recursive: true, force: true });
  return { seconds: +total.toFixed(2), bpm, beats: per, cover, engine: "ae" };
}

module.exports = { makeReelAE, available, hisato, hisatoUnit, slow };
