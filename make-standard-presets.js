// make-standard-presets.js — 分析結果（lib/retouch-standards.js）に合わせた「出発点」のプリセットを作る
//   Lightroom Classic 用：%APPDATA%\Adobe\CameraRaw\Settings（再起動で出る）
//   クラウド版・iPhone 用：iCloud Drive の「Lightroomプリセット」フォルダに同じ .xmp を置く（iPhone の Lightroom → プリセット → … → プリセットを読み込み）
//   露光量・ホワイトバランスは写真ごとに違うので入れない。マスク入りのポートレートは「NAOE ポートレート 人物+…」（make-person-presets.js）と組み合わせる
//   node make-standard-presets.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const DIR = path.join(process.env.APPDATA, "Adobe", "CameraRaw", "Settings");
const CLOUD = "C:/Users/tanos/iCloudDrive/Lightroomプリセット";
const BASE = fs.readFileSync(path.join(DIR, "NAOE スナップ.xmp"), "utf8").split("\r\n").join("\n");
const hex = () => crypto.randomBytes(16).toString("hex").toUpperCase();
const sign = (n) => (n > 0 ? `+${n}` : `${n}`);

// 各プリセットの値（分析の「Lightroom 設定の目標」の中央あたり）
const P = {
  "NAOE 基準 夜の街": { Contrast2012: 12, Highlights2012: -45, Shadows2012: 20, Whites2012: -20, Blacks2012: 6, Texture: 15, Clarity2012: 8, Dehaze: 5, Vibrance: 5, Saturation: -12, PostCropVignetteAmount: -14, Sharpness: 50, SharpenRadius: 0.9, SharpenDetail: 30, SharpenEdgeMasking: 50, LuminanceSmoothing: 20, SplitToningShadowHue: 220, SplitToningShadowSaturation: 6, SplitToningHighlightHue: 40, SplitToningHighlightSaturation: 12, SplitToningBalance: 0 },
  "NAOE 基準 昼の街": { Contrast2012: 15, Highlights2012: -35, Shadows2012: 12, Whites2012: -10, Blacks2012: -12, Texture: 20, Clarity2012: 10, Dehaze: 4, Vibrance: 5, Saturation: -8, PostCropVignetteAmount: -8, Sharpness: 50, SharpenRadius: 0.9, SharpenDetail: 30, SharpenEdgeMasking: 40, LuminanceSmoothing: 5, SplitToningShadowHue: 215, SplitToningShadowSaturation: 4, SplitToningHighlightHue: 42, SplitToningHighlightSaturation: 8, SplitToningBalance: 0 },
  "NAOE 基準 風景": { Contrast2012: 12, Highlights2012: -45, Shadows2012: 15, Whites2012: -10, Blacks2012: -5, Texture: 25, Clarity2012: 8, Dehaze: 8, Vibrance: 8, Saturation: -8, PostCropVignetteAmount: -6, Sharpness: 45, SharpenRadius: 0.8, SharpenDetail: 35, SharpenEdgeMasking: 70, LuminanceSmoothing: 15, SplitToningShadowHue: 215, SplitToningShadowSaturation: 3, SplitToningHighlightHue: 42, SplitToningHighlightSaturation: 6, SplitToningBalance: 0 },
  "NAOE 基準 建築": { Contrast2012: 18, Highlights2012: -40, Shadows2012: 10, Whites2012: -8, Blacks2012: -12, Texture: 32, Clarity2012: 15, Dehaze: 8, Vibrance: 0, Saturation: -12, PostCropVignetteAmount: -6, Sharpness: 60, SharpenRadius: 0.8, SharpenDetail: 42, SharpenEdgeMasking: 30, LuminanceSmoothing: 5, SplitToningShadowHue: 215, SplitToningShadowSaturation: 2, SplitToningHighlightHue: 42, SplitToningHighlightSaturation: 3, SplitToningBalance: 0 },
  "NAOE 基準 ポートレート 昼": { Contrast2012: 10, Highlights2012: -55, Shadows2012: 18, Whites2012: -22, Blacks2012: -10, Texture: 0, Clarity2012: 0, Dehaze: 0, Vibrance: 10, Saturation: -3, PostCropVignetteAmount: -8, Sharpness: 35, SharpenRadius: 1.0, SharpenDetail: 25, SharpenEdgeMasking: 70, LuminanceSmoothing: 10, SplitToningShadowHue: 215, SplitToningShadowSaturation: 2, SplitToningHighlightHue: 40, SplitToningHighlightSaturation: 10, SplitToningBalance: 5, HueAdjustmentOrange: 3, SaturationAdjustmentOrange: -10, LuminanceAdjustmentOrange: 10, HueAdjustmentRed: 4, SaturationAdjustmentRed: -8, LuminanceAdjustmentRed: 5, SaturationAdjustmentYellow: -15 },
  "NAOE 基準 ポートレート 夜": { Contrast2012: 8, Highlights2012: -80, Shadows2012: 15, Whites2012: -30, Blacks2012: -5, Texture: 0, Clarity2012: 0, Dehaze: 0, Vibrance: 15, Saturation: 0, PostCropVignetteAmount: -12, Sharpness: 35, SharpenRadius: 1.0, SharpenDetail: 25, SharpenEdgeMasking: 70, LuminanceSmoothing: 25, SplitToningShadowHue: 220, SplitToningShadowSaturation: 4, SplitToningHighlightHue: 40, SplitToningHighlightSaturation: 12, SplitToningBalance: 0, HueAdjustmentOrange: 2, SaturationAdjustmentOrange: -15, LuminanceAdjustmentOrange: 10, SaturationAdjustmentRed: -10 },
  "NAOE 基準 ポートレート 逆光": { Contrast2012: 8, Highlights2012: -85, Shadows2012: 20, Whites2012: -40, Blacks2012: -8, Texture: 0, Clarity2012: 0, Dehaze: 10, Vibrance: 5, Saturation: -8, PostCropVignetteAmount: -6, Sharpness: 35, SharpenRadius: 1.0, SharpenDetail: 25, SharpenEdgeMasking: 70, LuminanceSmoothing: 10, SplitToningShadowHue: 40, SplitToningShadowSaturation: 5, SplitToningHighlightHue: 40, SplitToningHighlightSaturation: 3, SplitToningBalance: 0, HueAdjustmentOrange: 3, SaturationAdjustmentOrange: -10, LuminanceAdjustmentOrange: 10 },
};
const DEC = new Set(["SharpenRadius"]);
fs.mkdirSync(CLOUD, { recursive: true });
let n = 0;
for (const [name, v] of Object.entries(P)) {
  let s = BASE;
  // 既にある属性は置き換え、無いものは crs:Version の後ろに足す
  for (const [k, val] of Object.entries(v)) {
    const str = DEC.has(k) ? String(val) : sign(Math.round(val));
    const re = new RegExp(`crs:${k}="[^"]*"`);
    if (re.test(s)) s = s.replace(re, `crs:${k}="${str}"`);
    else s = s.replace(/(crs:Version="[^"]*")/, `$1\n   crs:${k}="${str}"`);
  }
  // 肌のマスクやテクスチャ補正は入れない（ポートレートはマスク入りの「NAOE ポートレート 人物+…」と重ねる）
  s = s.replace(/crs:UUID="[0-9A-F]+"/, `crs:UUID="${hex()}"`).replace(/<rdf:li xml:lang="x-default">NAOE スナップ<\/rdf:li>/, `<rdf:li xml:lang="x-default">${name}</rdf:li>`);
  fs.writeFileSync(path.join(DIR, `${name}.xmp`), s);
  fs.writeFileSync(path.join(CLOUD, `${name}.xmp`), s);
  n++;
}
// マスク入りのポートレート用プリセットもクラウド用フォルダへ
for (const f of fs.readdirSync(DIR)) if (/^NAOE (ポートレート|スナップ)/.test(f)) fs.copyFileSync(path.join(DIR, f), path.join(CLOUD, f));
console.log(`基準プリセット ${n}個を作成（Classic：${DIR}／iPhone用：${CLOUD}）`);
