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
