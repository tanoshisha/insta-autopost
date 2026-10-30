// 写真の「中身の似ている度合い」（CLIP。このPCの中で動く・外に送らない）
//   構図の形だけを見る dHash（dedupe.js）では分からない「同じ被写体を別の角度で撮った」ような似た写真を見分ける
const path = require("path");
const { execFileSync } = require("child_process");
const DIR = path.join(__dirname, "..", "ae", "depth");

function matrix(files) {
  return JSON.parse(execFileSync(process.execPath, ["clip.mjs", ...files.map((f) => path.resolve(f))], { cwd: DIR, encoding: "utf8", maxBuffer: 1 << 26, timeout: 20 * 60e3 }));
}
// items: [{ src, ... }] を並び順のまま見て、前の写真と th 以上似ている写真を外す。外した分は pool から似ていない写真で埋める
function diversify(items, pool = [], th = 0.93) {
  const all = [...items, ...pool];
  if (all.length < 2) return { items, removed: [] };
  const M = matrix(all.map((x) => x.src));
  const keep = [];
  const removed = [];
  for (let i = 0; i < items.length; i++) {
    if (keep.some((k) => M[i][k] >= th)) removed.push(items[i]);
    else keep.push(i);
  }
  for (let j = items.length; j < all.length && keep.length < items.length; j++) if (!keep.some((k) => M[j][k] >= th)) keep.push(j);
  return { items: keep.map((k) => all[k]), removed };
}
module.exports = { matrix, diversify };
