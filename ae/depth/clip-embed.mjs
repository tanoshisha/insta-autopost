// 写真の CLIP ベクトルをまとめて作って保存する（たくさんの写真用・前に作った分は使い回す）
//   node clip-embed.mjs <写真の一覧.txt（1行1ファイル）> <保存先.json>  → { "ファイル": [ベクトル] }
import fs from "fs";
import { pipeline, env } from "@huggingface/transformers";
env.cacheDir = new URL("./models", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const [listFile, outFile] = process.argv.slice(2);
const files = fs.readFileSync(listFile, "utf8").split(/\r?\n/).filter(Boolean);
const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : {};
const ex = await pipeline("image-feature-extraction", "Xenova/clip-vit-base-patch32");
let n = 0;
for (const f of files) {
  if (out[f]) continue;
  try {
    const v = Array.from((await ex(f)).data);
    const s = Math.hypot(...v);
    out[f] = v.map((x) => +(x / s).toFixed(4));
  } catch {}
  if (++n % 200 === 0) fs.writeFileSync(outFile, JSON.stringify(out));
}
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(`CLIP ${Object.keys(out).length}枚`);
