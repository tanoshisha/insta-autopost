// リールのキャプション（本人のふだんの書き方：短い題名＋ひとこと）
//   伸びている写真リール約1,300件の分析より：短い題名・本当のことを一言・お願いはしない・📍あり・タグ5個（英語1つ）
//   ひとこと：本人のメモがあればそのまま。なければ撮影の事実（いつ・レンズ）だけ。気持ちは作らない
const EN = { 鎌倉: "#kamakura", 横浜: "#yokohama", 東京タワー: "#tokyotower", 表参道: "#omotesando", 原宿: "#harajuku", 渋谷: "#shibuya", 新宿: "#shinjuku", 浅草: "#asakusa", 銀座: "#ginza", 丸の内: "#marunouchi", 下北沢: "#shimokitazawa", 高円寺: "#koenji", 明治神宮: "#meijijingu", 秋葉原: "#akihabara", 東京駅: "#tokyostation" };

function season(m) {
  return m === 12 || m <= 2 ? "冬" : m <= 5 ? "春" : m <= 8 ? "夏" : "秋";
}
// 撮った時期（投稿日から見て）
function when(shotDay, postDay) {
  if (!shotDay) return "";
  const [y, m, d] = shotDay.split("-").map(Number);
  const [py, pm] = postDay.split("-").map(Number);
  const months = (py - y) * 12 + (pm - m);
  if (m === 1 && d === 1) return py === y ? "元日" : py - y === 1 ? "去年の元日" : `${py - y}年前の元日`;
  if (months <= 1) return "";
  if (py === y) return `${m}月`;
  if (py - y === 1) return `去年の${season(m)}`;
  return `${py - y}年前の${season(m)}`;
}
// レンズ（ほぼ同じ焦点距離ならそれを言う）
function lens(shots) {
  const fl = (shots || []).filter(Boolean).map((s) => parseInt(s));
  if (fl.length < 3) return "";
  const c = {};
  for (const f of fl) c[f] = (c[f] || 0) + 1;
  const [top, n] = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  if (n === fl.length) return `全部${top}mm`;
  if (n / fl.length >= 0.6) return `ほぼ${top}mm`;
  if (fl.filter((f) => f >= 150).length / fl.length >= 0.6) return "ほぼ望遠";
  return "";
}
// 題名・事実・場所・タグ（アプリでメモを入れると、事実の代わりにメモが入る）
function capParts({ title, place, shots, shotDay, postDay, tags = [], dark }) {
  const w = when(shotDay, postDay);
  const l = lens(shots);
  const fact = w && l ? `${w}、${l}で撮影` : w ? `${w}に撮った写真` : l ? `${l}で撮影` : "";
  const en = (place && Object.entries(EN).find(([k]) => place.includes(k))?.[1]) || (dark ? "#tokyonight" : "#tokyosnap");
  const t = [...new Set([place ? `#${place.replace(/[\s・]/g, "")}` : null, ...tags, en, "#東京カメラ部"].filter(Boolean))].slice(0, 5);
  if (!t.includes("#東京カメラ部")) t[t.length - 1] = "#東京カメラ部";
  return { title: title || place || "", fact, place: place || "", tags: t };
}
function compose(c, memo = "") {
  const head = [c.title, memo || c.fact].filter(Boolean).join("\n");
  return [head, c.place ? `📍${c.place}` : "", (c.tags || []).join(" ")].filter(Boolean).join("\n\n");
}
module.exports = { capParts, compose, when, lens };
