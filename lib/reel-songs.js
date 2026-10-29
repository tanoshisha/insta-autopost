// リールの曲の候補（本人がインスタでよく使う・保存している曲から）
//   bpm はおおよその目安（null は未計測）。アプリの「テンポを測る」で測った値は config.json の reelBpm に入り、こちらより優先される
//   uses = インスタでその曲を使ったリールの数（多いほど「曲のページ」から見てもらいやすい）
//   mood: night=夜の街・ネオン / day=昼の街・晴れ / emo=エモい・夕暮れ / chill=静か / halloween=ハロウィン / xmas=クリスマス
const SONGS = [
  { t: "プラスティック・ラブ", a: "竹内まりや", bpm: 104, uses: 7080, mood: ["night", "emo"] },
  { t: "Just the Two of Us", a: "Grover Washington, Jr.", bpm: 96, uses: 310000, mood: ["night", "chill"] },
  { t: "i like the way you kiss me", a: "Artemas", bpm: 151, uses: 1330000, mood: ["night"] },
  { t: "ヴァーチャル・インサニティ", a: "JAMIROQUAI", bpm: 92, uses: 32000, mood: ["night", "day"] },
  { t: "Isn't She Lovely", a: "Stevie Wonder", bpm: 119, uses: 670000, mood: ["day"] },
  { t: "Time After Time", a: "Cyndi Lauper", bpm: 130, uses: 100000, mood: ["emo"] },
  { t: "都会", a: "大貫妙子", bpm: null, uses: 5206, mood: ["night", "emo"] },
  { t: "東京は夜の七時", a: "ピチカート・ファイヴ", bpm: null, uses: 951, mood: ["night"] },
  { t: "中央フリーウェイ", a: "荒井由実", bpm: null, uses: 2790, mood: ["night", "emo"] },
  { t: "Tokyo Reggie", a: "Masayoshi Takanaka", bpm: null, uses: 5481, mood: ["day"] },
  { t: "君に、胸キュン。-浮気なヴァカンス-", a: "YELLOW MAGIC ORCHESTRA", bpm: null, uses: 3700, mood: ["day"] },
  { t: "ルージュの伝言", a: "荒井由実", bpm: null, uses: 31000, mood: ["day"] },
  { t: "Voice of Autumn", a: "Nujabes", bpm: null, uses: 4852, mood: ["chill", "emo"] },
  { t: "Zen", a: "Joe Palmer", bpm: null, uses: 81000, mood: ["chill"] },
  { t: "金木犀の夜", a: "きのこ帝国", bpm: null, uses: 2697, mood: ["night", "emo"] },
  { t: "今宵の月のように", a: "エレファントカシマシ", bpm: null, uses: 7118, mood: ["night", "emo"] },
  { t: "若者のすべて", a: "フジファブリック", bpm: null, uses: 18000, mood: ["emo"] },
  { t: "恋人も濡れる街角", a: "中村雅俊", bpm: null, uses: 970, mood: ["night"] },
  { t: "Got My Mind Set on You", a: "George Harrison", bpm: null, uses: 13000, mood: ["day"] },
  { t: "月の光（ドビュッシー）", a: "フジ子・ヘミング", bpm: null, uses: 16000, mood: ["chill"] },
  { t: "hibari", a: "坂本龍一", bpm: null, uses: 10000, mood: ["chill"] },
  { t: "Halloween Waltz", a: "Moon blues", bpm: null, uses: 760000, mood: ["halloween"] },
];

// 写真の雰囲気から曲を3つ選ぶ：①流行っている曲（曲ページから見てもらえる）②雰囲気にいちばん合う曲 ③本人らしい曲
function pickSongs({ moods = ["night"], measured = {} } = {}) {
  const withBpm = SONGS.map((s) => ({ ...s, bpm: measured[s.t] || s.bpm }));
  const fit = withBpm.filter((s) => s.mood.some((m) => moods.includes(m)));
  const pool = fit.length >= 3 ? fit : withBpm;
  const main = pool.filter((s) => s.mood.includes(moods[0])); // いちばんの雰囲気（ハロウィンなど）に合う曲を優先
  const trend = [...(main.length ? main : pool)].sort((a, b) => b.uses - a.uses)[0];
  const rest = pool.filter((s) => s !== trend);
  const timed = rest.filter((s) => s.bpm).sort((a, b) => b.uses - a.uses);
  const pick = [trend, timed[0] || rest[0], rest.filter((s) => s !== timed[0]).sort((a, b) => a.uses - b.uses)[0]].filter(Boolean);
  return [...new Map(pick.map((s) => [s.t, s])).values()].map((s, i) => ({ t: s.t, a: s.a, bpm: s.bpm, why: ["流行っている曲", "雰囲気に合う", "この写真家らしい"][i] }));
}

// 写真の日付・時間・内容から雰囲気を決める
function moodsFor({ date, takenAt, title }) {
  const md = date ? date.slice(5) : "";
  if (md >= "10-15" && md <= "10-31") return ["halloween", "night"];
  if (md >= "12-01" && md <= "12-25") return ["xmas", "night"];
  const h = takenAt ? new Date(Date.parse(takenAt) + 9 * 3600e3).getUTCHours() : 20;
  if (h >= 17 || h < 5) return ["night", "emo"];
  return /水族館|神社|公園/.test(title || "") ? ["chill", "day"] : ["day"];
}

module.exports = { SONGS, pickSongs, moodsFor };
