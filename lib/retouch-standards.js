// レタッチの基準（2026-10-31〜11-01 の分析から。.work/retouch-study/report.md と .work/portrait-study/report.md の「先に結論」）
//   参考にしたもの：インスタで安定して伸びている写真家・広告/雑誌のプロの作法・フォトコン入賞作（SWPA/IPA/富士＝722枚、ポートレートは2,557枚）
//   本人の今の仕上げに合わせるのではなく、上手い人に寄せる（本人の指示）。数値の測り方は lib/photo-metrics.js
//   genre: night（街・夜景）/ day（街スナップ・旅）/ landscape / architecture / portrait（昼・夜・逆光は数値で自動判定）
//   ※ 街系の「インスタで伸びている人」の数値は収集中（2026-11-01 時点 4件）。そろったら T を見直す

const T = {
  night: { meanY: [50, 65], p50: [36, 48], crush: [3, 10], clip: [0, 0.1], clipAny: [0, 0.3], p98: [185, 205], sat: [0.3, 0.4], rb: [-2, 8], shRb: [-4, 3], hiRb: [10, 25], lapVar: [600, null], ringMinusCenter: [null, -5] },
  day: { meanY: [100, 125], p50: [95, 130], crush: [0.5, 3], clip: [0, 0.3], clipAny: [0, 0.5], p98: [210, 228], sat: [0.25, 0.33], rb: [-2, 8], shRb: [-2, 4], hiRb: [5, 15], lapVar: [800, null] },
  landscape: { meanY: [105, 125], p02: [18, 30], crush: [0, 1], clip: [0, 0.1], clipAny: [0, 0.3], p98: [212, 226], sat: [0.24, 0.34], rb: [-3, 4], lapVar: [750, null] },
  architecture: { meanY: [85, 120], p02: [8, 16], crush: [0.2, 1.2], clip: [0, 0.1], clipAny: [0, 0.3], sat: [0.22, 0.28], rb: [-5, 1], shRb: [-3, 2], hiRb: [-2, 4], lapVar: [1000, null] },
  // ポートレート（L*系）。昼／夜／逆光（背景が顔より明るい）で分ける
  "portrait-day": { clip: [0, 0.1], clipAny: [0, 0.5], p99L: [null, 96], faceSkinL: [62, 72], bgMinusFace: [null, -8], bgBrighterThanFace10: [null, 20], bodyMinusFace: [null, -2], brighterThanFace10: [null, 12], faceHue: [18, 24], faceSat: [0.3, 0.42], faceA: [10, 16], faceB: [14, 21], crush: [0, 0.5], ringMinusCenter: [null, 0], meanL: [42, 60], sat: [0.28, 0.42], sdL: [20, 26] },
  "portrait-night": { clip: [0, 0.1], clipAny: [0, 0.3], p99L: [null, 90], faceSkinL: [50, 60], bgMinusFace: [null, -20], bgBrighterThanFace10: [null, 5], bodyMinusFace: [null, -2], brighterThanFace10: [null, 6], faceHue: [17, 22], faceSat: [0.33, 0.45], faceA: [10, 16], faceB: [14, 21], crush: [0, 3], meanL: [22, 32], sat: [0.38, 0.55], sdL: [18, 24] },
  "portrait-backlit": { clip: [0, 0.3], clipAny: [0, 1.0], p99L: [null, 97], faceSkinL: [55, 65], bgMinusFace: [null, 12], bgBrighterThanFace10: [null, 60], bodyMinusFace: [null, 1], brighterThanFace10: [null, 35], faceHue: [18, 24], faceSat: [0.3, 0.42], faceA: [10, 16], faceB: [14, 21], crush: [0, 0.3], meanL: [50, 68], sat: [0.18, 0.28], sdL: [20, 25] },
};
const NAME = {
  meanY: "平均の明るさY", p50: "中間Y", p02: "黒点Y", p98: "白点Y", crush: "黒つぶれ%", clip: "白飛び%", clipAny: "1チャンネル飛び%", sat: "彩度", rb: "色温度R−B", shRb: "シャドウR−B", hiRb: "ハイライトR−B", lapVar: "シャープさ", ringMinusCenter: "周辺−中央",
  p99L: "いちばん明るい1% L*", faceSkinL: "顔の肌L*", bgMinusFace: "背景−顔L*", bgBrighterThanFace10: "背景で顔+10より明るい%", bodyMinusFace: "体の肌−顔L*", brighterThanFace10: "顔以外で顔+10より明るい%（画面比）", faceHue: "肌の色相°", faceSat: "肌の彩度", faceA: "肌a*", faceB: "肌b*", meanL: "平均L*", sdL: "L*のばらつき",
};
// 直し方のヒント（項目が外れた時に AI に渡す）
const HINT = {
  clip: "白レベル・ハイライト・露光量を下げる（光源の芯だけ例外）", clipAny: "白レベルを下げる／ハイライト−（色が残るように）", crush: "黒レベルを戻す（＋）か、シャドウ＋。逆に少なすぎる時は黒レベル−", sat: "彩度／自然な彩度を調整（上限0.35が全投稿の統一ルール。夜のポートレートだけ高め可）", rb: "色温度（暖色寄りなら寒色側へ300〜500K）またはHSLオレンジの彩度−", shRb: "カラーグレーディングのシャドウを中立〜わずかに青へ", hiRb: "カラーグレーディングのハイライトを暖色（+10〜+25）に", lapVar: "テクスチャ＋・明瞭度＋・シャープ適用量40〜60（マスクで空や肌は外す）", ringMinusCenter: "周辺光量−5〜−15で視線を中央へ", p98: "白レベルで白点を調整", meanY: "露光量", p50: "露光量・トーンカーブ", p02: "黒レベル",
  p99L: "白レベル−15〜−30・ハイライト−40〜−70・背景マスクのハイライト−", faceSkinL: "露光量（頬が昼58〜66%・夜46〜56%）＋人物マスク（人物+1〜3）", bgMinusFace: "背景マスク：露光−0.3〜−0.8・ハイライト−・彩度−（背景-1）", bgBrighterThanFace10: "背景マスクのハイライト−40〜−100・線形グラデーションで空や路面を落とす", bodyMinusFace: "体の肌マスク −0.3〜−0.6EV（手-1）", brighterThanFace10: "背景・端の明るい面を落とす（周辺光量・グラデーション）", faceHue: "HSLレッド/オレンジの色相を+3〜+5（赤→橙）", faceSat: "HSLオレンジの彩度−5〜−15", faceA: "レッドの彩度−（赤黒さを抜く）", faceB: "色温度・色かぶりで肌の黄みを調整", meanL: "露光量（顔だけ明るく、背景は顔より暗いままでよい）", sdL: "コントラスト",
};

function genreOf(m, hint) {
  if (hint && T[hint]) return hint;
  if (m.nFaces && (hint === "portrait" || (m.faceArea || 0) >= 1.5)) return m.backlit ? "portrait-backlit" : m.night ? "portrait-night" : "portrait-day";
  return m.night ? "night" : "day";
}
// 実測が目標から外れている項目を列挙（AI の仕上げチェック用）
function check(m, genre) {
  const t = T[genre] || T.day;
  const out = [];
  for (const [k, [lo, hi]] of Object.entries(t)) {
    const v = m[k];
    if (v == null) continue;
    if (k === "lapVar" && m.sharpOk === false) continue;
    if (lo != null && v < lo) out.push(`${NAME[k] || k}：${v}（目標 ${lo}以上）→ ${HINT[k] || ""}`);
    else if (hi != null && v > hi) out.push(`${NAME[k] || k}：${v}（目標 ${hi}以下）→ ${HINT[k] || ""}`);
  }
  return out;
}
function targetsText(genre) {
  const t = T[genre] || T.day;
  return Object.entries(t).map(([k, [lo, hi]]) => `${NAME[k] || k} ${lo != null && hi != null ? `${lo}〜${hi}` : lo != null ? `${lo}以上` : `${hi}以下`}`).join("・");
}

const STANDARDS = `【レタッチの基準（分析結果。本人の今の仕上げより、伸びている写真家・広告雑誌・フォトコン入賞作に寄せる）】
共通（全投稿で固定＝統一感）：白飛び0%（画面の明るい方1%も真っ白にしない）／黒は締めるがつぶさない／彩度の上限0.35（夜のポートレートだけ0.45まで）／色温度はニュートラル〜わずかに暖（R−B 0〜+8）／シャドウは中立〜わずかに青、ハイライトだけ暖色／主役が画面でいちばん目を引く明るさ、背景や端に主役より明るい所を作らない／明るさで統一するのではなく「色・最大輝度・黒の締まり」で統一する。
夜（街・夜景）：平均Y 50〜65、黒つぶれ 3〜10%（本人は16%で多すぎ）、彩度 0.30〜0.40（本人は0.49で高すぎ）、ハイライトR−B +10〜+25、周辺光量−10〜−20、シャープさ lapVar 600以上（テクスチャ+10〜+20・シャープ40〜60）。
昼（街スナップ・旅）：平均Y 100〜125、黒つぶれ 0.5〜3%、彩度 0.25〜0.33、R−B 0〜+8（本人は+18で暖色すぎ→色温度を寒色側へ300〜500K）、テクスチャ+15〜+25、シャープ40〜60。
風景：黒点Y 18〜30（締めすぎない）、黒つぶれ0〜1%、彩度0.24〜0.34、テクスチャ+20〜+30、明瞭度+5〜+10、かすみの除去は空だけ+5〜+15、シャープ40〜50・マスク60〜80（空にかけない）。
建築（いちばんカリカリ）：彩度0.22〜0.28、わずかに寒色〜中立（R−B −5〜+1）、テクスチャ+25〜+40、明瞭度+10〜+20、かすみの除去+5〜+10、シャープ50〜70・半径0.7〜0.9・ディテール35〜50・マスク20〜40。ガイド付きUprightで垂直を出す。
ポートレート（広告・雑誌のトップレタッチャーの基準）：顔が画面でいちばん明るい肌（昼 L*62〜72＝頬58〜66%、夜 L*50〜60＝46〜56%、逆光 L*55〜65）。背景は顔より暗く（昼 −8以下・目標−12〜−22、夜 −20以下・目標−25〜−40。逆光だけは+12まで許すが無彩色で均一に）。手・腕は顔より暗く（−3〜−8。+3超はNG）。白飛び<0.1%。肌は色相18〜24°・彩度0.30〜0.42・R>G>B。直す順番：白飛び → 1チャンネル飛び → 手 → 背景 → 顔の明るさ → よそ見ポイント。
本人の今の傾向との差（直す方向）：夜の黒つぶれが多い／夜の彩度が高い／昼が暖色すぎ／シャープさが足りない／ポートレートは顔が暗く（L*47）、手が顔より明るい投稿が54%、白飛び0.5%超が30%、肌がわずかに赤寄り。`;

module.exports = { T, NAME, HINT, genreOf, check, targetsText, STANDARDS };
