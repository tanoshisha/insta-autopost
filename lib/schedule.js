// 投稿ペースの設定（schedule.json）を読む。iPhoneアプリの予定表示でも同じ考え方を使う。
//   { "times": ["12:30", "20:00"],                       … ふだんの投稿時刻（1日の回数 = 個数）
//     "periods": [{ "from": "2026-11-01", "to": "2026-11-15", "times": ["08:00","12:30","20:00"] },
//                 { "from": "2026-12-29", "to": "2027-01-03", "times": [] }] }   … 期間指定（空=お休み）
const DEFAULT = { times: ["12:30", "20:00"], periods: [] };

function timesFor(day, sched) {
  const s = sched || DEFAULT;
  let times = s.times || DEFAULT.times;
  for (const p of s.periods || []) if (p.from <= day && day <= p.to) times = p.times || [];
  return [...times].sort();
}

const toMin = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

// 日本時間の今日（YYYY-MM-DD）と今の時刻（分）
function nowJst() {
  const d = new Date(Date.now() + 9 * 3600e3);
  return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

module.exports = { DEFAULT, timesFor, toMin, nowJst };
