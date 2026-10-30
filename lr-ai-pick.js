// lr-ai-pick.js — lr-pick.js で集めた写真を AI が見て「人が写っていないか・点数・テーマ・場所」を付ける → .work/lrpick/judged.json
//   撮影データ（85mm／f1.8／1/125秒／ISO3200）は Lightroom のカタログから
const fs = require("fs");
const path = require("path");
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const DIR = path.join(__dirname, ".work", "lrpick");
const list = JSON.parse(fs.readFileSync(path.join(DIR, "list.json"), "utf8"));
const OUT = path.join(DIR, "judged.json");
const done = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
const THEMES = ["ネオン・看板", "東京タワー", "夜景・ビル", "電車・線路・駅", "夕焼け・マジックアワー", "雨・反射", "路地・横丁", "神社・和", "花・植物", "海・水辺", "空・雲", "車・道路", "建物・建築", "その他"];

// 撮影データ（Lightroom は F値・シャッターを APEX で持っている）
const db = new DatabaseSync("C:/Lightroom/Lightroom Catalog.lrcat", { readOnly: true });
const ex = db.prepare("select aperture, shutterSpeed, focalLength, isoSpeedRating from AgHarvestedExifMetadata where image = ?");
function shotOf(id) {
  const e = ex.get(id);
  if (!e) return null;
  const parts = [];
  if (e.focalLength) parts.push(`${Math.round(e.focalLength)}mm`);
  if (e.aperture != null) parts.push(`f${+Math.pow(2, e.aperture / 2).toFixed(1)}`);
  if (e.shutterSpeed != null) {
    const t = Math.pow(2, -e.shutterSpeed);
    parts.push(t >= 1 ? `${+t.toFixed(1)}秒` : `1/${Math.round(1 / t)}秒`);
  }
  if (e.isoSpeedRating) parts.push(`ISO${Math.round(e.isoSpeedRating)}`);
  return parts.length >= 3 ? parts.join("／") : null;
}

// 点数の基準の参考：本人が自分で選んで載せた投稿の一覧（make-own-ref.js → .work/own-ref/ref-N.jpg。上の一覧ほど反応が大きかった）
function ownRef() {
  const dir = path.join(__dirname, ".work", "own-ref");
  const sheets = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^ref-\d+\.jpg$/.test(f)).sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4))) : [];
  if (!sheets.length) return "";
  return `【点数の基準の参考】まず次の一覧画像を Read で見てください（この写真家が自分で選んでインスタに載せた投稿。ref-1 ほど反応が大きかった）:
${sheets.map((f) => `- ${path.join(dir, f)}`).join("\n")}
この一覧に載っている写真が「この写真家にとって載せる価値がある写真」の水準です。候補の写真が、この一覧の上位（ref-1）と並べて見劣りしないなら8以上、一覧の平均くらいなら7、一覧に入らない出来なら6以下。

`;
}

function ask(batch) {
  const lines = batch.map((x) => `- thumbs/${x.id}.jpg（${String(x.t).slice(0, 10)}・フォルダ ${x.dir}）`).join("\n");
  const prompt = `${ownRef()}カレントフォルダの次の写真を Read ツールで全部見てください。写真家のリール（インスタの縦動画）に使う写真を選びます。

${lines}

各写真について:
- people: 人がはっきり写っているなら true（遠くの小さな人影や、ぼけて誰か分からない人だけなら false）
- score: 1〜10。フォトコンの審査員の目で、構図・光・色・独自性で厳しく（8=作品として販売できる、7=上手い、6以下=普通）
- theme: 次から1つ ${THEMES.join(" / ")}
- tone: dark（夜・暗い）/ mid / bright
- place: 写っている場所が分かれば短く（例「渋谷」「東京タワー」「浅草寺」。分からなければ空）

出力は次のJSONだけ（説明不要）:
{"photos":[{"id":"12345","people":false,"score":8,"theme":"ネオン・看板","tone":"dark","place":"新宿"}]}`;
  return new Promise((resolve, reject) => {
    const p = spawn("claude", ["-p", "--allowedTools", "Read", "--output-format", "json", "--model", cfg.aiModel || "claude-fable-5-1"], { cwd: DIR, shell: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      try {
        if (code !== 0) throw new Error(err || out);
        const text = JSON.parse(out).result || "";
        resolve(JSON.parse(text.match(/\{[\s\S]*\}/)[0]).photos || []);
      } catch (e) {
        reject(new Error("AIの判定に失敗: " + String(e.message).slice(0, 200)));
      }
    });
    p.stdin.end(prompt);
  });
}

(async () => {
  const todo = list.filter((x) => !done[x.id]);
  console.log(`AIが見る写真 ${todo.length}枚（済み ${Object.keys(done).length}枚）`);
  const B = 35;
  const batches = [];
  for (let i = 0; i < todo.length; i += B) batches.push(todo.slice(i, i + B));
  for (let i = 0; i < batches.length; i += 3) {
    const res = await Promise.allSettled(batches.slice(i, i + 3).map((b) => ask(b)));
    for (const r of res) {
      if (r.status !== "fulfilled") {
        console.log("  ⚠ " + r.reason.message);
        continue;
      }
      for (const p of r.value) {
        const x = list.find((y) => String(y.id) === String(p.id));
        if (x) done[x.id] = { ...x, ...p, shot: shotOf(x.id) };
      }
    }
    fs.writeFileSync(OUT, JSON.stringify(done, null, 1));
    console.log(`  …${Math.min(i + 3, batches.length)}/${batches.length}`);
  }
  const all = Object.values(done);
  const ok = all.filter((x) => !x.people);
  console.log(`人なし ${ok.length}枚 / 8点以上 ${ok.filter((x) => x.score >= 8).length}枚`);
  const th = {};
  for (const x of ok.filter((x) => x.score >= 7)) th[x.theme] = (th[x.theme] || 0) + 1;
  console.log("テーマ（7点以上）:", JSON.stringify(th));
})();
