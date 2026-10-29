// school-retouch.js — スクールフォトの自動レタッチ（外部のAIには送らない。このPCの中だけで明るさを測って決める）
//   node school-retouch.js <フォルダ>
//   フォルダ: Lightroom が書き出した <ID>.jpg と、今の設定 <ID>.cur（Exposure2012 / ISO など）
//   結果: result.tsv … ID \t S \t Exposure2012=値;Preset=番号（場面に合うプリセットに替える時だけ）
//   ・顔が明るく見える明るさ（中間の明るさ）に露光量を合わせる。空や白い服が白飛びしない範囲で
//   ・逆光（真ん中が暗くて周りが明るい）→「03 逆光の人物」、くもり（明暗差が小さい）→「02 屋外・くもり／日陰」
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
sharp.cache(false);

const dir = process.argv[2];
const TARGET = 120; // 中間の明るさの目標（0〜255）。スクールフォトは少し明るめ

function readCur(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const l of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = l.match(/^(\w+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function stats(file) {
  const W = 300;
  const { data, info } = await sharp(file).resize(W, W, { fit: "inside" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const hist = new Array(256).fill(0);
  let cSum = 0, cN = 0, eSum = 0, eN = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const v = data[y * info.width + x];
      hist[v]++;
      const center = Math.abs(x / info.width - 0.5) < 0.25 && Math.abs(y / info.height - 0.45) < 0.25;
      if (center) (cSum += v), cN++;
      else (eSum += v), eN++;
    }
  const n = data.length;
  const pct = (p) => {
    let acc = 0;
    for (let i = 0; i < 256; i++) if ((acc += hist[i]) >= n * p) return i;
    return 255;
  };
  return { p5: pct(0.05), median: pct(0.5), p95: pct(0.95), p99: pct(0.99), center: cSum / cN, edge: eSum / eN };
}

(async () => {
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.jpg$/i.test(x))) {
    const id = f.replace(/\.jpg$/i, "");
    try {
      const s = await stats(path.join(dir, f));
      const cur = readCur(path.join(dir, id + ".cur"));
      const exp = Number(cur.Exposure2012) || 0;
      // 顔のある真ん中と全体の中間をあわせて見る
      const mid = s.median * 0.6 + s.center * 0.4;
      let delta = 1.6 * Math.log2(TARGET / Math.max(mid, 8));
      // 明るくする時は、白飛びしそうなら控えめに
      if (delta > 0 && s.p99 >= 250) delta *= 0.4;
      else if (delta > 0 && s.p99 >= 240) delta *= 0.7;
      delta = Math.max(-1.5, Math.min(1.5, delta));
      if (Math.abs(delta) < 0.08) delta = 0;
      const kv = [`Exposure2012=${(exp + delta).toFixed(2)}`];
      // 場面の判定（初回だけ。ISOで選んだ屋外のプリセットを、逆光・くもりに替える）
      const iso = Number(cur.ISO) || 0;
      if (cur.First === "1" && iso < 800) {
        if (s.edge - s.center > 35 && s.p95 > 230) kv.push("Preset=3");
        else if (s.p95 - s.p5 < 150) kv.push("Preset=2");
      }
      rows.push(`${id}\tS\t${kv.join(";")}`);
    } catch (e) {
      console.error(id + ": " + e.message);
    }
  }
  fs.writeFileSync(path.join(dir, "result.tsv"), rows.join("\n") + "\n");
  console.log(`${rows.length}枚の明るさを決めました`);
})();
