// depth.mjs — 写真1枚から奥行き（近い所ほど白い）を推定して PNG にする（3Dパララックス用）
//   node depth.mjs <入力.jpg> <出力.png> [<入力2.jpg> <出力2.png> …]
//   モデル：Depth Anything V2（小さい版）。最初の1回だけダウンロード（以降はこのPCの中だけで動く）
import { pipeline, RawImage } from "@huggingface/transformers";
import sharp from "sharp";

const args = process.argv.slice(2);
const est = await pipeline("depth-estimation", "onnx-community/depth-anything-v2-small", { dtype: "fp32" });
for (let i = 0; i < args.length; i += 2) {
  const [src, dest] = [args[i], args[i + 1]];
  const meta = await sharp(src).metadata();
  const img = await RawImage.read(src);
  const out = await est(img);
  const d = out.depth; // RawImage（グレー）
  // 写真と同じ大きさに・境目が硬すぎないよう少しぼかす
  await sharp(Buffer.from(d.data), { raw: { width: d.width, height: d.height, channels: d.channels } })
    .resize(meta.width, meta.height, { fit: "fill" })
    .blur(3)
    .png()
    .toFile(dest);
  console.log("depth " + dest);
}
