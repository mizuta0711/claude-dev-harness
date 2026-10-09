/**
 * PreToolUse フック: push の前に**残作業台帳と機能設計書の整合**を確かめる（H63）。
 *
 * **なぜフックなのか。** 同じ検査をスキルの Step として置く案を捨てた。
 * `pre-push-check` は**規律としては既にある**（`core.md:83`「push の直前に通す」）のに
 * **守られていない** —— `usage-audit/SKILL.md` に「**`pre-push-check` の無い push**」という
 * 監査項目があるのが、その前提で作られている証拠である。
 * **手順書に足すだけでは、読む人の注意力に依存する**（H19 / H23 と同じ結論）。
 *
 * **`pre-push-check` と見ているものが違う。** あれは `designDocs.ledger`
 * （`docs/設計書/.doc-sync.md` ＝ **設計書同期台帳**）を見る。こちらは
 * `docs/backlog.md`（**残作業台帳**）で、**誰も検査していなかった**。
 * 「台帳」の呼び分けは H63 で決めた。
 *
 * **ブロック強度は deny。** `pre-commit-check.js` の冒頭が定める作法
 * （**自己修復可能な失敗は deny / 人間判断が必要なら continue:false**）に従う。
 * 台帳の行を足す・消す・パスを直すのは自己修復可能である。
 *
 * **素通りさせる条件**（fail-open）:
 *   - push を含まないコマンド
 *   - `docs/backlog.md` が無い（0.27.0 より前のプロジェクト）
 *   - 残作業台帳に計画節が無い（開発計画層が届いていない）
 *   - `harness.config.json` の `gates.backlogSync: "off"`
 */
const lib = require("./harness-lib");
const scope = require("./git-scope");
const backlog = require("./backlog-sync");

function main() {
  const payload = lib.readPayload();
  if (!payload) lib.passThrough();

  const command = lib.toolCommand(payload);
  if (!command) lib.passThrough();

  const opts = { shell: lib.toolShell(payload) };
  // **push の判定は `git-scope` に任せる。** 引用符・`-C` / `--git-dir`・行継続・
  // ヒアドキュメントの落とし穴を実測で潰してきた蓄積があり、**二重実装すると
  // 片方だけ古くなる**（H49 がまさにそれ）。
  const pushes = scope.gitInvocations(command, opts).filter((g) => g.sub === "push");
  if (!pushes.length) lib.passThrough();

  // config は読めなくても検査する（**黙らないことが目的**）。off のときだけ降りる。
  const { status, config } = lib.loadConfig();
  if (status === "ok" && config?.gates?.backlogSync === "off") lib.passThrough();

  const result = backlog.check(lib.projectDir());
  if (!result.applicable) {
    // **素通りしたことは知らせる。** 黙って通ると「検査された」と誤解される。
    lib.notify(
      "PreToolUse",
      `[backlog-sync] 残作業台帳の整合は検査していません（${result.reason}）。`
    );
    return;
  }
  if (!result.findings.length) lib.passThrough();

  const detail = result.findings
    .map((f, i) => `${i + 1}. **${f.what}**\n   → ${f.how}`)
    .join("\n");

  lib.emit({
    systemMessage: "[backlog-sync] ❌ 残作業台帳と機能設計書が食い違っています",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "**`docs/backlog.md`（残作業台帳）と `docs/features/` が合っていません。**\n" +
        "`pre-push-check` が見るのは `docs/設計書/.doc-sync.md`（**設計書同期台帳**）で、" +
        "**こちらは別物です**。\n\n" +
        detail +
        "\n\n**`/harness-core:backlog-sync` で直してから push してください。**\n" +
        "> どちらが正か（設計書を作るのか・行を消すのか）は**作業の実態で決まります**。" +
        "機械的に片側へ寄せないこと。\n" +
        "> 検査を止めたい場合は `harness.config.json` に `gates.backlogSync: \"off\"` を設定してください。",
    },
  });
  process.exit(0);
}

if (require.main === module) main();

module.exports = { main };
