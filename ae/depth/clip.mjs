// 写真の「中身の似ている度合い」（CLIP の画像ベクトルのコサイン類似度）。node clip.mjs a.jpg b.jpg ... → JSON 行列
import { pipeline, env } from "@huggingface/transformers";
env.cacheDir = new URL("./models", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const files = process.argv.slice(2);
const ex = await pipeline("image-feature-extraction", "Xenova/clip-vit-base-patch32");
const vs = [];
for (const f of files) {
  const out = await ex(f);
  const v = Array.from(out.data);
  const n = Math.hypot(...v);
  vs.push(v.map((x) => x / n));
}
const M = vs.map((a) => vs.map((b) => +a.reduce((s, x, i) => s + x * b[i], 0).toFixed(3)));
process.stdout.write(JSON.stringify(M));
