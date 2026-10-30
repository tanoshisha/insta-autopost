// make-person-presets.js — ポートレートで「人物が暗く沈まない」ためのプリセットを作る（本人の指示 2026-10-31）
//   「NAOE ポートレート」（顔の肌のマスク入り）に、人物全体を選ぶAIマスク（Lightroom の「人物を選択」→人物全体）で明るくする補正を足した3段階
//     NAOE ポートレート 人物+1 … +0.3EV / +2 … +0.6EV / +3 … +0.9EV（人物のハイライトは少し抑えて白飛びさせない）
//   AIマスクのプリセットは当てた写真ごとに人物を選び直すので、どの写真にも使える
//   node make-person-presets.js → %APPDATA%\Adobe\CameraRaw\Settings に保存（Lightroom Classic を再起動すると出てくる）
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const DIR = path.join(process.env.APPDATA, "Adobe", "CameraRaw", "Settings");
const BASE = path.join(DIR, "NAOE ポートレート.xmp");
const hex = () => crypto.randomBytes(16).toString("hex").toUpperCase();

const base = fs.readFileSync(BASE, "utf8");
// ローカル補正の値は -1〜+1（露光量は ±4EV を ±1 で表す）
const LEVELS = [
  { n: 1, ev: 0.3, hi: -0.1, sh: 0.05 },
  { n: 2, ev: 0.6, hi: -0.15, sh: 0.1 },
  { n: 3, ev: 0.9, hi: -0.2, sh: 0.15 },
];
for (const L of LEVELS) {
  const name = `NAOE ポートレート 人物+${L.n}`;
  const corr = `     <rdf:li>
      <rdf:Description
       crs:What="Correction"
       crs:CorrectionAmount="1"
       crs:CorrectionActive="true"
       crs:CorrectionName="人物を明るく"
       crs:CorrectionSyncID="${hex()}"
       crs:LocalExposure2012="${(L.ev / 4).toFixed(4)}"
       crs:LocalContrast2012="0"
       crs:LocalHighlights2012="${L.hi}"
       crs:LocalShadows2012="${L.sh}"
       crs:LocalWhites2012="0"
       crs:LocalBlacks2012="0"
       crs:LocalClarity2012="0"
       crs:LocalDehaze="0"
       crs:LocalTexture="0"
       crs:LocalSaturation="0"
       crs:LocalTemperature="0"
       crs:LocalTint="0"
       crs:LocalCurveRefineSaturation="100">
      <crs:CorrectionMasks>
       <rdf:Seq>
        <rdf:li
         crs:What="Mask/Image"
         crs:MaskActive="true"
         crs:MaskName="人物全体"
         crs:MaskBlendMode="0"
         crs:MaskInverted="false"
         crs:MaskSyncID="${hex()}"
         crs:MaskValue="1"
         crs:MaskVersion="1"
         crs:MaskSubType="3"
         crs:MaskSubCategoryID="1"/>
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
`;
  const end = "    </rdf:Seq>\n   </crs:MaskGroupBasedCorrections>";
  const s0 = base.split("\r\n").join("\n");
  if (!s0.includes(end)) throw new Error("マスクの場所が見つかりません");
  const s = s0
    .replace(end, corr + end)
    .replace(/crs:UUID="[0-9A-F]+"/, `crs:UUID="${hex()}"`)
    .replace("<rdf:li xml:lang=\"x-default\">NAOE ポートレート</rdf:li>", `<rdf:li xml:lang="x-default">${name}</rdf:li>`);
  fs.writeFileSync(path.join(DIR, `${name}.xmp`), s);
  console.log("作成: " + name);
}
