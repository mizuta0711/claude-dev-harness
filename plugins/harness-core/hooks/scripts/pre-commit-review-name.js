/**
 * PreToolUse フック: **新しいレビュー記録の名前**をコミット前に確かめる（H110）。
 *
 * `docs/reviews/YYYYMMDD_HHMMSS_<種類>.md` の時刻を、AI が時計を見ずに作ることがある
 * （`120000` のようなきりのいい時刻）。**別のセッションが同じ日に同じ種類の査読をすると同じ名前になり、
 * `git pull` で add/add の衝突になる。** スキルには `date` の出力を使うと書いたが、
 * **「気をつける」で守れなかった種類**なので、コミットの時点でも知らせる。
 *
 * 知らせるのは次の 2 つ:
 *   - 秒が `00` の名前（作った時刻の形。実際の時刻でも 60 回に 1 回は当たる）
 *   - 取得済みの upstream に同じ名前がある（このまま進めると衝突する）
 *
 * **deny にしない。** 実際の時刻で秒が `00` になることはあり、判定は完全にならない。
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const lib = require("./harness-lib");
const { resolveTarget } = require("./pre-push-backlog-check");

const REVIEW_DIR = "docs/reviews/";

function git(args, cwd) {
  try {
    return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
  } catch {
    return "";
  }
}

const linesOf = (text) => text.split("\n").map((s) => s.trim()).filter(Boolean);

/** 名前の時刻が作った形か（純関数）。日時の付かない名前は対象にしない */
function looksInvented(file) {
  const m = path.posix.basename(file).match(/^\d{8}_(\d{6})_.+\.md$/);
  return Boolean(m) && m[1].endsWith("00");
}

/**
 * このコミットで増えるレビュー記録。
 * `git add X && git commit` はフックの時点でまだステージされていないので、
 * **コマンドに名前が出てくる未追跡のファイル**も含める（他セッションの未追跡は拾わない）。
 */
function newReviewFiles(cwd, command) {
  const staged = linesOf(git(["diff", "--cached", "--name-only", "--diff-filter=A", "--", REVIEW_DIR], cwd));
  const text = command.normalize("NFC");
  const named = linesOf(git(["ls-files", "--others", "--exclude-standard", "--", REVIEW_DIR], cwd)).filter((file) =>
    text.includes(path.posix.basename(file).normalize("NFC")),
  );
  return [...new Set([...staged, ...named])];
}

function main() {
  const payload = lib.readPayload();
  if (!payload) lib.passThrough();

  const command = lib.toolCommand(payload);
  if (!command || !lib.isGitCommit(command)) lib.passThrough();

  // `cd X && git commit` は X を見る（pre-commit-actuality と同じ解決）
  const target = resolveTarget(command, { shell: lib.toolShell(payload) }, payload.cwd || lib.projectDir(), "commit");
  const cwd = target && fs.existsSync(target.dir) ? target.dir : payload.cwd || lib.projectDir();

  const files = newReviewFiles(cwd, command);
  if (!files.length) lib.passThrough();

  const clashes = files.filter((file) => linesOf(git(["ls-tree", "--name-only", "@{upstream}", "--", file], cwd)).length > 0);
  const invented = files.filter((file) => looksInvented(file) && !clashes.includes(file));
  if (!clashes.length && !invented.length) lib.passThrough();

  const sections = [];
  if (clashes.length) {
    sections.push(
      "**upstream に同じ名前があります（`git pull` で衝突します）:**\n" + clashes.map((f) => `  - ${f}`).join("\n"),
    );
  }
  if (invented.length) {
    sections.push(
      "**名前の時刻の秒が `00` です（時計を見ずに作った時刻かもしれません）:**\n" + invented.map((f) => `  - ${f}`).join("\n"),
    );
  }
  lib.notify(
    "PreToolUse",
    "[review-name] **レビュー記録の名前を確認してください。**\n\n" +
      sections.join("\n\n") +
      "\n\n> `date +%Y%m%d_%H%M%S` の出力で名前を付け直し、設計書などからの参照も直してください。\n" +
      "> **これは警告です。** 実際の時刻で秒が `00` になったのなら、そのままで構いません。",
  );
}

if (require.main === module) main();

module.exports = { main, looksInvented, newReviewFiles };
