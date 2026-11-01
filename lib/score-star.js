// AIの点数 → 星（9点=★5 / 8点=★4 / 7点=★3 / 6点=★2 / 5点=★1 / 4点以下=星なし）。本人「星でいいよ」2026-11-01
//   starOfId(id)：Classic の写真番号（.work/lrpick の名前）から星。Fable の採点を優先、まだなら前の採点
//   withRating(buf, star)：JPEG の中の XMP に xmp:Rating を書く（クラウド版 Lightroom が取り込み時に読む）
const fs = require("fs");
const path = require("path");
const P = path.join(__dirname, "..", ".work", "lrpick");
let cache = null;
function scores() {
  if (cache) return cache;
  cache = new Map();
  for (const f of ["judged.sonnet.json", "judged.json"]) {
    try {
      for (const j of Object.values(JSON.parse(fs.readFileSync(path.join(P, f), "utf8")))) if (typeof j.score === "number") cache.set(String(j.id), j.score);
    } catch {}
  }
  return cache;
}
const starOfScore = (s) => {
  if (typeof s !== "number") return null;
  s = Math.round(s);
  return s >= 9 ? 5 : s <= 4 ? null : s - 4;
};
const starOfId = (id) => starOfScore(scores().get(String(id)));

const NS = "http://ns.adobe.com/xap/1.0/\0";
function withRating(buf, star) {
  if (!star || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  // 既存の XMP（APP1）を探す
  let i = 2;
  while (i + 4 < buf.length && buf[i] === 0xff) {
    const m = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (m === 0xda) break; // 画像データの始まり
    if (m === 0xe1 && buf.toString("latin1", i + 4, i + 4 + NS.length) === NS) {
      let x = buf.toString("utf8", i + 4 + NS.length, i + 2 + len);
      if (/xmp:Rating="\d+"/.test(x)) x = x.replace(/xmp:Rating="\d+"/, `xmp:Rating="${star}"`);
      else if (/<xmp:Rating>\d+<\/xmp:Rating>/.test(x)) x = x.replace(/<xmp:Rating>\d+<\/xmp:Rating>/, `<xmp:Rating>${star}</xmp:Rating>`);
      else x = x.replace(/<rdf:Description\b/, `<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="${star}"`).replace(/(xmlns:xmp="[^"]*")([^>]*?)\s+xmlns:xmp="[^"]*"/, "$1$2");
      return Buffer.concat([buf.subarray(0, i), seg(x), buf.subarray(i + 2 + len)]);
    }
    i += 2 + len;
  }
  const x = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="${star}"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  return Buffer.concat([buf.subarray(0, 2), seg(x), buf.subarray(2)]);
}
function seg(x) {
  const body = Buffer.concat([Buffer.from(NS, "latin1"), Buffer.from(x, "utf8")]);
  const h = Buffer.alloc(4);
  h[0] = 0xff;
  h[1] = 0xe1;
  h.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([h, body]);
}
module.exports = { starOfId, starOfScore, withRating };
