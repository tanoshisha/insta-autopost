// 顔検出（このPCの中だけ。OpenCV の YuNet。外部には送らない）
//   detect(file, W, H) → [{x, y, w, h, score}]（W×H の座標系に換算。大きい順）
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
sharp.cache(false);
let cvp = null;
const loadCv = () =>
  (cvp ||= new Promise((ok) => {
    const cv = require("@techstark/opencv-js");
    const fin = () => {
      const x = fs.readFileSync(path.join(__dirname, "models", "face_detection_yunet_2023mar.onnx"));
      try {
        cv.FS_createDataFile("/", "yunet.onnx", x, true, false, false);
      } catch {}
      const det = new cv.FaceDetectorYN("yunet.onnx", "", new cv.Size(320, 320), 0.5, 0.3, 5000);
      ok({ cv, det });
    };
    if (cv.Mat) fin();
    else cv.onRuntimeInitialized = fin;
  }));

async function detect(file, W, H) {
  const { cv, det } = await loadCv();
  const { data, info } = await sharp(file).rotate().resize(960, 960, { fit: "inside" }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const m = cv.matFromArray(info.height, info.width, cv.CV_8UC3, Array.from(data));
  cv.cvtColor(m, m, cv.COLOR_RGB2BGR);
  det.setInputSize(new cv.Size(info.width, info.height));
  const faces = new cv.Mat();
  det.detect(m, faces);
  const sx = W / info.width, sy = H / info.height;
  const out = [];
  for (let i = 0; i < faces.rows; i++) {
    const r = faces.data32F.slice(i * 15, i * 15 + 15);
    out.push({ x: r[0] * sx, y: r[1] * sy, w: r[2] * sx, h: r[3] * sy, score: r[14] });
  }
  m.delete();
  faces.delete();
  return out.sort((a, b) => b.w * b.h - a.w * a.h);
}
module.exports = { detect };
