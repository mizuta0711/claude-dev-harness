/**
 * PreToolUse フック: **常時読まれる指示に実態を書いていないか**をコミット前に知らせる（H23）。
 *
 * **これは H9 → H23 の再発を機械で捕まえる仕掛けである。**
 * 指示書 §3-5 は「この基準は**書き直す側**にも当てる」と**名指しで警告している**のに、
 * **「件数と日付を書かない」を判定基準にして 2,336行を削ったその同じ作業で**、
 * `.claude/rules/xaml-ui.md` へ「2026-08-16 の棚卸しで確認」と「0件」を書いていた
 * （CommSim・検出したのは査読で、自己点検では出ていない）。
 *
 * **書いている本人には「実態」に見えない** —— 日付と件数を**証拠**として書いており、
 * 実態のスナップショットを書いている自覚が無い。
 * **「気をつける」で守る対策は、書いた本人が次に破る**（H19 と同じ結論）。
 *
 * **deny にしない。** 完全な判定は無理で、正しく数を書く場面もある。
 * **黙らせないことが目的**である（H16 の教訓）。較正の経緯は `actuality-scan.js` にある。
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const lib = require("./harness-lib");
const scan = require("./actuality-scan");
const { resolveTarget } = require("./pre-push-backlog-check");

function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    });
  } catch {
    return "";
  }
}

/**
 * HEAD と作業ツリーで**変わった行**を、ファイルごとに集める。
 *
 * **`core.quotepath=false` を渡す。** 既定では非 ASCII のパスが引用符つきで出るため、
 * **日本語のルール名（`.claude/rules/日本語.md`）が素通りしていた**（査読 低）。
 */
function addedLinesByFile(cwd) {
  const diff = git(
    ["-c", "core.quotepath=false", "diff", "HEAD", "-U0", "--", "CLAUDE.md", "constitution.md", ".claude"],
    cwd
  );
  const byFile = new Map();
  let file = null;
  for (const raw of String(diff).replace(/\r\n/g, "\n").split("\n")) {
    const m = /^\+\+\+ (?:b\/)?(.+)$/.exec(raw);
    if (m) {
      const name = m[1].trim();
      file = name === "/dev/null" ? null : name;
      continue;
    }
    if (!file || !raw.startsWith("+") || raw.startsWith("+++")) continue;
    if (!scan.isWatchedPath(file)) continue;
    if (!byFile.has(file)) byFile.set(file, new Set());
    byFile.get(file).add(raw.slice(1).trim());
  }
  return byFile;
}

function main() {
  const payload = lib.readPayload();
  if (!payload) lib.passThrough();

  const command = lib.toolCommand(payload);
  if (!command || !lib.isGitCommit(command)) lib.passThrough();

  const { status, config } = lib.loadConfig();
  if (status === "ok" && config?.gates?.docActuality === "off") lib.passThrough();

  // **対象リポジトリを解決する。** `cd X && git commit` は実際の作法で（`CLAUDE.md` §7）、
  // セッションのディレクトリで差分を見ると**別リポジトリのコミットで鳴らず、
  // 自分側の未コミット差分に鳴る**（査読 中4）。判定は push 側と同じものを使う。
  const target = resolveTarget(command, { shell: lib.toolShell(payload) }, payload.cwd || lib.projectDir(), "commit");
  const cwd = target && fs.existsSync(target.dir) ? target.dir : payload.cwd || lib.projectDir();

  const byFile = addedLinesByFile(cwd);
  if (!byFile.size) lib.passThrough();

  // **ファイル全体を状態つきで検査し、追加行と突き合わせる。**
  // diff の行だけでは、**複数行の HTML コメントとコードフェンスの中身を外せない**（査読 中2）。
  const hits = [];
  for (const [file, added] of byFile) {
    let content;
    try {
      content = fs.readFileSync(path.join(cwd, file), "utf-8");
    } catch {
      continue; // 消されたファイル等
    }
    for (const h of scan.scanText(content)) {
      if (added.has(h.line.trim())) hits.push({ file, ...h });
    }
  }
  if (!hits.length) lib.passThrough();

  const byWhy = new Map();
  for (const h of hits) {
    for (const hit of h.hits) {
      if (!byWhy.has(hit.why)) byWhy.set(hit.why, { name: hit.name, lines: [] });
      byWhy.get(hit.why).lines.push(`${h.file}:${h.lineNo}  ${h.line.trim().slice(0, 90)}`);
    }
  }
  const detail = [...byWhy.entries()]
    .map(([why, v]) => `**${v.name}** — ${why}\n` + v.lines.map((l) => `  - ${l}`).join("\n"))
    .join("\n\n");

  lib.notify(
    "PreToolUse",
    "[actuality] **常時読まれる指示に実態を書いていないか確認してください。**\n\n" +
      detail +
      "\n\n> **実態は git とファイルシステムが持っています。** 方針だけ残してください" +
      "（判定基準は移行指示書 §3-5）。\n" +
      "> **記録として残したいなら `docs/` へ移してください**（`docs/reviews/` は件数を書くのが正しい場所です）。\n" +
      "> 常時読まれる指示の中で根拠として示すなら、**数えた範囲を併記**して引用（`>`）に入れます" +
      "（引用は検査の対象外ですが、**実態を常時側に残す方向なので最後の手段です**）。\n" +
      "> **これは警告です。** 正しく数を書く場面もあります（改訂履歴・条件や方針の言い方）。\n" +
      "> 止めたい場合は `harness.config.json` に `gates.docActuality: \"off\"` を設定してください。"
  );
}

if (require.main === module) main();

module.exports = { main, addedLinesByFile };
