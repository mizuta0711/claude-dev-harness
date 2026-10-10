import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createdBranchName } = require(
  path.join(ROOT, "plugins", "harness-core", "hooks", "scripts", "post-branch-notice.js")
);

// 方針: **見逃し（黙る）は不可・誤検知（余計に1行出るだけ）は許容**。
// 除外リストが長いので、削除・改名・一覧の形を1つずつ固定する。

test("作成形はブランチ名を返す", () => {
  const cases = [
    ["git checkout -b chore/foo", "chore/foo"],
    ["git switch -c feat/bar", "feat/bar"],
    ["git checkout -B hotfix", "hotfix"],
    ["git switch -C hotfix2", "hotfix2"],
    ["git worktree add -b wt ../x", "wt"],
    ["git branch newbranch", "newbranch"],
    ["git branch newbranch origin/master", "newbranch"],
    ['git checkout -b "with space"', "with space"],
  ];
  for (const [cmd, want] of cases) assert.equal(createdBranchName(cmd), want, cmd);
});

test("一覧・削除・改名・設定の形は拾わない", () => {
  const cases = [
    "git branch",
    "git branch --show-current",
    "git branch -r",
    "git branch -a",
    "git branch -v",
    "git branch -d old",
    "git branch -D old",
    "git branch -m a b",
    "git branch --list",
    "git branch --merged",
    "git branch --set-upstream-to=origin/x",
    "git checkout master",
    "git switch master",
    "git commit -m x",
    "git log --oneline -b",
  ];
  for (const cmd of cases) assert.equal(createdBranchName(cmd), "", cmd);
});

// --- H74: コマンド位置にない文字列で発火しない ---
//
// **このフックの文面は「この作成をユーザーに報告すること」と指示する**ため、
// 誤検知の害が「余計な1行」で済まない（**Claude が存在しないブランチを報告する**）。
// 上の方針（誤検知は許容）はここには当てはまらないので、4形を固定する。
// いずれも 2026-10-10 に初版で実際に発火した形。

test("H74: ヒアドキュメントの本文では発火しない", () => {
  const cmd = "git commit -F - <<'EOF'\ndocs: git branch fake-branch の話\nEOF";
  assert.equal(createdBranchName(cmd), "");
});

test("H74: 引用符の中では発火しない", () => {
  const cases = [
    'git commit -m "git checkout -b nope を禁じる"',
    "echo 'git switch -c phantom'",
    'echo "git worktree add -b ghost ../x"',
  ];
  for (const cmd of cases) assert.equal(createdBranchName(cmd), "", cmd);
});

test("H74: 行コメントでは発火しない", () => {
  assert.equal(createdBranchName("ls # git branch commented"), "");
});

test("H74: コマンド位置なら引用符の中でも拾う（bash -c の本体）", () => {
  assert.equal(createdBranchName('bash -c "git checkout -b nested/ok"'), "nested/ok");
});

test("H74: 区切りの後ろも拾う", () => {
  assert.equal(createdBranchName("git status --short && git checkout -b after/sep"), "after/sep");
});

test("H74: トークンで読むので連結・長形も拾う", () => {
  const cases = [
    ["git checkout -battached", "attached"],
    ["git switch --create long/form", "long/form"],
    ["git switch --force-create long/force", "long/force"],
    ["git -C 'D:/my proj' checkout -b with/space-cwd", "with/space-cwd"],
  ];
  for (const [cmd, want] of cases) assert.equal(createdBranchName(cmd), want, cmd);
});

test("H74: 束ねた短いオプションの一覧形は拾わない", () => {
  for (const cmd of ["git branch -rv", "git branch -av", "git branch -vv"]) {
    assert.equal(createdBranchName(cmd), "", cmd);
  }
});

test("H74: worktree は add 以外では発火しない", () => {
  assert.equal(createdBranchName("git worktree list -b x"), "");
});
