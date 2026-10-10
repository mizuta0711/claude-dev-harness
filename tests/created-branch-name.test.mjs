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

// 方針: **見逃し（黙る）も誤検知も、どちらも害がある**（本体の冒頭コメントを見ること）。
// このフックの文面は「この作成をユーザーに報告すること」と指示するので、
// 誤検知は **Claude が存在しないブランチを報告する**ところまで行く。
// だから「作成形だと確実に言える形だけ取る」——判断が付かないオプションが付いていたら黙る。

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
// 4形を固定する。いずれも 2026-10-10 に初版で実際に発火した形。

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

// --- 査読の指摘（2026-10-10・0.38.0 の独立査読2本） ---
//
// `git branch` を**除外リスト**で判定していたため、**並べ忘れた値つきオプションの値を
// ブランチ名として拾っていた**。許可リストへ反転した。
// **作る／作らないは実物の git で確かめてある**（git 2.43.0.windows.1・使い捨てリポジトリ）。

test("査読中1: `git branch` の値つきオプションの値をブランチ名にしない", () => {
  const cases = [
    "git branch --points-at HEAD",
    "git branch --no-contains HEAD",
    "git branch -l foo", // `-l` は `--list` なのでパターン指定
    "git branch --column=never",
    "git branch --sort=-committerdate",
  ];
  for (const cmd of cases) assert.equal(createdBranchName(cmd), "", cmd);
});

test("査読中2: 付いていても作るオプションは拾う（実物で確認した8つ）", () => {
  const cases = [
    ["git branch -f ff1", "ff1"],
    ["git branch -q qq1", "qq1"],
    ["git branch -t tt1 origin/x", "tt1"],
    ["git branch -v vv1", "vv1"], // `-v` でも被演算子があれば作る
    ["git branch --force fo1", "fo1"],
    ["git branch --quiet qu1", "qu1"],
    ["git branch --track tr1", "tr1"],
    ["git branch --no-track nt1", "nt1"],
  ];
  for (const [cmd, want] of cases) assert.equal(createdBranchName(cmd), want, cmd);
});

test("査読中2: 被演算子が無ければ一覧なので拾わない", () => {
  for (const cmd of ["git branch", "git branch -v", "git branch -vv", "git branch -q"]) {
    assert.equal(createdBranchName(cmd), "", cmd);
  }
});

test("査読中3: 束ねた短いオプションと `=` 付きの長形も拾う", () => {
  const cases = [
    ["git checkout -qb qb1", "qb1"],
    ["git switch -qc foo", "foo"],
    ["git checkout -fb foo", "foo"],
    ["git switch --create=cr1", "cr1"],
    ["git switch --force-create=fc1", "fc1"],
    ["git checkout -bq", "q"], // `-b` が束の残りを値として飲む
  ];
  for (const [cmd, want] of cases) assert.equal(createdBranchName(cmd), want, cmd);
});

test("査読低1: `switch --orphan` も作成として拾う", () => {
  assert.equal(createdBranchName("git switch --orphan orph1"), "orph1");
  assert.equal(createdBranchName("git checkout --orphan orph2"), "orph2");
});

// **PowerShell 方言を一度も通していなかった**（査読の指摘）。
// 誤検知の防止がこちらでも効くことを固定する。
test("査読: PowerShell 方言でも引用符の中では発火しない", () => {
  const ps = { shell: "powershell" };
  assert.equal(createdBranchName('Write-Output "git checkout -b phantom"', ps), "");
  assert.equal(createdBranchName("Write-Output 'git switch -c phantom'", ps), "");
  assert.equal(createdBranchName("git checkout -b real/ps", ps), "real/ps");
});

// 査読の高1 / 高2: **コマンド位置の手前の構文を剥がしていなかった**ため、
// 旧版（正規表現を生の文字列に当てる形）では拾えていた形を**見逃していた**。
// 根は `git-scope` 側で、同じ穴が `git add -A` の deny も素通りさせていた
// （→ `tests/git-scope.test.mjs` の「H74査読」）。

test("査読高1: 制御構文の予約語の後ろでも拾う", () => {
  const cases = [
    ["if true; then git checkout -b foo; fi", "foo"],
    ["if git diff --quiet; then git checkout -b foo; fi", "foo"],
    ["for i in 1; do git branch b1; done", "b1"],
    ["while true; do git checkout -b foo; done", "foo"],
    ["if false; then :; else git branch foo; fi", "foo"],
    ["! git checkout -b foo", "foo"],
  ];
  for (const [cmd, want] of cases) assert.equal(createdBranchName(cmd), want, cmd);
});

test("査読高2: PowerShell の代入で受けても拾う", () => {
  const ps = { shell: "powershell" };
  assert.equal(createdBranchName("$r = git branch foo", ps), "foo");
  assert.equal(createdBranchName("$out = git checkout -b foo", ps), "foo");
  assert.equal(createdBranchName("$out = (git checkout -b foo)", ps), "foo");
});
