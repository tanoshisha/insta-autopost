// ig-posted-fetch.js — インスタに載せた写真を全部保存する（レタッチし直す時に、トリミングをインスタと全く同じにするため）
//   node ig-posted-fetch.js → .work/igposted/<mediaId>.jpg と list.json（投稿日・何枚目か）
const fs = require("fs");
const path = require("path");
const s = require("./secrets.local.json");
const G = "https://graph.facebook.com/v21.0";
const OUT = path.join(__dirname, ".work", "igposted");

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let url = `${G}/${s.igUserId}/media?fields=id,media_type,media_url,timestamp,permalink,children{id,media_type,media_url}&limit=100&access_token=${s.igToken}`;
  const list = [];
  while (url) {
    const r = await (await fetch(url)).json();
    if (r.error) throw new Error(r.error.message);
    for (const m of r.data) {
      const kids = m.media_type === "CAROUSEL_ALBUM" ? m.children?.data || [] : [m];
      kids.forEach((c, i) => {
        if (c.media_type === "IMAGE" && c.media_url) list.push({ id: c.id, post: m.id, n: i + 1, at: m.timestamp, link: m.permalink, url: c.media_url });
      });
    }
    url = r.paging?.next;
  }
  let got = 0;
  for (const x of list) {
    const f = path.join(OUT, `${x.id}.jpg`);
    if (!fs.existsSync(f)) {
      const res = await fetch(x.url);
      if (!res.ok) continue;
      fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
      got++;
    }
    delete x.url;
  }
  fs.writeFileSync(path.join(OUT, "list.json"), JSON.stringify(list, null, 1));
  console.log(`インスタの写真 ${list.length}枚（新しく保存 ${got}枚）`);
})();
