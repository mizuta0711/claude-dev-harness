import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const core = require(path.join(ROOT, "plugins", "harness-core", "hooks", "scripts", "harness-lib.js"));
const unity = require(path.join(ROOT, "plugins", "harness-unity", "hooks", "scripts", "plugin-lib.js"));

// `git` と `commit` の間にはグローバルオプションが挟まりうる。
// **見逃し（ゲート素通り）は不可・誤検知（余計にチェックが走るだけ）は許容**の方針。
const HITS = [
  "git commit -m x",
  "git commit -- src/a.ts",
  "git -C /some/dir commit -m x",
  "git -c user.name=x commit -m x",
  "git --no-pager commit -m x",
  "cd /some/dir && git commit -- a.md",
];

const MISSES = [
  "git add src/a.ts",
  "git status --short",
  "git log --oneline -1",
  "git push origin master",
];

// **既知の誤検知（許容）。** `\bcommit\b` は `commit-tree` にも当たる
// （`-` は非単語文字なので `\b` が成立する）。plumbing の `git commit-tree` は
// HEAD を動かさないため、ゲートが余計に走るだけで実害は無い。
// 方針は「**見逃しは不可・誤検知は許容**」なので直さない。挙動として固定しておく。
const KNOWN_FALSE_POSITIVES = ["git commit-tree"];

test("isGitCommit: グローバルオプション付きでも拾う", () => {
  for (const c of HITS) assert.equal(core.isGitCommit(c), true, c);
});

test("isGitCommit: コミット以外は拾わない", () => {
  for (const c of MISSES) assert.equal(core.isGitCommit(c), false, c);
});

// R6 の狙いのひとつ。`harness-unity/plugin-lib.js` は core と**同一実装**を持つ
// （重複は意図的だが、片方だけ直るリスクが残る）。同じケースを両方に当てて、
// 乖離した瞬間に落ちるようにする。
test("isGitCommit: 既知の誤検知（許容）", () => {
  for (const c of KNOWN_FALSE_POSITIVES) assert.equal(core.isGitCommit(c), true, c);
});

test("isGitCommit: unity 側の複製が core と乖離していない", () => {
  for (const c of [...HITS, ...MISSES, ...KNOWN_FALSE_POSITIVES]) {
    assert.equal(unity.isGitCommit(c), core.isGitCommit(c), `乖離: ${c}`);
  }
});
