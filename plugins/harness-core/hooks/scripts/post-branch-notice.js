/**
 * PostToolUse フック: ブランチを作成したことをユーザーの画面に出す
 *
 * 背景（2026-08-16 の実測）:
 *   Claude Code の既定方針は「デフォルトブランチ上ならまず切る」であり、
 *   エージェントはコミット直前に **自動でブランチを作る**。
 *   ところが作成そのものは報告に出ないため、
 *   **ユーザーが知らないブランチに作業が積み上がる**。
 *   実際に skillup_mock で 4 コミット・約 20 時間ぶん気づかれずに溜まった
 *   （`chore/prune-design-policy-docs`。作成から 20 秒後に最初のコミット）。
 *
 * 方針:
 *   - **止めない。** 分岐そのものは妥当な運用であり、問題は「黙っていること」
 *   - `systemMessage`（画面）と `additionalContext`（Claude の文脈）の **2 経路とも**出す。
 *     Claude 側に届けるのは、**報告に1行入れさせる**ため
 *
 * 検出する形:
 *   git checkout -b/-B <name> / git switch -c/-C <name>
 *   git branch <name>（作成形のみ。-d/-D/-m/-r/-a/--show-current 等は除外）
 *   git worktree add -b <name>
 */
const lib = require("./harness-lib");

const payload = lib.readPayload();
if (!payload) lib.passThrough();

const command = lib.toolCommand(payload);
if (!command) lib.passThrough();

/**
 * ブランチ作成コマンドかを判定し、指定された名前を返す（取れなければ空文字）。
 *
 * **見逃し（黙る）は不可・誤検知（余計に1行出るだけ）は許容**の方針で広めに取る。
 */
function createdBranchName(cmd) {
  // git checkout -b foo / git switch -c foo / git worktree add -b foo ../wt
  const flagged = cmd.match(
    /\bgit\b(?:\s+(?:-[cC]\s*\S+|--\S+))*\s+(?:checkout|switch|worktree\s+add)\b[^\n;&|]*?\s-(?:b|B|c|C)\s+("[^"]+"|'[^']+'|\S+)/
  );
  if (flagged) return flagged[1].replace(/^["']|["']$/g, "");

  // git branch foo [start-point] — 作成形だけを拾う
  const bare = cmd.match(/\bgit\b(?:\s+(?:-[cC]\s*\S+|--\S+))*\s+branch\b([^\n;&|]*)/);
  if (bare) {
    const rest = bare[1].trim();
    // 一覧・削除・改名・設定系はブランチを作らない
    if (!rest) return "";
    if (/(^|\s)-(?:d|D|m|M|r|a|v|c|C|u)\b/.test(rest)) return "";
    if (/(^|\s)--(?:list|delete|move|copy|remote|all|show-current|contains|merged|no-merged|set-upstream-to|unset-upstream|edit-description|format|sort)\b/.test(rest)) {
      return "";
    }
    const first = rest.split(/\s+/)[0];
    if (!first || first.startsWith("-")) return "";
    return first.replace(/^["']|["']$/g, "");
  }

  return "";
}

const requested = createdBranchName(command);
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
