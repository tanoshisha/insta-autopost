// classic-ai-retouch.js — Lightroom Classic プラグインから呼ばれる「AIレタッチ」。
//   node classic-ai-retouch.js plan   <フォルダ>  … 未レタッチの写真を見て、1枚ずつ現像設定を決める
//   node classic-ai-retouch.js review <フォルダ>  … レタッチ後の写真を見て、仕上げの修正を決める
// フォルダ: <ID>.jpg（Lightroomのプレビュー）と、review では <ID>.cur（今の設定 Key=Value）
// 出力: result.tsv … ID \t P|S \t Key=Value;Key=Value…（プラグインがそのまま当てる）
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const sharp = require("sharp");
sharp.cache(false);

const [mode, dir] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

const CLAUDE = path.join(process.env.USERPROFILE || "", ".local", "bin", "claude.exe");
const BATCH = 6; // 1回に見る枚数（1枚ずつじっくり見られるよう少なめ）

// 当ててよい項目と範囲（AIが極端な値を出しても安全な範囲に収める）
const RANGE = {
  Exposure2012: [-2, 3], Contrast2012: [-40, 70], Highlights2012: [-100, 20], Shadows2012: [-40, 80],
  Whites2012: [-80, 50], Blacks2012: [-80, 20], Texture: [-40, 50], Clarity2012: [-40, 50], Dehaze: [-20, 40],
  Vibrance: [-30, 50], Saturation: [-40, 25], TempDelta: [-1500, 1500], TintDelta: [-25, 25],
  PostCropVignetteAmount: [-40, 10],
  SplitToningShadowHue: [0, 359], SplitToningShadowSaturation: [0, 40], SplitToningHighlightHue: [0, 359],
  SplitToningHighlightSaturation: [0, 40], SplitToningBalance: [-60, 60],
  ParametricShadows: [-40, 40], ParametricDarks: [-40, 40], ParametricLights: [-40, 40], ParametricHighlights: [-40, 40],
  ParametricShadowSplit: [10, 40], ParametricMidtoneSplit: [35, 65], ParametricHighlightSplit: [60, 90],
  // カラーグレーディング（3ウェイ）
  ColorGradeMidtoneHue: [0, 359], ColorGradeMidtoneSat: [0, 30], ColorGradeShadowLum: [-40, 40], ColorGradeMidtoneLum: [-40, 40],
  ColorGradeHighlightLum: [-40, 40], ColorGradeGlobalHue: [0, 359], ColorGradeGlobalSat: [0, 25], ColorGradeBlending: [0, 100],
  // ディテール（シャープ・ノイズ）
  Sharpness: [0, 90], SharpenRadius: [0.5, 2.5], SharpenDetail: [0, 70], SharpenEdgeMasking: [0, 95],
  LuminanceSmoothing: [0, 60], LuminanceNoiseReductionDetail: [0, 80], ColorNoiseReduction: [0, 60],
  // レンズ補正・ゆがみ・傾き
  LensProfileEnable: [0, 1], AutoLateralCA: [0, 1], LensManualDistortionAmount: [-20, 20],
  DefringePurpleAmount: [0, 10], DefringeGreenAmount: [0, 10],
  PerspectiveUpright: [0, 4], PerspectiveVertical: [-30, 30], PerspectiveHorizontal: [-30, 30], PerspectiveRotate: [-5, 5], CropAngle: [-6, 6],
  // 周辺減光の形・粒子・キャリブレーション
  PostCropVignetteMidpoint: [0, 100], PostCropVignetteFeather: [0, 100], PostCropVignetteHighlightContrast: [0, 100],
  GrainAmount: [0, 30], GrainSize: [0, 50], GrainFrequency: [0, 70],
  ShadowTint: [-30, 30], RedHue: [-40, 40], RedSaturation: [-40, 40], GreenHue: [-40, 40], GreenSaturation: [-40, 40], BlueHue: [-40, 40], BlueSaturation: [-40, 40],
};
const DECIMAL = new Set(["Exposure2012", "SharpenRadius", "PerspectiveRotate", "CropAngle"]);
for (const c of ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"]) {
  RANGE[`HueAdjustment${c}`] = [-40, 40];
  RANGE[`SaturationAdjustment${c}`] = [-60, 40];
  RANGE[`LuminanceAdjustment${c}`] = [-50, 50];
}

// 白飛び・黒つぶれ・明るさの分布を数字で測る（AIの目だけに頼らない）
async function stats(file) {
  const { data, info } = await sharp(file).resize({ width: 600, withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const lum = new Uint32Array(256);
  let clipHi = 0, clipLo = 0, sum = 0, sat = 0;
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    lum[y]++;
    sum += y;
    if (r >= 250 || g >= 250 || b >= 250) clipHi++;
    if (r <= 4 && g <= 4 && b <= 4) clipLo++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    sat += mx ? (mx - mn) / mx : 0;
  }
  const pct = (p) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += lum[v]) >= n * p) return v;
    return 255;
  };
  return {
    白飛び: (clipHi / n * 100).toFixed(2) + "%",
    黒つぶれ: (clipLo / n * 100).toFixed(2) + "%",
    平均輝度: Math.round(sum / n),
    "輝度1%/50%/99%": `${pct(0.01)}/${pct(0.5)}/${pct(0.99)}`,
    平均彩度: (sat / n).toFixed(2),
  };
}

const STYLE = `【この写真家のいつもの仕上がり（約300枚の実データ）】
- ポートレート: コントラスト0・ハイライト-100・シャドウ+25・黒-20・テクスチャ/明瞭度0、カラーグレーディング シャドウ色相200彩度17／ハイライト色相33彩度14、肌はやわらかく（顔の肌マスクは別で入る）。明るく透明感、少し暖かい。
- スナップ: コントラスト+20・ハイライト-20・シャドウ+10・黒-20・テクスチャ/明瞭度+25、カラーグレーディング シャドウ色相214彩度23／ハイライト色相23彩度23。街の質感とメリハリ。
- 露光量は撮って出しから平均+0.6前後上げている。`;

const GOAL = `【目標】Instagramのフィードで指が止まる、作品として最高品質の仕上がり。凄腕のプロのレタッチャーとして判断する。
- 【白飛びは厳禁】空・雲・肌・白い服・白い壁・ネオンや看板の文字の階調を必ず残す。数値の「白飛び」は0.3%未満が目安（太陽・電球の芯など、もともと真っ白な点光源だけは例外）。超えていたらハイライト・白レベル・露光量を下げる。黒は締めるがつぶさない。
- スマホの小さい画面で映えるメリハリ（中間調のコントラスト・適度な明瞭度/テクスチャ）。ただしHDRっぽい不自然さ・ハロ・過剰な彩度はNG。
- 色: 肌は健康的で自然（オレンジの彩度/輝度で整える）。空の青は濁らせず、緑は少し落ち着かせると上品。全体の色はこの写真家のカラーグレーディングの方向性を活かしつつ、その写真に合う強さに。
- 主題に目がいく光の流れ（必要なら周辺を少し落とす）。夜景は暗さと光の美しさを残す。
- 【明るさの順番】主役（被写体）が画面でいちばん目を引く明るさにする。背景が主役より明るくならないこと。
  画面の端や背景に白飛び・明るすぎる所があって、意図しない所に目が行くのはNG（ハイライト・白レベル・周辺減光・かすみの除去などで抑える）。
- 写真ごとに最適化する（同じ値を機械的に当てない）。
- 【撮影データを必ず見る】レンズ・設定で露出・色・ノイズ・周辺減光が全部変わる。カメラ（機種で色と高感度の強さが違う）・レンズ（周辺減光・歪み・色収差・フリンジ・逆光のフレア）・焦点距離（広角は縦線の倒れとパース、望遠は圧縮とかすみ）・絞り（開放付近は周辺減光と色にじみが強い、絞るとかすみやすい）・シャッター速度（ブレ・夜の光跡）・ISO（高いほどノイズ処理を強く、シャドウを持ち上げすぎない）を見て決める。
- 【フィードの統一感】プロフィールのグリッドに並べた時に1つの作品集に見えること。この写真家の世界観は「深い黒・夜の光・シャドウ寒色/ハイライト暖色・彩度は控えめで上品」。
  昼の明るい写真もこの世界観に寄せる（白っぽく軽いトーンにしない・空の青は少し深く落ち着かせる・黒をしっかり締める・彩度は上げすぎない）。ただし不自然に暗くはしない。
- 基準は「お金を払ってもらえる作品／フォトコンテストで入賞するレベル」。無難な補正で終わらせず、その写真の魅力が最大になる仕上げにする。`;

const KEYS = `【使える項目】（すべて「最終的な値」で指定。TempDelta/TintDeltaだけは今の色温度/色かぶりからの差）
Exposure2012, Contrast2012, Highlights2012, Shadows2012, Whites2012, Blacks2012, Texture, Clarity2012, Dehaze, Vibrance, Saturation,
TempDelta(K), TintDelta, PostCropVignetteAmount(負で周辺減光),
ParametricShadows/Darks/Lights/Highlights（トーンカーブ）,
HueAdjustment{Red,Orange,Yellow,Green,Aqua,Blue,Purple,Magenta}, SaturationAdjustment{同}, LuminanceAdjustment{同},
SplitToningShadowHue, SplitToningShadowSaturation, SplitToningHighlightHue, SplitToningHighlightSaturation, SplitToningBalance（＝カラーグレーディングのシャドウ/ハイライト）,
ColorGradeMidtoneHue/Sat, ColorGradeShadowLum/MidtoneLum/HighlightLum, ColorGradeGlobalHue/Sat, ColorGradeBlending,
ParametricShadowSplit/MidtoneSplit/HighlightSplit（トーンカーブの区切り）,
Sharpness, SharpenRadius, SharpenDetail, SharpenEdgeMasking, LuminanceSmoothing, LuminanceNoiseReductionDetail, ColorNoiseReduction,
LensProfileEnable(1で有効), AutoLateralCA(1で色収差除去), LensManualDistortionAmount, DefringePurpleAmount, DefringeGreenAmount,
PerspectiveUpright(0オフ/1自動/2フル/3水平/4垂直), PerspectiveVertical, PerspectiveHorizontal, PerspectiveRotate, CropAngle(傾き補正・度),
PostCropVignetteMidpoint/Feather/HighlightContrast, GrainAmount/Size/Frequency,
ShadowTint, RedHue/RedSaturation, GreenHue/GreenSaturation, BlueHue/BlueSaturation（キャリブレーション）

【全部の項目を使ってよい】基本補正だけで終わらせず、必要なものは全部使う。
- レンズ補正（LensProfileEnable=1・AutoLateralCA=1）は基本いつも有効に。
- 水平・垂直：傾いた水平線や、建物の縦の線の倒れは直す（CropAngle・PerspectiveUpright 3/4 など）。わざと傾けた構図はそのまま。投稿は後で4:5に切り抜くので、Lightroomでは切り抜かない。
- シャープ・ノイズ：高感度の夜景はノイズを抑え（輝度ノイズ15〜35）、シャープはエッジだけに（マスク50〜80）。ポートレートの肌にシャープをかけすぎない。
- キャリブレーションで色の土台を整えるのも可（例：ブルーの彩度+で空気を澄ませる、レッドの色相で肌を整える）。
- 粒子は作品の雰囲気に合う時だけ控えめに。
- 【HDR的な仕上げの判断】逆光・夜景の光源と暗部・窓のある室内など明暗差が大きい時は、ハイライトを大きく下げシャドウを起こし、トーンカーブで中間のメリハリを戻す。ただしHDR感（灰色っぽい・ハロ・平坦）は出さない。明暗差を活かした方がドラマチックな写真（シルエット・光の筋）は暗部を起こさない。どちらが作品として強いかで決める。`;

// ポートレートは専用の基準で、いちばん賢いモデルが担当する
const PORTRAIT = `【ポートレートの基準】広告・雑誌のポートレートを手がけるトップレタッチャー（ファッション誌の表紙・企業広告のキービジュアルを任される人）として判断する。妥協しない。
- 肌が最優先: 透明感があり、健康的で、色かぶりのない肌。ホワイトバランスは肌基準で決める（黄・マゼンタ・グリーンかぶりを消す）。
  HSLのオレンジで肌を整える（色相はわずかに黄寄り、彩度は-5〜-15程度、輝度は+5〜+20程度）。赤みが強ければレッドの彩度を少し下げる。
- 顔に光が集まって見えること。顔が画面でいちばん明るい（か、それに近い）状態に。ハイライトを下げすぎて顔がくすむのはNG、目元が暗く沈むのもNG。
- 【人物を暗く沈ませない】逆光・夜・日陰などで人物（特に顔）が背景より暗い時は、全体の露光量を上げて背景を白飛びさせるのではなく、人物だけをマスクで持ち上げる。
  personLift で強さを選ぶ：0=不要 / 1=少し暗い（+0.3EV） / 2=はっきり暗い（+0.6EV） / 3=かなり沈んでいる（+0.9EV）。人物全体を選ぶAIマスクで明るくして、人物のハイライトは少し抑える（肌を白飛びさせない）。
  持ち上げた分を見込んで、全体の露光量は背景がきれいに見える明るさに決める。
- 【顔がいちばん明るい】頬に当てた手・腕・首・肩など体の肌が顔より明るいのはNG → hand=true（体の肌のAIマスクで少し暗くする）。
- 【背景は人物より暗く】背景（空・窓・壁・街の光）が人物より明るくて目がそっちへ行く時 → bg=true（人物以外を少し暗くし、背景のハイライトを抑える）。
- 白い服・明るい小物・背景の一部の白飛びで、顔以外に目が行くのもNG。
- 白い服・空・ボケの光は白飛びさせない（数値も見る）。黒は締めすぎず空気感を残すが、眠くはしない（トーンカーブで中間調のメリハリ）。
- 背景は主役より目立たせない: 背景の緑や青は彩度/輝度を少し落として上品に（グリーンは少し黄寄り・彩度控えめ）、必要なら周辺を少し落とす。
- 全体のテクスチャ/明瞭度はプラスにしない（0〜-10）。肌のなめらかさは顔の肌マスク（テクスチャ-20・明瞭度-10）が別で入る。
- カラーグレーディングはこの写真家の方向性（シャドウ寒色・ハイライト暖色、控えめ）を、肌が自然に見える強さで。
- 目指す仕上がり: 明るく透明感があり、人物に自然と目がいく、作品として見応えのある1枚。`;

// スナップ（街・風景・夜景）も専用の基準で
const SNAP = `【スナップ・風景・夜景の基準】写真集や広告のビジュアルを手がけるトップレタッチャーとして判断する。
- 光と影でドラマと奥行きを作る。空・光源・白い壁のハイライトは必ず回収し、黒は締めるがつぶさない（数値も見る）。
- 質感: テクスチャ/明瞭度で建築・路面・木々の質感を立てる（目安+10〜+30）。ただしハロ・ザラつき・HDR感は厳禁。
- 【風景・建築はカリカリに】（本人の好み）建物の壁・窓・石・木の葉・山の稜線など細部までくっきり。テクスチャ・明瞭度・シャープ（エッジだけにかかるようマスク高め）を強めに、遠景はかすみの除去で抜けを良くする。
  ポートレート（人物が主役）はやわらかく、風景・建築はカリカリ、と分ける。夜景・高感度はノイズが目立たない範囲で。
- 色を整理する: 主役の色（朱色・ネオン・夕焼けなど）を立て、雑多な色（看板・緑・青）は彩度/輝度を少し落として画面をまとめる。
  この写真家のカラーグレーディング（シャドウ寒色・ハイライト暖色）を、写真に合う強さで。空の青は濁らせない。
- 主題に視線が集まる光の流れ（トーンカーブ・周辺減光で誘導）。人物が小さく写る時も肌色は自然に。
- 夜景は夜らしい暗さと光の美しさを残す（持ち上げすぎない・光源の色を活かす・ネオンの白飛びと色飽和に注意）。
- 曇天や逆光の眠い素材は、中間調のコントラストとかすみの除去で抜けよく。ただし自然さを保つ。
- 目指す仕上がり: スマホの小さな画面でも一目で伝わる、見応えのある作品。`;

// 撮影データ（カメラ・レンズ・焦点距離・絞り・シャッター速度・ISO）。レンズや設定で露出・色・ノイズ・周辺減光が全部変わるので、AIに必ず見せる
let exifDb = null;
function shotInfo(file) {
  try {
    const id = Number(String(file).replace(/\.jpg$/i, ""));
    if (!Number.isFinite(id)) return null;
    exifDb ||= new (require("node:sqlite").DatabaseSync)("C:/Lightroom/Lightroom Catalog.lrcat", { readOnly: true });
    const r = exifDb
      .prepare(
        `select e.aperture av, e.shutterSpeed tv, e.isoSpeedRating iso, e.focalLength fl, e.flashFired fl2, c.value cam, l.value lens
         from AgHarvestedExifMetadata e left join AgInternedExifCameraModel c on c.id_local = e.cameraModelRef left join AgInternedExifLens l on l.id_local = e.lensRef where e.image = ?`
      )
      .get(id);
    if (!r) return null;
    const fnum = r.av != null ? `f${Math.pow(2, r.av / 2).toFixed(1).replace(/\.0$/, "")}` : null;
    const t = r.tv != null ? Math.pow(2, -r.tv) : null;
    const ss = t == null ? null : t >= 0.5 ? `${t.toFixed(1)}秒` : `1/${Math.round(1 / t)}秒`;
    return [r.cam, r.lens, r.fl ? `${Math.round(r.fl)}mm` : null, fnum, ss, r.iso ? `ISO${Math.round(r.iso)}` : null, r.fl2 ? "フラッシュ" : null].filter(Boolean).join(" / ");
  } catch {
    return null;
  }
}
function lines(files, info) {
  return files
    .map((f) => {
      const sh = shotInfo(f);
      return `- ${f}  測定値: ${JSON.stringify(info[f].stats)}${sh ? `\n  撮影: ${sh}` : ""}${info[f].cur ? `\n  今の設定: ${info[f].cur}` : ""}`;
    })
    .join("\n");
}

// kind: "plan"（全部をまず判定）| "portrait"（ポートレートを専門に決め直す）| "review"（仕上がりチェック）
function prompt(kind, files, info, portrait) {
  if (kind === "plan")
    return `${GOAL}

${STYLE}

カレントフォルダの次の写真を Read ツールで1枚ずつじっくり見てください（まだレタッチ前のRAWの見た目。露光量は撮影時のまま）:
${lines(files, info)}

各写真について:
1. portrait（人物が主役なら true。街並みの小さな人影・後ろ姿のスナップは false）
2. その写真に最適な現像設定を決める（Exposure2012 は「最終的な露光量」。今は0付近）

${KEYS}

出力は次のJSONだけ（説明やコードブロック不要）:
{"photos":[{"file":"123.jpg","portrait":false,"note":"何をどう狙ったか一言","settings":{"Exposure2012":0.6,"Contrast2012":20}}]}`;
  if (kind === "portrait")
    return `${GOAL}

${PORTRAIT}

${STYLE}

カレントフォルダの次のポートレートを Read ツールで1枚ずつ、プロの目でじっくり見てください（レタッチ前のRAWの見た目。露光量は撮影時のまま）:
${lines(files, info)}

それぞれに最高の現像設定を決めてください（Exposure2012 は「最終的な露光量」）。

${KEYS}

出力は次のJSONだけ（説明やコードブロック不要）:
{"photos":[{"file":"123.jpg","portrait":true,"personLift":2,"hand":false,"bg":true,"note":"肌・光・背景をどう仕上げたか一言","settings":{"Exposure2012":0.7}}]}`;
  if (kind === "snap")
    return `${GOAL}

${SNAP}

${STYLE}

カレントフォルダの次の写真（スナップ・風景・夜景）を Read ツールで1枚ずつ、プロの目でじっくり見てください（レタッチ前のRAWの見た目。露光量は撮影時のまま）:
${lines(files, info)}

それぞれに最高の現像設定を決めてください（Exposure2012 は「最終的な露光量」）。

${KEYS}

出力は次のJSONだけ（説明やコードブロック不要）:
{"photos":[{"file":"123.jpg","portrait":false,"note":"光・質感・色をどう仕上げたか一言","settings":{"Exposure2012":0.4}}]}`;
  return `${GOAL}

${portrait ? PORTRAIT : SNAP}

カレントフォルダの次の写真は、あなたが前回決めた設定でレタッチした結果です。Read ツールで1枚ずつ厳しくチェックしてください:
${lines(files, info)}

${portrait ? "トップのポートレートレタッチャーの目で、肌の色と質感・顔の明るさ・目元・白飛び・背景の主張・全体の空気感" : "トップレタッチャーの目で、光と影の奥行き・白飛び・黒つぶれ・眠さ・質感のやりすぎ・色の整理・空の色・主題への視線誘導"}を確認し、
作品として最高品質にするために直すべき所だけ修正値を出してください。問題がなければ settings は空でよい。

${KEYS}

出力は次のJSONだけ（説明やコードブロック不要）:
{"photos":[{"file":"123.jpg","note":"何を直したか一言","settings":{"Highlights2012":-80}}]}`;
}

const MODEL_PRO = cfg.retouchModel || cfg.aiModel || "claude-fable-5-1"; // 仕上げはポートレートもスナップもいちばん賢いモデル
const MODEL_SNAP = cfg.retouchModelSnap || cfg.aiModel || "claude-fable-5-1"; // 最初の振り分けだけ速いモデル

function ask(kind, files, info, model, portrait) {
  return new Promise((resolve, reject) => {
    const p = spawn(fs.existsSync(CLAUDE) ? CLAUDE : "claude", ["-p", "--allowedTools", "Read", "--output-format", "json", "--model", model], { cwd: dir });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill(), 25 * 60e3);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error("AIレタッチに失敗: " + (err || out).slice(0, 300));
        const m = (JSON.parse(out).result || "").match(/\{[\s\S]*\}/);
        resolve(JSON.parse(m[0]).photos || []);
      } catch (e) {
        reject(e);
      }
    });
    p.stdin.end(prompt(kind, files, info, portrait));
  });
}

function clean(settings) {
  const out = [];
  for (const [k, v] of Object.entries(settings || {})) {
    const r = RANGE[k];
    const x = Number(v);
    if (!r || !isFinite(x)) continue;
    const c = Math.min(r[1], Math.max(r[0], x));
    out.push(`${k}=${DECIMAL.has(k) ? c.toFixed(k === "Exposure2012" ? 2 : 1) : Math.round(c)}`);
  }
  // 傾き・ゆがみを直した時は、白いすき間が出ないよう自動で切り抜く
  if (out.some((x) => /^(PerspectiveUpright|PerspectiveVertical|PerspectiveHorizontal|PerspectiveRotate|CropAngle)=(?!0(.0)?$)/.test(x))) out.push("CropConstrainToWarp=1");
  return out.join(";");
}

// 3つずつ同時に
async function runAll(kind, files, info, model, portrait, size) {
  const batches = [];
  for (let i = 0; i < files.length; i += size) batches.push(files.slice(i, i + size));
  const all = [];
  for (let i = 0; i < batches.length; i += 3) {
    const res = await Promise.all(batches.slice(i, i + 3).map((b) => ask(kind, b, info, model, portrait).catch(() => [])));
    for (const r of res) all.push(...r);
  }
  return all;
}

(async () => {
  const files = fs.readdirSync(dir).filter((f) => /\.jpg$/i.test(f));
  const info = {};
  for (const f of files) {
    const curFile = path.join(dir, f.replace(/\.jpg$/i, ".cur"));
    const cur = fs.existsSync(curFile) ? fs.readFileSync(curFile, "utf8").trim() : null;
    info[f] = {
      stats: await stats(path.join(dir, f)),
      cur: cur ? cur.split(/\r?\n/).filter((l) => !l.startsWith("Kind=")).join(", ") : null,
      portrait: cur ? /^Kind=P/m.test(cur) : false,
    };
  }
  const result = new Map(); // file → { portrait, note, settings }
  if (mode === "plan") {
    // ① まず全部を見て、ポートレートかどうかとスナップの設定を決める
    for (const r of await runAll("plan", files, info, MODEL_SNAP, false, BATCH)) result.set(r.file, r);
    // ② ポートレートは専門の基準で、いちばん賢いモデルが決め直す
    // ② ポートレートもスナップも、それぞれ専門の基準でいちばん賢いモデルが決め直す
    const ps = files.filter((f) => result.get(f)?.portrait);
    const ss = files.filter((f) => result.has(f) && !result.get(f).portrait);
    for (const r of await runAll("portrait", ps, info, MODEL_PRO, true, 3)) result.set(r.file, { ...r, portrait: true });
    for (const r of await runAll("snap", ss, info, MODEL_PRO, false, 3)) result.set(r.file, { ...r, portrait: false });
  } else {
    const ps = files.filter((f) => info[f].portrait);
    const ss = files.filter((f) => !info[f].portrait);
    for (const r of await runAll("review", ps, info, MODEL_PRO, true, 3)) result.set(r.file, { ...r, portrait: true });
    for (const r of await runAll("review", ss, info, MODEL_PRO, false, 3)) result.set(r.file, r);
  }
  const rows = [];
  const notes = [];
  for (const [file, r] of result) {
    const id = String(file).replace(/\.jpg$/i, "");
    const p = r.portrait || info[file]?.portrait;
    // ポートレートは P のあとに「人物を明るくする強さ」（P1〜P3。0なら P だけ）。仕上げチェック（review）では付けない（プリセットは最初だけ当てる）
    const lift = p && mode === "plan" ? Math.max(0, Math.min(3, Math.round(Number(r.personLift) || 0))) : 0;
    const hb = p && mode === "plan" ? (r.hand ? "h" : "") + (r.bg ? "b" : "") : ""; // h：手・腕を抑える／b：背景を抑える
    rows.push(`${id}\t${p ? "P" + (lift || "") + hb : "S"}\t${clean(r.settings)}`);
    notes.push(`${mode} ${id} ${p ? `[P${lift ? " 人物+" + lift : ""}]` : ""} ${r.note || ""} | ${clean(r.settings)}`);
  }
  fs.writeFileSync(path.join(dir, "result.tsv"), rows.join("\n") + "\n");
  fs.appendFileSync(path.join(dir, "..", "retouch.log"), `${new Date().toISOString()} ${mode} ${files.length}枚\n${notes.join("\n")}\n`);
})().catch((e) => {
  fs.appendFileSync(path.join(dir, "..", "retouch.log"), `${new Date().toISOString()} エラー: ${e.message}\n`);
  process.exit(1);
});
