// make-score-captions.js — AIの点数を、クラウド版でも見えるよう Classic の星にするための一覧を作る（classic-scores.tsv）
//   Classic のプラグインがこの一覧を読んで星を付ける（9点=★5〜5点=★1。本人が付けた星は上書きしない）
//   点数は Fable の採点を優先し、まだの写真は前の採点を使う
//   node make-score-captions.js
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const P = path.join(__dirname, ".work", "lrpick");
const read = (f) => (fs.existsSync(path.join(P, f)) ? Object.values(JSON.parse(fs.readFileSync(path.join(P, f), "utf8"))) : []);
const score = new Map();
for (const j of read("judged.sonnet.json")) if (typeof j.score === "number") score.set(String(j.id), j.score);
for (const j of read("judged.json")) if (typeof j.score === "number") score.set(String(j.id), j.score);
const db = new DatabaseSync("C:/Lightroom/Lightroom Catalog.lrcat", { readOnly: true });
const uuid = new Map(db.prepare("select id_local, id_global from Adobe_images").all().map((r) => [String(r.id_local), r.id_global]));
const lines = [];
for (const [id, s] of score) if (uuid.has(id)) lines.push(`${uuid.get(id)}\t${Math.round(s * 10) / 10}`);
fs.writeFileSync(path.join(__dirname, "classic-scores.tsv"), lines.join("\n") + "\n");
console.log(`点数の一覧 ${lines.length}枚`);
