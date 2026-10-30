// 投稿が終わって少し経った写真を、クラウド版 Lightroom の「消してOK」アルバムに入れる（本人がアプリで全部選択→削除する）
//   外部のプログラムはクラウドの写真を消せない（削除・フラグ・アルバムから外す は全部できない。2026-10-31 確認）ので、この形にした
//   入れるもの（投稿から DAYS 日たったもの）：
//     リール … この仕組みが上げた写真（本番・予備・候補。名前が「<リールのid>_」で始まる）。投稿日＝予約日（本人が Edits で投稿するため）
//     投稿   … 投稿した写真（クラウドの写真。Classic に同じ写真があり、元のファイルが PC にあるものだけ＝消しても元の写真は残る）
//   クラウドにしかない写真（iPhone から直接入れた写真など）は入れない
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const ROOT = path.join(__dirname, "..");
const IDS = path.join(ROOT, "lr-cloud-ids.json");
const STATE = path.join(ROOT, "cloud-trash.json");
const ALBUM = "消してOK";
const DAYS = 14;

async function trashOld({ configPath, specials, posted }) {
  const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { done: [], day: null };
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  if (st.day === today) return null; // 1日1回
  const cut = Date.now() - DAYS * 864e5;
  const ids = fs.existsSync(IDS) ? JSON.parse(fs.readFileSync(IDS, "utf8")) : {};
  const want = new Map(); // assetId → 理由
  // リール
  for (const x of specials.filter((s) => s.kind === "reel" && !s.skipped && Date.parse(s.postAt) < cut)) {
    for (const [name, id] of Object.entries(ids)) if (name.startsWith(`${x.id}_`)) want.set(id, `リール ${x.postAt.slice(0, 10)}`);
  }
  // 投稿（Classic と同期していて、元のファイルが PC にある写真だけ）
  const db = new DatabaseSync("C:/Lightroom/Lightroom Catalog.lrcat", { readOnly: true });
  const local = db.prepare(
    `select r.absolutePath || d.pathFromRoot || f.baseName || '.' || f.extension p from AgLibraryImageOzAssetIds o join Adobe_images i on o.image = i.id_local
     join AgLibraryFile f on i.rootFile = f.id_local join AgLibraryFolder d on f.folder = d.id_local join AgLibraryRootFolder r on d.rootFolder = r.id_local where o.ozAssetId = ?`
  );
  for (const p of posted.filter((p) => (!p.kind || p.kind === "post") && p.postedAt && Date.parse(p.postedAt) < cut)) {
    for (const id of [p.lrId, ...(p.parts || []).map((q) => q.lrId)].filter((v) => /^[0-9a-f]{32}$/.test(String(v)))) {
      const row = local.get(id);
      if (row && fs.existsSync(row.p)) want.set(id, `投稿 ${String(p.postedAt).slice(0, 10)}`);
    }
  }
  const add = [...want.keys()].filter((id) => !st.done.includes(id));
  let added = 0;
  if (add.length) {
    const { connect } = require("./lightroom");
    const lr = await connect(configPath);
    const albums = (await lr.get(`/v2/catalogs/${lr.catalogId}/albums?limit=500`)).resources || [];
    const al = albums.find((a) => a.subtype === "collection" && a.payload?.name === ALBUM);
    if (!al) throw new Error(`クラウドにアルバム「${ALBUM}」がありません`);
    const now = new Date().toISOString();
    for (let i = 0; i < add.length; i += 50) {
      const part = add.slice(i, i + 50);
      const r = await fetch(`https://lr.adobe.io/v2/catalogs/${lr.catalogId}/albums/${al.id}/assets`, {
        method: "PUT",
        headers: { ...lr.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ resources: part.map((id) => ({ id, payload: { userCreated: now, userUpdated: now } })) }),
      });
      // もう入っている写真が混ざると断られることがあるので、その時は1枚ずつ
      if (!r.ok) {
        for (const id of part) {
          const r1 = await fetch(`https://lr.adobe.io/v2/catalogs/${lr.catalogId}/albums/${al.id}/assets`, { method: "PUT", headers: { ...lr.headers, "Content-Type": "application/json" }, body: JSON.stringify({ resources: [{ id, payload: { userCreated: now, userUpdated: now } }] }) });
          if (r1.ok || r1.status === 403) st.done.push(id), added++;
        }
      } else st.done.push(...part), (added += part.length);
    }
  }
  st.day = today;
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  return { added, waiting: want.size };
}
module.exports = { trashOld, DAYS };
