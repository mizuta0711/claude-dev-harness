/**
 * PostToolUse フック: ブランチを作成したことをユーザーの画面に出す
 *
 * 背景（2026-08-16 の実測）:
 *   Claude Code の既定方針は「デフォルトブランチ上ならまず切る」であり、
 *   エージェントはコミット直前に **自動でブランチを作る**。
 *   ところが作成そのものは報告に出ないため、
 *   **ユーザーが知らないブランチに作業が積み上がる**。
 *   実際に実プロジェクトで 4 コミット・約 20 時間ぶん気づかれずに溜まった
 *   （`chore/prune-design-policy-docs`。作成から 20 秒後に最初のコミット）。
 *
 * 方針:
 *   - **止めない。** 分岐そのものは妥当な運用であり、問題は「黙っていること」
 *   - `systemMessage`（画面）と `additionalContext`（Claude の文脈）の **2 経路とも**出す。
 *     Claude 側に届けるのは、**報告に1行入れさせる**ため
 *
 * 検出する形:
 *   git checkout -b/-B <name> / git switch -c/-C/--create/--force-create/--orphan <name>
 *   git branch <name>（**作成形だけ**。判定は下記の許可リスト）
 *   git worktree add -b/-B <name>
 *
 *   **拾わない形**（いずれも実物の git で作成を確認したうえで見送ったもの）:
 *   `git branch -c <old> <new>`（複製）/ `git worktree add <dir>`（ディレクトリ名から自動で切る形）/
 *   `git stash branch <name>` / `gh pr checkout`。
 *   **コマンド文字列に新しい名前が現れないか、エージェントが自動で打つ形ではない**ため。
 *
 * ## 方針: 見逃し（黙る）も誤検知も、どちらも害がある
 *
 * **このフックは「黙ることが欠陥」として作られた**（下の背景）。一方で、文面が
 * 「**この作成をユーザーに報告すること**」と指示するため、
 * **誤検知は「余計な1行」では済まず、Claude が存在しないブランチを報告する**ところまで行く。
 *
 * **だから「広めに取る」ではなく「作成形だと確実に言える形だけ取る」**。
 * 判断が付かないオプションが付いていたら**黙る**（`git branch` の許可リストがその形）。
 *
 * ## ⚠️ 判定を生の文字列に当ててはいけない（H74）
 *
 * 初版は**コマンド文字列そのものに正規表現を当てていた**ため、
 * **コマンド位置にない文字列でも発火した**（2026-10-10 の実測・4形）。
 *
 * | 形 | 初版の結果 |
 * |---|---|
 * | `git commit -F - <<'EOF'` の本文に `git branch fake` と書いた | **`fake` を作成と誤判定** |
 * | `git commit -m "git checkout -b nope を禁じる"` | **`nope` を作成と誤判定** |
 * | `echo 'git switch -c phantom'` | **`phantom` を作成と誤判定** |
 * | `ls # git branch commented` | **`commented` を作成と誤判定** |
 *
 * **初版は「見逃しは不可・誤検知は許容」と書いて広めに取っていた**が、
 * 上の方針のとおり**このフックでは誤検知も害がある**ので、その前提から改めた。
 *
 * **根は `0b32ee3`（H69 / H71 / H72 / H73）が `git-scope` で直したものと同じ型**なので、
 * 直し方も同じ —— `git-scope.js` の `gitInvocations` に委ねる。
 * ヒアドキュメントの本文・引用符の中・行コメントは走査の対象から外れ、
 * 引数は**トークン単位**で読まれる（`git branch` の除外判定が引用符や連結で割れない）。
 */
const lib = require("./harness-lib");
const scope = require("./git-scope");

/** `checkout` / `switch` / `worktree add` で**新しいブランチを指定する**長いオプション */
const CREATE_LONG = new Set(["--create", "--force-create", "--orphan"]);

/**
 * 同じく短いオプション。**値を同じトークンに飲む**ので、束ねた形の扱いが長形と違う。
 *
 * | 形 | 値 |
 * |---|---|
 * | `-b foo` | 次のトークン |
 * | `-bfoo` | 同じトークンの残り（git が受け付ける） |
 * | `-qb foo` | 束の最後が `b` なので次のトークン |
 * | `-bq` | `-b` が束の残りを飲むのでブランチ名は `q` |
 */
const CREATE_SHORT = new Set(["b", "B", "c", "C"]);

/**
 * `git branch` で**付いていてもブランチを作る**オプション（**許可リスト**）。
 *
 * ⚠️ **除外リストにしてはいけない。** 初版は「作らないオプション」を並べていたため、
 * **並べ忘れた値つきオプションの値をブランチ名として拾った**（査読の中1・いずれも実測）。
 *
 * | 形 | 除外リスト方式の結果 |
 * |---|---|
 * | `git branch --points-at HEAD` | **`HEAD` を作成と報告** |
 * | `git branch --no-contains HEAD` | **`HEAD` を作成と報告** |
 * | `git branch -l foo` | **`foo` を作成と報告**（`-l` は `--list` なので作らない） |
 *
 * **知らないオプションが付いていたら黙る**のがこちらの向き。
 * **実物の git で作成を確認したものだけを入れる**（2026-10-10・git 2.43.0 で実測）。
 */
const BRANCH_CREATE_SAFE_SHORT = new Set(["f", "q", "t", "v"]);
const BRANCH_CREATE_SAFE_LONG = new Set(["--force", "--quiet", "--track", "--no-track"]);

/**
 * `git checkout -b` / `git switch -c` / `git worktree add -b` から名前を取る。
 *
 * `-bfoo` のように値が同じトークンに付いた形も読む（git 自身が受け付ける）。
 */
function flaggedName(invocation) {
  const argv = invocation.argv || [];
  let i = 0;
  if (invocation.sub === "worktree") {
    if (argv[0] !== "add") return "";
    i = 1;
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break; // 以降は被演算子なのでオプションではない
    if (!a.startsWith("-") || a === "-") continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      if (!CREATE_LONG.has(name)) continue;
      return eq < 0 ? argv[i + 1] || "" : a.slice(eq + 1);
    }
    // 短いオプションは束ねられる。`-b` 以降は同じトークンの残りを値として飲む
    const bundle = a.slice(1);
    const at = [...bundle].findIndex((ch) => CREATE_SHORT.has(ch));
    if (at < 0) continue;
    return bundle.slice(at + 1) || argv[i + 1] || "";
  }
  return "";
}

/**
 * `git branch <name> [start-point]` から名前を取る（**作成形だけ**）。
 *
 * **作ると確認できているオプション以外が1つでも付いていたら空を返す**（許可リスト）。
 * 被演算子が無い形（`git branch` / `git branch -v`）は一覧なので、これも空になる。
 */
function branchName(invocation) {
  const argv = invocation.argv || [];
  const operands = [];
  for (const a of argv) {
    if (a === "--") continue;
    if (a.length > 1 && a.startsWith("-")) {
      if (a.startsWith("--")) {
        if (!BRANCH_CREATE_SAFE_LONG.has(a.split("=")[0])) return "";
        continue;
      }
      // 束ねた短いオプション（`-rv` など）は1文字ずつ見る
      for (const ch of a.slice(1)) {
        if (!BRANCH_CREATE_SAFE_SHORT.has(ch)) return "";
      }
      continue;
    }
    operands.push(a);
  }
  // 被演算子が無ければ一覧（`git branch` / `git branch -v`）なので作らない
  return operands[0] || "";
}

/**
 * ブランチ作成コマンドかを判定し、指定された名前を返す（取れなければ空文字）。
 *
 * **コマンド位置に現れた git 呼び出しだけ**を見る（H74。判定は `git-scope` に委ねる）。
 *
 * @param {string} cmd
 * @param {{shell?: "bash"|"powershell"}} [opts]
 * @returns {string}
 */
function createdBranchName(cmd, opts) {
  for (const g of scope.gitInvocations(cmd, opts)) {
    const name =
      g.sub === "checkout" || g.sub === "switch" || g.sub === "worktree"
        ? flaggedName(g)
        : g.sub === "branch"
          ? branchName(g)
          : "";
    if (name) return name;
  }
  return "";
}

function main() {
  const payload = lib.readPayload();
  if (!payload) lib.passThrough();

  const command = lib.toolCommand(payload);
  if (!command) lib.passThrough();

  const requested = createdBranchName(command, { shell: lib.toolShell(payload) });
  if (!requested) lib.passThrough();

  // 実際に切り替わったか（`git branch <name>` は作るだけで移動しない）
  const current = lib.git("branch --show-current", 3000);

  // リモートの既定ブランチ（origin/HEAD → origin/master 等）。取れなければ空
  const defaultRef = lib.git("symbolic-ref --short refs/remotes/origin/HEAD", 3000);
  const defaultBranch = defaultRef ? defaultRef.replace(/^origin\//, "") : "";

  const parts = [`[branch] ブランチ \`${requested}\` を作成しました`];
  if (current && current !== requested) parts.push(`（現在は \`${current}\`）`);
  if (defaultBranch && requested !== defaultBranch) {
    parts.push(`。既定ブランチは \`${defaultBranch}\` で、このブランチには upstream がありません`);
  }

  lib.notify(
    "PostToolUse",
    parts.join("") +
      "。**この作成をユーザーに報告すること**（作業の完了報告に1行含める）。" +
      "ユーザーが知らないブランチにコミットが積み上がると、push もマージもされないまま残ります。"
  );
}

// フックとして起動されたときだけ実行する。
// `require` されたとき（テスト）は判定関数だけを取り出せるようにしておく。
if (require.main === module) main();

module.exports = { createdBranchName };
