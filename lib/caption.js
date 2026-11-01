// キャプションの組み立て（plan.js・enrich.js で共通）
//   [フォトウォークの冒頭文]
//   [タイトル（場所や被写体の短い名前。例「東京タワーと首都高」）]
//   [文章（自分で書いた時だけ）]
//   [いつものハッシュタグ ＋ 写真に合わせたタグ（最大3つ）]
function cleanTags(tags, base) {
  const have = new Set(String(base).split(/\s+/).filter(Boolean));
  const out = [];
  for (let t of tags || []) {
    t = String(t).trim().replace(/^#?/, "#").replace(/\s+/g, "");
    if (t.length < 2 || t.length > 25 || have.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= 3) break;
  }
  return out;
}
// タイトルは名詞だけの短い題名にそろえる（絵文字・句読点・かぎかっこを落とす）
function cleanTitle(t) {
  t = String(t || "")
    .replace(/[\p{Extended_Pictographic}️]/gu, "")
    .replace(/[。、！!？?「」『』]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length >= 2 && t.length <= 20 ? t : "";
}
function buildCaption({ head = "", title = "", line = "", base = "", extra = [] }) {
  const tags = [base, ...cleanTags(extra, base)].filter(Boolean).join(" ");
  return [head, cleanTitle(title), String(line || "").trim(), tags].filter(Boolean).join("\n\n");
}
// AIに頼むときの共通の指示
const CAPTION_RULES = `- title: 写真の題名（2〜15字・場所や被写体の名詞だけ。例「東京タワーと首都高」「雨上がりの渋谷」「江ノ電と夕焼け」）。感想・説明文・絵文字・「〜な一枚」「エモい」などは書かない。
- tags: 写真の内容に合うハッシュタグを0〜3個（例: #鎌倉 #夜景 #秋の風景）。場所が分かる時は地名を優先。いつも付ける #東京カメラ部 などとは重ねない。
- alt: 目の不自由な人向けの写真の説明（1文・40〜80字・見たままを具体的に）。`;
module.exports = { buildCaption, cleanTags, cleanTitle, CAPTION_RULES };
