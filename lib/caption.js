// キャプションの組み立て（plan.js・enrich.js で共通）
//   [フォトウォークの冒頭文]
//   [AIの一言]
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
function buildCaption({ head = "", line = "", base = "", extra = [] }) {
  const tags = [base, ...cleanTags(extra, base)].filter(Boolean).join(" ");
  return [head, String(line || "").trim(), tags].filter(Boolean).join("\n\n");
}
// AIに頼むときの共通の指示
const CAPTION_RULES = `- line: 投稿に添える一言（15〜40字）。写真の空気感・季節・場所が伝わる、押しつけない自然な日本語。説明しすぎない。絵文字は使っても1つまで。人物の名前は書かない。
- tags: 写真の内容に合うハッシュタグを0〜3個（例: #鎌倉 #夜景 #秋の風景）。場所が分かる時は地名を優先。いつも付ける #東京カメラ部 などとは重ねない。
- alt: 目の不自由な人向けの写真の説明（1文・40〜80字・見たままを具体的に）。`;
module.exports = { buildCaption, cleanTags, CAPTION_RULES };
