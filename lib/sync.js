// GitHub上の最新状態に変更を重ねてコミット＆push する（PC・GitHub Actions・iPhoneアプリが同時に触っても壊れないように）。
// mutate(remote) は最新の queue.json などを remote(path, 既定値) で読んで、{ "path": 新しい中身 | null(削除) } を返す。
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function makeSync(root) {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return function syncCommit(message, newFiles, mutate) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      git(["fetch", "-q", "origin", "main"]);
      git(["reset", "-q", "--mixed", "origin/main"]);
      const remote = (p, d) => {
        try {
          return JSON.parse(git(["show", `origin/main:${p}`]));
        } catch {
          return d;
        }
      };
      const changes = mutate(remote);
      const add = [...newFiles];
      for (const [p, v] of Object.entries(changes)) {
        if (v === null) {
          fs.rmSync(path.join(root, p), { force: true });
          git(["rm", "-q", "--cached", "--ignore-unmatch", p]);
        } else {
          fs.writeFileSync(path.join(root, p), typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n");
          add.push(p);
        }
      }
      if (add.length) git(["add", "--", ...add]);
      // 他の端末で消された画像が手元に残っていたら掃除
      try {
        git(["clean", "-fq", "--", "queue", "specials"]);
      } catch {}
      if (!git(["diff", "--cached", "--name-only"]).trim()) return false;
      git(["commit", "-q", "-m", message]);
      try {
        git(["push", "-q", "origin", "HEAD:main"]);
        return true;
      } catch (e) {
        if (attempt === 4) throw e;
      }
    }
  };
}

// 撮影日時の順になる位置に差し込む（手で並べ替えた順番は崩さない）
function insertByDate(queue, item) {
  const key = (it) => it.takenAt || (it.date ? it.date + "T12:00:00.000Z" : "9999");
  const k = key(item);
  const i = queue.findIndex((q) => key(q) > k);
  if (i === -1) queue.push(item);
  else queue.splice(i, 0, item);
}

module.exports = { makeSync, insertByDate };
