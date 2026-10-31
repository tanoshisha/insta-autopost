// レタッチの基準（2026-10-31〜11-01 の分析から。.work/retouch-study/report.md と .work/portrait-study/report.md の「先に結論」）
//   参考にしたもの：インスタで安定して伸びている写真家・広告/雑誌のプロの作法・フォトコン入賞作（SWPA/IPA/富士＝722枚、ポートレートは2,557枚）
//   本人の今の仕上げに合わせるのではなく、上手い人に寄せる（本人の指示）。数値の測り方は lib/photo-metrics.js
//   genre: night（街・夜景）/ day（街スナップ・旅）/ landscape / architecture / portrait（昼・夜・逆光は数値で自動判定）
//   2026-11-01 街系は「安定して伸び続けている写真家」43人（942枚）で見直し：フォトコン入賞作より彩度高め・暖色・ずっとシャープ・黒はつぶさない。インスタ側を優先（建築だけ安定アカウントが無いので入賞作寄り）

const T = {
  night: { meanY: [52, 70], p50: [42, 55], p02: [5, 10], crush: [1.5, 6], clip: [0, 0.1], clipAny: [0, 0.3], p98: [190, 210], sat: [0.38, 0.48], rb: [3, 14], shRb: [-4, 3], hiRb: [20, 40], lapVar: [1000, null], ringMinusCenter: [null, -5] },
  day: { meanY: [105, 130], p02: [18, 32], crush: [0, 1], clip: [0, 0.3], clipAny: [0, 0.5], p98: [215, 232], sat: [0.36, 0.48], rb: [8, 22], shRb: [5, 15], hiRb: [5, 15], lapVar: [1100, null] },
  landscape: { meanY: [105, 130], p02: [25, 36], crush: [0, 0.5], clip: [0, 0.1], clipAny: [0, 0.3], p98: [215, 230], sat: [0.36, 0.48], rb: [5, 20], shRb: [5, 15], lapVar: [1000, null] },
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

const STANDARDS = `【レタッチの基準（分析結果。インスタで安定して伸び続けている写真家43人＋ポートレート151人・広告雑誌・フォトコン入賞作。本人の今の仕上げより上手い人に寄せる）】
共通（全投稿で固定＝統一感）：白飛び0%／黒はつぶさない（夜の黒つぶれ2〜6%、昼0〜1%）／彩度は0.40〜0.45あたりで毎回そろえる（本人は投稿ごとのばらつきが大きすぎる）／ハイライトだけ暖色を全投稿共通に／シャープさを毎回同じに（かなりカリカリ）／主役が画面でいちばん目を引く明るさ・背景や端に主役より明るい所を作らない・ハローを出さない。
夜（街・夜景）：中間Y 42〜55（本人35で暗い）→露光+0.3〜+0.5かシャドウ+15〜25、黒レベル+15〜+25（つぶさない）、ハイライト−30〜−50、明瞭度+10〜15、テクスチャ+20〜30、シャープ60〜80・半径1.0・ディテール35〜50・マスク30〜50、輝度ノイズ低減0〜10、彩度0.38〜0.48（本人0.49→彩度−5〜−8）、カラーグレーディング ハイライト色相35〜45・彩度20〜30／シャドウ中立（色相220・彩度0〜5）、HSL青の輝度−10、周辺光量−10〜−15。
昼（街スナップ・旅）：露光+0.2〜+0.4、黒レベル+20〜+30、ハイライト−20〜−30、白レベル+5〜10、明瞭度+15〜20、テクスチャ+20〜30、シャープ60〜80、彩度0.36〜0.48（彩度+5〜10・自然な彩度+10〜15）、暖色寄り（R−B +8〜+22）でシャドウも少し暖色（色相40〜50・彩度10〜15）、ハイライトの暖色は控えめ（彩度5〜10）、緑−5〜−10。
風景：黒レベル+25〜+35（黒点を浮かせ気味）、彩度+5〜10・自然な彩度+15〜20、シャドウ暖色（色相45・彩度15）、テクスチャ+20〜30、明瞭度+15〜20、かすみの除去は空だけ+5〜15、シャープ50〜70・マスク60〜80（空にかけない）。
建築（いちばんカリカリ。伸びている建築専門アカウントが無いので入賞作寄り）：彩度0.22〜0.30、中立〜わずかに寒色、カラーグレーディング0、白壁を飛ばさない（ハイライト−40〜−60）、テクスチャ+30〜40、明瞭度+15〜25、シャープ70〜90・ディテール40〜55・マスク20〜30、ガイド付きUprightで垂直。
ポートレート（広告・雑誌のトップレタッチャーの基準）：顔が画面でいちばん明るい肌（昼 L*62〜72＝頬58〜66%、夜 L*50〜60＝46〜56%、逆光 L*55〜65）。背景は顔より暗く（昼 −8以下・目標−12〜−22、夜 −20以下・目標−25〜−40。逆光だけは+12まで許すが無彩色で均一に）。手・腕は顔より暗く（−3〜−8。+3超はNG）。白飛び<0.1%。肌は色相18〜24°・彩度0.30〜0.42・R>G>B。直す順番：白飛び → 1チャンネル飛び → 手 → 背景 → 顔の明るさ → よそ見ポイント。
本人の今の傾向との差（直す方向）：夜が暗く黒つぶれが多い（16%）／彩度が投稿ごとにばらつく／シャープさが伸びている人の1/3／昼のハイライトの暖色が強すぎ／ポートレートは顔が暗く（L*47）、手が顔より明るい投稿が54%、白飛び0.5%超が30%。`;

module.exports = { T, NAME, HINT, genreOf, check, targetsText, STANDARDS };
