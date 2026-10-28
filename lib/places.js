// 位置情報：撮影日→フォトウォーク開催回、GPS→地名、地名→インスタの位置ID（Facebookの場所ページ）。
// 調べた結果は places.json にキャッシュ。手で "地名": "ページID" を書き足せば確実にそれが使われる。
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PLACES = path.join(ROOT, "places.json");
const GRAPH = "https://graph.facebook.com/v23.0";

function loadPlaces() {
  try {
    return JSON.parse(fs.readFileSync(PLACES, "utf8"));
  } catch {
    return { locationIds: {}, notFound: [] };
  }
}
function savePlaces(p) {
  fs.writeFileSync(PLACES, JSON.stringify(p, null, 2) + "\n");
}

// ---- フォトウォーク開催回（vol は日付順） ----
function loadEvents(dir) {
  if (!fs.existsSync(dir)) return [];
  const evs = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .sort((a, b) => a.date.localeCompare(b.date));
  evs.forEach((e, i) => (e.vol = i + 1));
  return evs;
}

// 撮影日時を YYYY-MM-DD に。カメラの時刻は現地時刻なので、文字列は先頭の日付をそのまま使う
// （Date は exifr がPCの時刻=日本時間で作るのでローカル日付で読む）
function jstDate(takenAt) {
  if (!takenAt) return null;
  if (typeof takenAt === "string" && /^\d{4}-\d{2}-\d{2}/.test(takenAt)) return takenAt.slice(0, 10);
  const d = new Date(takenAt);
  if (isNaN(d)) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 開催場所の文字列から検索用の地名を1つ取り出す（「東京駅・丸の内」→「東京駅」）
function eventPlaceName(e) {
  if (e.ig_location) return e.ig_location;
  return String(e.place || e.title).replace(/（.*?）|\(.*?\)/g, "").split(/[・〜~、]/)[0].trim();
}

// ---- GPS → 地名（OpenStreetMap） ----
async function reverseGeocode({ lat, lng }) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=16&accept-language=ja`;
  const r = await fetch(url, { headers: { "User-Agent": "insta-autopost (personal use)" } });
  if (!r.ok) return null;
  const j = await r.json();
  const a = j.address || {};
  // 観光地・公園・寺社などのスポット名 → 地区名（渋谷・下北沢など） → 区市町村 の順で使う
  const spot = j.name && ["tourism", "historic", "leisure", "amenity"].includes(j.category) ? j.name : null;
  const name = spot || a.quarter || a.suburb || a.neighbourhood || a.city_district || a.city || a.town || null;
  // 地図上の正式名と普段の呼び名が違う所は places.json の aliases で置き換え（例: 北沢→下北沢）
  return (name && loadPlaces().aliases?.[name]) || name;
}

// ---- 地名 → インスタの位置ID ----
async function findLocationId(name, igToken) {
  const places = loadPlaces();
  if (places.locationIds[name]) return places.locationIds[name];
  if (!igToken || places.notFound.includes(name)) return null;
  try {
    const url = `${GRAPH}/pages/search?q=${encodeURIComponent(name)}&fields=id,name,location&access_token=${igToken}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) {
      console.log(`  （位置IDの検索はMetaに許可されていません: ${j.error.message.slice(0, 80)}）`);
      return null;
    }
    const hit = (j.data || []).find((p) => p.location && (p.location.country === "Japan" || p.location.latitude));
    if (hit) {
      places.locationIds[name] = hit.id;
      savePlaces(places);
      return hit.id;
    }
    places.notFound.push(name);
    savePlaces(places);
  } catch (e) {
    console.log(`  位置ID検索エラー: ${e.message}`);
  }
  return null;
}

module.exports = { loadEvents, jstDate, eventPlaceName, reverseGeocode, findLocationId };
