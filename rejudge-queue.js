// rejudge-queue.js — 予約中の投稿を「100点満点」の基準で採点し直す（基準に届かない投稿は「見送り」へ。アプリの見送りタブから戻せる）
//   node rejudge-queue.js --dry  … 採点だけ（何も変えない）
//   node rejudge-queue.js        … 採点して、95点未満を見送りへ（GitHub に送る）
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFileSync } = require("child_process");
const sharp = require("sharp");
const { makeSync } = require("./lib/sync");
const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const MIN = cfg.minPerfect ?? 95;
const DRY = process.argv.includes("--dry");
const CL = path.join(process.env.USERPROFILE || "", ".local", "bin", "claude.exe");
const OUT = path.join(ROOT, ".work", "rejudge-queue.json");
const remote = (p, d) => {
  try {
    return JSON.parse(execFileSync("git", ["show", `origin/main:${p}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 }));
  } catch {
    return d;
  }
};

function ask(dir, names) {
  const prompt = `あなたは写真家のInstagramアカウントの編集者で、大きな写真コンテストの審査員も務めるプロです。カレントフォルダの次の写真を Read ツールで全部見てください（投稿用に4:5に切り抜いた画像）。
${names.map((n) => `- ${n}`).join("\n")}

この写真家は「100点満点の写真しか載せたくない」と決めました。それぞれの写真を0〜100点で採点してください。
100=直す所が1つもなく、このアカウントの代表作として一番上に固定できる1枚 / 95=ほぼ完璧で、プロの写真家が見ても文句がない / 90=とても良いが、構図・光・瞬間・技術・色のどこかに小さな弱さがある / 80以下=良い写真だが代表作ではない。
少しでも「惜しい」「もう少し○○なら」と思う所があれば95未満。迷ったら低い方。ポートレートは表情（目・口元・自然さ）を最優先で厳しく。
同じ場面・似た構図の写真が複数あれば、一番良い1枚以外は95未満にする。
出力は次のJSONだけ：{"photos":[{"file":"1.jpg","perfect":90,"note":"一言（足りない所）"}]}`;
  return new Promise((ok) => {
    const p = spawn(fs.existsSync(CL) ? CL : "claude", ["-p", "--allowedTools", "Read", "--output-format", "json", "--model", cfg.selectModel || "opus"], { cwd: dir });
    let out = "";
    const t = setTimeout(() => p.kill(), 15 * 60e3);
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => {
      clearTimeout(t);
      try {
        ok(JSON.parse((JSON.parse(out).result || "").match(/\{[\s\S]*\}/)[0]).photos || []);
      } catch {
        ok([]);
      }
    });
    p.stdin.end(prompt);
  });
}

(async () => {
  execFileSync("git", ["fetch", "-q", "origin", "main"], { cwd: ROOT });
  const q = remote("queue.json", []);
  const done = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
  const todo = q.filter((x) => done[x.id] == null);
  // 撮影日の順に（同じ場面の写真が同じ回に入るように）6枚ずつ
  todo.sort((a, b) => String(a.takenAt || a.date).localeCompare(String(b.takenAt || b.date)));
  for (let i = 0; i < todo.length; i += 6) {
    const part = todo.slice(i, i + 6);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rq-"));
    try {
      const names = [];
      for (const [k, x] of part.entries()) {
        const n = `${k + 1}.jpg`;
        fs.writeFileSync(path.join(dir, n), await sharp(execFileSync("git", ["show", `origin/main:${x.image}`], { cwd: ROOT, maxBuffer: 1 << 28 })).resize(1080, 1350, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer());
        names.push(n);
      }
      for (const r of await ask(dir, names)) {
        const k = names.indexOf(String(r.file).trim());
        if (k >= 0 && Number.isFinite(Number(r.perfect))) done[part[k].id] = { perfect: Number(r.perfect), note: r.note || "" };
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.writeFileSync(OUT, JSON.stringify(done, null, 1));
    console.log(`${Math.min(i + 6, todo.length)}/${todo.length}枚…`);
  }
  const pass = q.filter((x) => done[x.id]?.perfect >= MIN);
  const fail = q.filter((x) => done[x.id] && done[x.id].perfect < MIN);
  for (const x of q) console.log(`${done[x.id]?.perfect >= MIN ? "✓" : "✗"} ${x.id} [${done[x.id]?.perfect ?? "?"}/100] ${done[x.id]?.note || ""}`);
  console.log(`\n予約 ${q.length}件 → 残す ${pass.length}件・見送りへ ${fail.length}件（採点できなかった ${q.length - pass.length - fail.length}件はそのまま）`);
  if (DRY) return;
  makeSync(ROOT)(`予約を100点満点の基準で選び直し：残す${pass.length} / 見送り${fail.length}`, [], (rm) => {
    let qq = rm("queue.json", []);
    const pool = rm("pool.json", []);
    for (const x of qq.filter((y) => done[y.id] && done[y.id].perfect < MIN)) {
      pool.push({ ...x, perfect: done[x.id].perfect, reason: `[${done[x.id].perfect}/100] ${done[x.id].note}`, rejectedBy: "ai" });
    }
    qq = qq.filter((y) => !(done[y.id] && done[y.id].perfect < MIN)).map((y) => (done[y.id] ? { ...y, perfect: done[y.id].perfect } : y));
    return { "queue.json": qq, "pool.json": pool };
  });
  console.log("✅ 反映しました");
})();
