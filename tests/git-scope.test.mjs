import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 配布物側（利用側プロジェクトへ配る）
const scope = require(path.join(ROOT, "plugins", "harness-core", "hooks", "scripts", "git-scope.js"));
// リポジトリ固有側（このリポジトリを守る）
const guard = require(path.join(ROOT, ".claude", "hooks", "repo-guard.js"));

// **同じ判定が2箇所にある。** repo-guard は「配布物のプラグインに自分の規律を
// 依存させない」方針のため独立している（H19）。重複は意図的だが、
// **片方だけ直るリスク**が残るので、同じケースを両方に当てて乖離した瞬間に落とす。
//
// `isGitCommit` の core / unity 複製に対して is-git-commit.test.mjs がやっているのと同じ形。

const CASES = [
  // 止める
  "git add -A",
  "git add .",
  "git add --all",
  "git add :/",
  "git status && git add -A",
  "git commit -a",
  'git commit -am "x"',
  "git commit --all -m x",
  "git stash",
  "git stash push",
  "git stash -u",
  "git checkout -- .",
  "git restore .",
  "git clean -fd",
  // 通す
  "git add src/foo.ts",
  "git add -p",
  "git add -A --dry-run",
  "git commit -m x",
  "git commit -- src/a.ts",
  "git commit --amend",
  "git stash list",
  "git stash pop",
  "git checkout -- src/x.ts",
  "git checkout master",
  "git clean -fd tests/",
  "git clean -n",
  "git push origin master",
  "ls -la",
  // 発火してはいけない形（R3）
  `echo 'git add -A'`,
  `node -e "console.log('git commit -a')"`,
  "ls # git stash は使わない",
  ["cat <<'EOF'", "git add -A", "EOF"].join("\n"),
];

const PREDICATES = [
  "isBlockedAdd",
  "isBlockedCommitAll",
  "isBlockedStash",
  "isBlockedDiscard",
  "isUnscopedCommit",
];

test("git-scope と repo-guard の判定が乖離していない", () => {
  for (const fn of PREDICATES) {
    for (const cmd of CASES) {
      assert.equal(
        scope[fn](cmd),
        guard[fn](cmd),
        `乖離: ${fn}(${JSON.stringify(cmd)})`
      );
    }
  }
});

test("git-scope: 配布物側だけでも期待どおりに判定する", () => {
  assert.equal(scope.isBlockedAdd("git add -A"), true);
  assert.equal(scope.isBlockedAdd("git add src/a.ts"), false);
  assert.equal(scope.isBlockedCommitAll("git commit -am x"), true);
  assert.equal(scope.isBlockedStash("git stash"), true);
  assert.equal(scope.isBlockedStash("git stash pop"), false);
  assert.equal(scope.isBlockedDiscard("git clean -fd"), true);
  assert.equal(scope.isBlockedDiscard("git clean -n"), false);
});

test("git-scope: 引用符・コメント・ヒアドキュメントでは発火しない", () => {
  const benign = [
    `echo 'git add -A'`,
    `grep -n "git commit -a" CLAUDE.md`,
    "ls # git stash は使わない",
    ["cat <<'EOF' > note.md", "git add -A を使わないこと", "EOF"].join("\n"),
  ];
  for (const cmd of benign) {
    for (const fn of PREDICATES) {
      assert.equal(scope[fn](cmd), false, `${fn} が発火: ${JSON.stringify(cmd)}`);
    }
  }
});
