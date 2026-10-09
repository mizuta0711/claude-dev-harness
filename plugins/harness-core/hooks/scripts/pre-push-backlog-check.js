/**
 * PreToolUse フック: push の前に**残作業台帳と機能設計書の整合**を確かめる（H63）。
 *
 * **なぜフックなのか。** 同じ検査をスキルの Step として置く案を捨てた。
 * `pre-push-check` は**規律としては既にある**（`core.md`「push の直前に通す」）のに
 * **守られていない** —— `usage-audit/SKILL.md` に「**`pre-push-check` の無い push**」という
 * 監査項目があるのが、その前提で作られている証拠である。
 * **手順書に足すだけでは、読む人の注意力に依存する**（H19 / H23 と同じ結論）。
 *
 * **`pre-push-check` と見ているものが違う。** あれは `designDocs.ledger`
 * （`docs/設計書/.doc-sync.md` ＝ **設計書同期台帳**）を見る。こちらは
 * `docs/backlog.md`（**残作業台帳**）で、**誰も検査していなかった**。
 *
 * **ブロック強度は deny。** `pre-commit-check.js` の冒頭が定める作法
 * （**自己修復可能な失敗は deny / 人間判断が必要なら continue:false**）に従う。
 * 台帳の行を足す・消す・パスを直すのは自己修復可能である。
 *
 * **素通りさせる条件**（fail-open）:
 *   - push を含まないコマンド ／ `--dry-run`（何も送らないので害が無い）
 *   - 対象リポジトリを解決できない・解決先が実在しない
 *   - `docs/backlog.md` が無い（0.27.0 より前のプロジェクト）
 *   - 残作業台帳に計画節が無い（開発計画層が届いていない）
 *   - `harness.config.json` の `gates.backlogSync: "off"`
 */
const fs = require("node:fs");
const path = require("node:path");
const lib = require("./harness-lib");
const scope = require("./git-scope");
const backlog = require("./backlog-sync");

/**
 * **push の対象リポジトリ**を解決する。
 *
 * `lib.projectDir()`（＝`CLAUDE_PROJECT_DIR`）をそのまま使うと、
 * **別リポジトリの push を、このセッションのプロジェクトの台帳で止める**。
 * `cd <別リポジトリ> && git push` は実際の作法である
 * （ProjectTemplete から `claude-dev-harness` を push するのがそれ）。
 *
 * `cd` と `-C` を追うだけの**浅い解決**にしてある。解決できた先が実在しなければ
 * **検査しない** —— **間違った台帳で止めるより、見逃す方がましである**
 * （誤って deny すると正常な作業が止まる）。
 *
 * @returns {{dir: string, args: string}|null}
 */
function resolveTarget(command, opts, projectDir) {
  let cwd = projectDir;
  for (const seg of scope.scanCommands(command, opts)) {
    const toks = scope.tokenize(seg.text, opts).map((t) => t.value);
    if (!toks.length) continue;
    if ((toks[0] === "cd" || toks[0] === "pushd") && toks[1]) {
      cwd = path.resolve(cwd, toks[1]);
      continue;
    }
    const push = scope.gitInvocations(seg.text, opts).find((g) => g.sub === "push");
    if (!push) continue;
    const ci = toks.indexOf("-C");
    const dir = ci >= 0 && toks[ci + 1] ? path.resolve(cwd, toks[ci + 1]) : cwd;
    return { dir, args: push.args || "" };
  }
  return null;
}

const ADVICE = [
  "**`docs/backlog.md`（残作業台帳）と `docs/features/` が合っていません。**",
  "`pre-push-check` が見るのは `docs/設計書/.doc-sync.md`（**設計書同期台帳**）で、**こちらは別物です**。",
].join("\n");

const CAVEAT = [
  "**`/harness-core:backlog-sync` で直してから push してください。**",
  "> どちらが正か（設計書を作るのか・行を消すのか）は**作業の実態で決まります**。機械的に片側へ寄せないこと。",
  "> ⚠️ **見ているのは作業ツリーの現状**で、push されるコミットの内容ではありません。",
  ">    **他セッションが台帳を編集中なら、その未コミットの状態で止まります**",
  ">    （`git status --short` で確かめてください。**他セッションの変更には触らないこと**）。",
  '> 検査を止めたい場合は `harness.config.json` に `gates.backlogSync: "off"` を設定してください。',
].join("\n");

function main() {
  const payload = lib.readPayload();
  if (!payload) lib.passThrough();

  const command = lib.toolCommand(payload);
  if (!command) lib.passThrough();

  const opts = { shell: lib.toolShell(payload) };
  // **push の判定は `git-scope` に任せる。** 引用符・`-C` / `--git-dir`・行継続・
  // ヒアドキュメントの落とし穴を実測で潰してきた蓄積があり、**二重実装すると
  // 片方だけ古くなる**（H49 がまさにそれ）。
  const target = resolveTarget(command, opts, lib.projectDir());
  if (!target) lib.passThrough();

  // **`--dry-run` は止めない。** 何も送らないので、台帳が合っていなくても害が無い。
  if (/(^|\s)(--dry-run|-n)(\s|$)/.test(target.args)) lib.passThrough();

  // config は読めなくても検査する（**黙らないことが目的**）。off のときだけ降りる。
  const { status, config } = lib.loadConfig();
  if (status === "ok" && config?.gates?.backlogSync === "off") lib.passThrough();

  if (!fs.existsSync(target.dir)) lib.passThrough();

  const result = backlog.check(target.dir);
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
      permissionDecisionReason: [ADVICE, "対象: `" + target.dir + "`", detail, CAVEAT].join("\n\n"),
    },
  });
  process.exit(0);
}

if (require.main === module) main();

module.exports = { main, resolveTarget };
