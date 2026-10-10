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
 * **deny にしない。** 完全な判定は無理で、正しく数を書く場面もある
 * （改訂履歴・数えた範囲を併記した実測）。**黙らせないことが目的**である（H16 の教訓）。
 * 判定の較正の経緯は `actuality-scan.js` のコメントにある。
 */
const lib = require("./harness-lib");
const scan = require("./actuality-scan");
const { execFileSync } = require("node:child_process");

/** HEAD と作業ツリーの差分。`git commit -- <path>` はステージしないので HEAD と比べる */
function diffAgainstHead(cwd) {
  try {
    return execFileSync(
      "git",
      ["diff", "HEAD", "-U0", "--", "CLAUDE.md", "constitution.md", ".claude"],
      { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }
    );
  } catch {
    return "";
  }
}

function main() {
  const payload = lib.readPayload();
  if (!payload) lib.passThrough();

  const command = lib.toolCommand(payload);
  if (!command || !lib.isGitCommit(command)) lib.passThrough();

  const { status, config } = lib.loadConfig();
  if (status === "ok" && config?.gates?.docActuality === "off") lib.passThrough();

  const cwd = payload.cwd || lib.projectDir();
  const hits = scan.scanDiff(diffAgainstHead(cwd));
  if (!hits.length) lib.passThrough();

  // 同じ理由をまとめて1回だけ出す（同じ指摘を何度も読ませない）
  const byWhy = new Map();
  for (const h of hits) {
    for (const hit of h.hits) {
      if (!byWhy.has(hit.why)) byWhy.set(hit.why, { name: hit.name, lines: [] });
      byWhy.get(hit.why).lines.push(`${h.file}: ${h.line.slice(0, 90)}`);
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
      "> **実測を根拠として示したいなら、引用（`>`）に入れてください。** 引用は検査の対象外です。\n" +
      "> **これは警告です。** 正しく数を書く場面もあります（改訂履歴・数えた範囲を併記した実測）。\n" +
      "> 止めたい場合は `harness.config.json` に `gates.docActuality: \"off\"` を設定してください。"
  );
}

if (require.main === module) main();

module.exports = { main, diffAgainstHead };
