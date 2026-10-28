// make-presets.js — 普段のレタッチ（Lightroomアルバム「インスタ投稿」の編集済み写真）を集計して、
// Lightroom のプリセット「NAOE ポートレート」「NAOE スナップ」を作る。
//   Lightroom の外部APIでは、取り込み済みの写真の編集を書き換えられない（Adobeの制限）ため、プリセットで再現する。
//   露光量・ホワイトバランスは写真ごとに違うので入れない（ライト・効果・カラーグレーディング・肌のマスク）。
//   node make-presets.js   … 集計して %APPDATA%\Adobe\CameraRaw\Settings に保存（Lightroom を再起動すると出てくる）
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { connect, listAlbum } = require("./lib/lightroom");

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const OUT = path.join(process.env.APPDATA, "Adobe", "CameraRaw", "Settings");

const median = (v) => {
  const s = v.filter((x) => !isNaN(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};
const attr = (x, k) => {
  const m = x.split("<crs:Look>")[0].match(new RegExp(`crs:${k}="([^"]*)"`));
  return m ? +m[1] : NaN;
};
const sign = (n) => (n > 0 ? `+${n}` : `${n}`);

async function main() {
  const lr = await connect(cfg.lightroom.configPath);
  const assets = await listAlbum(lr, cfg.lightroom.albumName);
  const xmps = [];
  for (const a of assets) {
    const r = await fetch(`https://lr.adobe.io/v2/catalogs/${lr.catalogId}/assets/${a.id}/xmp/develop`, { headers: lr.headers });
    if (r.ok) xmps.push(await r.text());
  }
  // 編集済み（ハイライト・シャドウ・黒レベルのどれかを触っている）だけを集計
  const edited = xmps.filter((x) => attr(x, "Highlights2012") || attr(x, "Shadows2012") || attr(x, "Blacks2012"));
  // ポートレート＝顔の肌を補正しているか、テクスチャ/明瞭度を上げていない写真 / スナップ＝テクスチャを上げている写真
  const portrait = edited.filter((x) => x.includes("顔の肌") || (attr(x, "Texture") <= 0 && attr(x, "Contrast2012") === 0));
  const snap = edited.filter((x) => attr(x, "Texture") > 0);
  console.log(`編集済み ${edited.length}枚（ポートレート系 ${portrait.length} / スナップ系 ${snap.length}）`);

  const KEYS = ["Contrast2012", "Highlights2012", "Shadows2012", "Whites2012", "Blacks2012", "Texture", "Clarity2012", "Dehaze", "Vibrance", "Saturation", "PostCropVignetteAmount", "GrainAmount"];
  const GRADE = ["SplitToningShadowHue", "SplitToningShadowSaturation", "SplitToningHighlightHue", "SplitToningHighlightSaturation", "SplitToningBalance", "ColorGradeBlending"];
  const style = (list) => {
    const s = {};
    for (const k of KEYS) s[k] = Math.round(median(list.map((x) => attr(x, k))));
    // カラーグレーディングは「使っている写真」の値で（使っていない写真が多いと0になってしまうので）
    const graded = list.filter((x) => attr(x, "SplitToningShadowSaturation") > 0);
    for (const k of GRADE) s[k] = Math.round(median((graded.length >= list.length * 0.3 ? graded : list).map((x) => attr(x, k))));
    if (isNaN(s.ColorGradeBlending) || !s.ColorGradeBlending) s.ColorGradeBlending = 50;
    return s;
  };
  // 顔の肌マスクの補正量（写真ごとの位置情報は外して、どの写真でも自動で顔を探すようにする）
  const skin = portrait.filter((x) => x.includes("顔の肌を補正"));
  const skinTex = median(skin.map((x) => +(x.match(/顔の肌を補正"[\s\S]*?crs:LocalTexture="([^"]*)"/) || [])[1]));
  const skinCla = median(skin.map((x) => +(x.match(/顔の肌を補正"[\s\S]*?crs:LocalClarity2012="([^"]*)"/) || [])[1]));

  const presets = [
    { name: "NAOE ポートレート", s: style(portrait), skin: skin.length ? { tex: skinTex || -0.2, cla: skinCla || -0.1 } : null },
    { name: "NAOE スナップ", s: style(snap), skin: null },
  ];
  fs.mkdirSync(OUT, { recursive: true });
  for (const p of presets) {
    const file = path.join(OUT, `${p.name}.xmp`);
    fs.writeFileSync(file, presetXmp(p));
    console.log(`\n■ ${p.name} → ${file}`);
    console.log(Object.entries(p.s).map(([k, v]) => `  ${k} ${sign(v)}`).join("\n"));
    if (p.skin) console.log(`  顔の肌マスク: テクスチャ ${Math.round(p.skin.tex * 100)} / 明瞭度 ${Math.round(p.skin.cla * 100)}`);
  }
}

function presetXmp({ name, s, skin }) {
  const uuid = crypto.createHash("md5").update("naoe:" + name).digest("hex").toUpperCase();
  const attrs = Object.entries(s)
    .map(([k, v]) => `   crs:${k}="${k.startsWith("SplitToning") || k === "ColorGradeBlending" ? v : sign(v)}"`)
    .join("\n");
  const mask = skin
    ? `
   <crs:MaskGroupBasedCorrections>
    <rdf:Seq>
     <rdf:li>
      <rdf:Description
       crs:What="Correction"
       crs:CorrectionAmount="1"
       crs:CorrectionActive="true"
       crs:CorrectionName="顔の肌を補正"
       crs:CorrectionSyncID="${crypto.createHash("md5").update(uuid + "c").digest("hex").toUpperCase()}"
       crs:LocalExposure2012="0"
       crs:LocalContrast2012="0"
       crs:LocalHighlights2012="0"
       crs:LocalShadows2012="0"
       crs:LocalWhites2012="0"
       crs:LocalBlacks2012="0"
       crs:LocalClarity2012="${skin.cla}"
       crs:LocalDehaze="0"
       crs:LocalTexture="${skin.tex}"
       crs:LocalSaturation="0"
       crs:LocalTemperature="0"
       crs:LocalTint="0"
       crs:LocalCurveRefineSaturation="100">
      <crs:CorrectionMasks>
       <rdf:Seq>
        <rdf:li
         crs:What="Mask/Image"
         crs:MaskActive="true"
         crs:MaskName="顔の肌"
         crs:MaskBlendMode="0"
         crs:MaskInverted="false"
         crs:MaskSyncID="${crypto.createHash("md5").update(uuid + "m").digest("hex").toUpperCase()}"
         crs:MaskValue="1"
         crs:MaskVersion="1"
         crs:MaskSubType="3"
         crs:MaskSubCategoryID="2"/>
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
    </rdf:Seq>
   </crs:MaskGroupBasedCorrections>`
    : "";
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000 1.000000, 0000/00/00-00:00:00        ">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:PresetType="Normal"
   crs:Cluster=""
   crs:UUID="${uuid}"
   crs:SupportsAmount="False"
   crs:SupportsColor="True"
   crs:SupportsMonochrome="True"
   crs:SupportsHighDynamicRange="True"
   crs:SupportsNormalDynamicRange="True"
   crs:SupportsSceneReferred="True"
   crs:SupportsOutputReferred="False"
   crs:RequiresRGBTables="False"
   crs:CameraModelRestriction=""
   crs:Copyright=""
   crs:ContactInfo=""
   crs:Version="18.7"
   crs:ProcessVersion="15.4"
${attrs}
   crs:HasSettings="True">
   <crs:Name>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">${name}</rdf:li>
    </rdf:Alt>
   </crs:Name>
   <crs:ShortName>
    <rdf:Alt>
     <rdf:li xml:lang="x-default"/>
    </rdf:Alt>
   </crs:ShortName>
   <crs:SortName>
    <rdf:Alt>
     <rdf:li xml:lang="x-default"/>
    </rdf:Alt>
   </crs:SortName>
   <crs:Group>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">NAOE WORKS</rdf:li>
    </rdf:Alt>
   </crs:Group>
   <crs:Description>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">インスタ投稿の普段のレタッチ（自動集計）</rdf:li>
    </rdf:Alt>
   </crs:Description>${mask}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;
}

main().catch((e) => {
  console.error("エラー: " + e.message);
  process.exit(1);
});
