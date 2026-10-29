// リールの曲の候補（本人がインスタでよく使う・保存している曲から）
//   bpm はおおよその目安（null は未計測）。アプリの「テンポを測る」で測った値は config.json の reelBpm に入り、こちらより優先される
//   uses = インスタでその曲を使ったリールの数（多いほど「曲のページ」から見てもらいやすい）
//   mood: night=夜の街・ネオン / day=昼の街・晴れ / emo=エモい・夕暮れ / chill=静か / halloween=ハロウィン / xmas=クリスマス
const SONGS = [
  // ── 本人のお気に入り（fav）：2026-10-30 に本人が挙げた曲・アーティストと、Spotify のプレイリスト「にょん」から（アニソン・アイドルは除く）
  { t: "Just the Two of Us", a: "Grover Washington, Jr.", bpm: 96, uses: 310000, mood: ["night", "chill"], fav: true },
  { t: "都会", a: "大貫妙子", bpm: null, uses: 5206, mood: ["night", "emo"], fav: true },
  { t: "冥想", a: "尾崎亜美", bpm: null, uses: 49, mood: ["night", "emo", "chill"], fav: true },
  { t: "MELODY", a: "Fishmans（アルバム『ORANGE』）", bpm: null, uses: 0, mood: ["emo", "chill", "day"], fav: true },
  { t: "I Love Music", a: "ALO", bpm: null, uses: 0, mood: ["day", "night"], fav: true },
  { t: "いかれたBaby", a: "Fishmans", bpm: null, uses: 731, mood: ["emo", "chill"], fav: true },
  { t: "Say It Ain't So", a: "Weezer", bpm: 76, uses: 7258, mood: ["emo", "night"], fav: true },
  { t: "Buddy Holly", a: "Weezer", bpm: 121, uses: 9489, mood: ["day"], fav: true },
  { t: "Hey", a: "Pixies", bpm: null, uses: 6542, mood: ["night", "emo"], fav: true },
  { t: "Where Is My Mind?", a: "Pixies", bpm: 80, uses: 0, mood: ["night", "emo"], fav: true },
  { t: "Nomatterday", a: "Pixies", bpm: null, uses: 57, mood: ["night"], fav: true },
  { t: "LOVEずっきゅん", a: "相対性理論", bpm: null, uses: 1073, mood: ["day", "emo"], fav: true },
  { t: "真夜中のドア〜stay with me", a: "松原みき", bpm: null, uses: 0, mood: ["night", "emo"], fav: true },
  { t: "TOKYO SUNSET", a: "サニーデイ・サービス", bpm: null, uses: 0, mood: ["emo", "day"], fav: true },
  { t: "SUMMER SUSPICION", a: "杉山清貴&オメガトライブ", bpm: null, uses: 0, mood: ["night", "day"], fav: true },
  { t: "Englishman In New York", a: "Sting", bpm: 102, uses: 0, mood: ["night", "chill"], fav: true },
  { t: "Feather", a: "Nujabes", bpm: null, uses: 0, mood: ["chill", "emo"], fav: true },
  { t: "私の好きなもの", a: "Lovely Summer Chan", bpm: null, uses: 0, mood: ["day", "emo"], fav: true },
  { t: "透明少女", a: "NUMBER GIRL", bpm: null, uses: 0, mood: ["day", "emo"], fav: true },
  { t: "マリブコーク", a: "踊ってばかりの国", bpm: null, uses: 0, mood: ["chill", "emo"], fav: true },
  { t: "Mirror Balls", a: "菊地成孔DCPRG", bpm: null, uses: 37, mood: ["night"], fav: true },
  { t: "Got to Be Real", a: "Cheryl Lynn", bpm: 117, uses: 0, mood: ["night", "day"], fav: true },
  { t: "Rich Girl", a: "Daryl Hall & John Oates", bpm: null, uses: 0, mood: ["day"], fav: true },
  { t: "My Girl", a: "Kan Sano", bpm: null, uses: 0, mood: ["night", "chill"], fav: true },
  { t: "お別れの歌", a: "never young beach", bpm: null, uses: 0, mood: ["emo", "day"], fav: true },
  // ── インスタで保存・おすすめに出ていた曲
  { t: "プラスティック・ラブ", a: "竹内まりや", bpm: 104, uses: 7080, mood: ["night", "emo"] },
  { t: "i like the way you kiss me", a: "Artemas", bpm: 151, uses: 1330000, mood: ["night"] },
  { t: "ヴァーチャル・インサニティ", a: "JAMIROQUAI", bpm: 92, uses: 32000, mood: ["night", "day"] },
  { t: "Isn't She Lovely", a: "Stevie Wonder", bpm: 119, uses: 670000, mood: ["day"] },
  { t: "Time After Time", a: "Cyndi Lauper", bpm: 130, uses: 100000, mood: ["emo"] },
  { t: "東京は夜の七時", a: "ピチカート・ファイヴ", bpm: null, uses: 951, mood: ["night"] },
  { t: "中央フリーウェイ", a: "荒井由実", bpm: null, uses: 2790, mood: ["night", "emo"] },
  { t: "Tokyo Reggie", a: "Masayoshi Takanaka", bpm: null, uses: 5481, mood: ["day"] },
  { t: "Voice of Autumn", a: "Nujabes", bpm: null, uses: 4852, mood: ["chill", "emo"] },
  { t: "金木犀の夜", a: "きのこ帝国", bpm: null, uses: 2697, mood: ["night", "emo"] },
  { t: "Personal", a: "The Party Hits All Stars", bpm: null, uses: 0, mood: ["day", "night"] },
  { t: "Halloween Waltz", a: "Moon blues", bpm: null, uses: 760000, mood: ["halloween"] },
];

// 写真の雰囲気から曲を3つ選ぶ：①流行っている曲（曲ページから見てもらえる）②雰囲気にいちばん合う曲 ③本人らしい曲
function pickSongs({ moods = ["night"], measured = {} } = {}) {
  const withBpm = SONGS.map((s) => ({ ...s, bpm: measured[s.t] || s.bpm }));
  const fit = withBpm.filter((s) => s.mood.some((m) => moods.includes(m)));
  const pool = fit.length >= 3 ? fit : withBpm;
  const main = pool.filter((s) => s.mood.includes(moods[0]));
  const trend = [...(main.length ? main : pool)].sort((a, b) => b.uses - a.uses)[0];
  // お気に入りは、毎回ちがう曲が出るように日付で回す
  const favs = pool.filter((s) => s.fav && s !== trend);
  const r = Math.floor(Date.now() / 864e5);
  const f1 = favs.filter((s) => s.mood[0] === moods[0])[r % Math.max(1, favs.filter((s) => s.mood[0] === moods[0]).length)] || favs[r % Math.max(1, favs.length)];
  const f2 = favs.filter((s) => s !== f1)[(r * 7) % Math.max(1, favs.length - 1)];
  const pick = [trend, f1, f2].filter(Boolean);
  return [...new Map(pick.map((s) => [s.t, s])).values()].map((s, i) => ({ t: s.t, a: s.a, bpm: s.bpm, why: ["流行っている曲", "お気に入り・雰囲気に合う", "お気に入り"][i] }));
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
