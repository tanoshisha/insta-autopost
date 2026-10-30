// make-person-presets.js — ポートレートの明るさの順番を整えるプリセットを作る（本人の指示 2026-10-31）
//   「顔がいちばん明るく見える」「被写体より背景が明るくならない」「頬に当てた手が顔より明るい、はダメ」
//   「NAOE ポートレート」（顔の肌のマスク入り）に、Lightroom の「人物を選択」AIマスクを使った補正を足した組み合わせ
//     人物+1〜3 … 人物全体を明るく（+0.3 / +0.6 / +0.9EV。人物のハイライトは少し抑える）
//     手-1     … 体の肌（手・腕・首）を少し暗く（-0.3EV・ハイライトを抑える）＝顔より手が明るい時
//     背景-1   … 人物以外（人物全体のマスクを反転）を暗く（-0.4EV・ハイライトを抑える）＝背景が人物より明るい時
//   名前の例：「NAOE ポートレート 人物+2 手-1 背景-1」。AIマスクのプリセットは当てた写真ごとに人物を選び直す
//   node make-person-presets.js → %APPDATA%\Adobe\CameraRaw\Settings に保存（Lightroom Classic を再起動すると出てくる）
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const DIR = path.join(process.env.APPDATA, "Adobe", "CameraRaw", "Settings");
const BASE = path.join(DIR, "NAOE ポートレート.xmp");
const hex = () => crypto.randomBytes(16).toString("hex").toUpperCase();

// ローカル補正の値は -1〜+1（露光量は ±4EV を ±1 で表す）
function correction(name, mask, { ev = 0, hi = 0, sh = 0, wh = 0, inverted = false }) {
  return `     <rdf:li>
      <rdf:Description
       crs:What="Correction"
       crs:CorrectionAmount="1"
       crs:CorrectionActive="true"
       crs:CorrectionName="${name}"
       crs:CorrectionSyncID="${hex()}"
       crs:LocalExposure2012="${(ev / 4).toFixed(4)}"
       crs:LocalContrast2012="0"
       crs:LocalHighlights2012="${hi}"
       crs:LocalShadows2012="${sh}"
       crs:LocalWhites2012="${wh}"
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
         crs:MaskName="${mask.name}"
         crs:MaskBlendMode="0"
         crs:MaskInverted="${inverted}"
         crs:MaskSyncID="${hex()}"
         crs:MaskValue="1"
         crs:MaskVersion="1"
         crs:MaskSubType="3"
         crs:MaskSubCategoryID="${mask.id}"/>
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
`;
}
const PERSON = { name: "人物全体", id: 1 };
const BODY = { name: "体の肌", id: 3 };
const LIFT = { 1: 0.3, 2: 0.6, 3: 0.9 };

const base = fs.readFileSync(BASE, "utf8").split("\r\n").join("\n");
const end = "    </rdf:Seq>\n   </crs:MaskGroupBasedCorrections>";
if (!base.includes(end)) throw new Error("マスクの場所が見つかりません");
// 前に作った「人物+n」だけのプリセットも作り直す
for (const f of fs.readdirSync(DIR)) if (/^NAOE ポートレート (人物|手|背景)/.test(f)) fs.rmSync(path.join(DIR, f));
let n = 0;
for (const lift of [0, 1, 2, 3])
  for (const hand of [0, 1])
    for (const bg of [0, 1]) {
      if (!lift && !hand && !bg) continue; // 何もしない＝元の「NAOE ポートレート」
      const parts = [];
      let add = "";
      if (lift) (parts.push(`人物+${lift}`), (add += correction("人物を明るく", PERSON, { ev: LIFT[lift], hi: -0.1 - lift * 0.05, sh: 0.05 * lift })));
      if (hand) (parts.push("手-1"), (add += correction("手・腕を抑える", BODY, { ev: -0.3, hi: -0.25, wh: -0.1 })));
      if (bg) (parts.push("背景-1"), (add += correction("背景を抑える", PERSON, { ev: -0.4, hi: -0.3, wh: -0.15, inverted: true })));
      const name = `NAOE ポートレート ${parts.join(" ")}`;
      const s = base
        .replace(end, add + end)
        .replace(/crs:UUID="[0-9A-F]+"/, `crs:UUID="${hex()}"`)
        .replace('<rdf:li xml:lang="x-default">NAOE ポートレート</rdf:li>', `<rdf:li xml:lang="x-default">${name}</rdf:li>`);
      fs.writeFileSync(path.join(DIR, `${name}.xmp`), s);
      n++;
    }
console.log(`ポートレートのプリセット ${n}個を作りました`);
