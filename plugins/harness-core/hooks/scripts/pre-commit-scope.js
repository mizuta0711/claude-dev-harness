/**
 * PreToolUse フック: 範囲まるごとの git 操作を知らせる（既定）／止める（設定時）
 *
 * ## なぜ配るのか（R8）
 *
 * `templates/base/CLAUDE.md` は利用側プロジェクトにも
 * 「**コミットは必ずパス指定**。`git add -A` / `git add .` は使わない」と書いている。
 * ところが同じテンプレートが配る `.claude/settings.json` の `permissions.allow` には
 * `Bash(git add:*)` があり、**`git add -A` は確認なしで通っていた**。ガードも無い。
 *
 * つまり生成先では、H19 以前の `claude-dev-harness` と**まったく同じ構図**
 * （読ませる文書だけで担保）だった。
 *
 * H19 の判断「配布物のプラグインには置かない」の理由は
 * **「自分が編集中のプラグインに自分の規律を依存させない」**であり、
 * これは**利用側プロジェクトには当てはまらない**（利用側は harness-core を編集しない）。
 * 理由が及ばない範囲まで結論だけが及んでいたので、ここで配る。
 *
 * ## 段階を持たせる
 *
 * | `gates.commitScope` | 挙動 |
 * |--------------------|------|
 * | 未設定（既定） | **警告のみ**（検知したら1行出す） |
 * | `"paths"` | **deny** |
 * | `"off"` | 何もしない |
 *
 * **既定を警告にしておく**のは、既存プロジェクトが `harness-update` で追従した瞬間に
 * コミットが止まらないようにするため。止めたいプロジェクトだけが `"paths"` を書く。
 *
 * ## 何を見るか
 *
 * 判定は `git-scope.js`（コマンド位置に限定した走査）に委ねる。
 * 引用符・コメント・ヒアドキュメントの中の文字列では発火しない。
 *
 * | 対象 | 理由 |
 * |------|------|
 * | `git add -A` / `.` / `--all` / `:/` | インデックス全体を巻き込む |
 * | `git commit -a` / `-am` / `--all` | 追跡済みを全部巻き込む。**実害は `add -A` とほぼ同じ** |
 * | `git stash`（退避する形） | 他の作業ごと退避する |
 * | `git checkout -- .` / `git restore .` / パス指定なしの `git clean` | 範囲指定なしの破棄 |
 *
 * **パス指定なしの `git commit -m` は対象外**（`git add <path>` の直後など正当な使い方がある）。
 */
const lib = require("./harness-lib");
const scope = require("./git-scope");

const CHECKS = [
  {
    hit: scope.isBlockedAdd,
    what: "`git add -A` / `git add .`",
    why: "インデックス全体をステージするため、**意図していない変更まで巻き込みます**。",
  },
  {
    hit: scope.isBlockedCommitAll,
    what: "`git commit -a` / `-am`",
    why: "**追跡済みファイルを全部**巻き込むので、`git add -A` と実害がほぼ同じです。",
  },
  {
    hit: scope.isBlockedStash,
    what: "`git stash`（退避する形）",
    why: "**作業中の変更をまとめて退避**します。対象を明示するなら `git stash push -- <path...>`。",
  },
  {
    hit: scope.isBlockedDiscard,
    what: "`git checkout -- .` / `git restore .` / パス指定なしの `git clean`",
    why: "**未コミットの変更を範囲指定なしで消します**。何が消えるかは `git clean -n` で確認できます。",
  },
];

const ADVICE =
  "代わりに次のどちらかを使ってください:\n" +
  "  git commit -- <path...>            # ステージせずに直接コミット\n" +
  "  git add <path...> && git commit    # 対象を明示してステージ\n\n" +
  "**まず `git status --short` で、自分が触った覚えのないファイルが無いか確認すること。**";

function main() {
  const payload = lib.readPayload();
  if (!payload) lib.passThrough();

  const command = lib.toolCommand(payload);
  if (!command) lib.passThrough();

  const hits = CHECKS.filter((c) => c.hit(command));
  if (!hits.length) lib.passThrough();

  // config が読めなくても既定（警告）で動く。**黙らないことが目的**なので
  // ここは fail-open で素通りさせない（H16 の教訓）。
  const { status, config } = lib.loadConfig();
  const mode = status === "ok" ? config?.gates?.commitScope : undefined;
  if (mode === "off") lib.passThrough();

  const detail =
    hits.map((h) => `- ${h.what} — ${h.why}`).join("\n") + "\n\n" + ADVICE;

  if (mode === "paths") {
    lib.emit({
      systemMessage: `[commit-scope] ❌ 範囲まるごとの git 操作は使えません`,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "**コミットは必ずパス指定**です（`CLAUDE.md`「運用ルール」）。\n\n" +
          detail +
          "\n\n> このプロジェクトは `harness.config.json` の `gates.commitScope: \"paths\"` で" +
          "**ブロックする**設定になっています。",
      },
    });
    process.exit(0);
  }

  lib.notify(
    "PreToolUse",
    "[commit-scope] 範囲まるごとの git 操作です。**意図した範囲か確認してください。**\n\n" +
      detail +
      "\n\n> 止めたい場合は `harness.config.json` に `gates.commitScope: \"paths\"` を設定してください" +
      "（既定は警告のみ）。"
  );
}

// フックとして起動されたときだけ実行する。
// `require` されたとき（テスト）は判定を取り出せるようにしておく。
if (require.main === module) main();

module.exports = { CHECKS };
