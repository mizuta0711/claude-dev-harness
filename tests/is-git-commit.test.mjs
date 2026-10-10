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

// **ヒアドキュメントの本文に書かれた `git commit` は拾わない**（H65）。
// 本文は実行されないので、潰しても**見逃しは生じない**。
//
// > 実測: `commands.typecheck` が失敗する状態で、本文に `git commit` を含む文書を
// > `cat > … <<'EOF'` で書くと、**文書を書くだけの操作が deny され**、
// > 「修正してから再度**コミット**してください」と出た。
// > 「**誤検知は余計にチェックが走るだけ**」という前提が成り立っていなかった。
//
// **潰すのは、本文を受け取るコマンドが `cat` / `tee` のときだけ**である。
// **許可リストにしてあるのは、知らないコマンドを「潰さない」側へ倒すため** ——
// 潰さない側の失敗は**許容されている誤検知**で、潰す側の失敗は**禁じられている見逃し**。
const HEREDOC_BODIES = [
  ["cat > docs/x.md <<'EOF'", "git commit -- path を使う", "EOF"].join("\n"),
  ["cat > d.md <<-'EOF'", "	git commit -- a", "	EOF", ""].join("\n"),
  ["cat > d.md <<EOF", "git -C x commit -m y", "EOF"].join("\n"),
  ["tee docs/x.md <<EOF", "git commit -m x", "EOF"].join("\n"),
];

// **ヒアドキュメントがあっても見逃してはいけない形。**
//
// **初版（0.34.0 の最初の実装）はここで6件の見逃しを作った** —— 査読で差し戻された。
// 「ヒアドキュメントの本文は実行されない」という前提が誤りで、
// **導入部の行ごと潰していた**うえ、**シェルへ渡す本文は実行される**。
// **見逃し（ゲート素通り）は方針で不可**なので、ここが落ちたら実装が間違っている。
const HEREDOC_BUT_REAL = [
  // 導入部の行に本物のコミットが続く（**行ごと潰すと消える**）
  ["cat <<EOF | git commit -F -", "msg", "EOF"].join("\n"),
  ["cat <<EOF && git commit -m x", "body", "EOF"].join("\n"),
  // **シェルへ渡す本文は実行される**
  ["bash <<EOF", "git commit -m y", "EOF"].join("\n"),
  ["sh <<'EOF'", "git commit -m y", "EOF"].join("\n"),
  ["ssh host <<'EOF'", "git commit -m y", "EOF"].join("\n"),
  // `<<` に見えて本文を持たないもの（**終端が無いので後続を全部潰していた**）
  ["echo $((1 << N))", "git commit -m y"].join("\n"),
  ["grep x <<<abc", "git commit -m y"].join("\n"),
  // 本物のコミット自身がヒアドキュメントを使う
  ["git commit -F - <<EOF", "msg", "EOF"].join("\n"),
];

// **引用符は潰していない。** 引用符の中に**本物のコミットが来る形がある**ため、
// 潰すと見逃す（方針は「**見逃しは不可**」）。
const QUOTED_BUT_REAL = [
  'bash -c "git commit -- a.md"',
  "sh -c 'git commit -- a.md'",
  // Claude Code 標準のコミット形。**ヒアドキュメントは本文だけ潰すので、
  // 外側の本物のコミットは残る**
  ['git commit -m "$(cat <<EOF', "msg", 'EOF', ')" -- a.md'].join("\n"),
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

test("isGitCommit: ヒアドキュメントの本文は拾わない（H65）", () => {
  for (const c of HEREDOC_BODIES) assert.equal(core.isGitCommit(c), false, c);
});

test("isGitCommit: ヒアドキュメントがあっても本物のコミットは見逃さない（H65 の差し戻し）", () => {
  // **ここが落ちたら、ヒアドキュメントの外側まで潰している。**
  // 初版はこの8件のうち6件を見逃した。
  for (const c of HEREDOC_BUT_REAL) assert.equal(core.isGitCommit(c), true, c);
});

test("isGitCommit: 引用符の中の本物のコミットは見逃さない", () => {
  // **ここが落ちたら、引用符まで潰してしまっている。**
  // 見逃し（ゲート素通り）は方針で不可である。
  for (const c of QUOTED_BUT_REAL) assert.equal(core.isGitCommit(c), true, c);
});

// R6 の狙いのひとつ。`harness-unity/plugin-lib.js` は core と**同一実装**を持つ
// （重複は意図的だが、片方だけ直るリスクが残る）。同じケースを両方に当てて、
// 乖離した瞬間に落ちるようにする。
test("isGitCommit: 既知の誤検知（許容）", () => {
  for (const c of KNOWN_FALSE_POSITIVES) assert.equal(core.isGitCommit(c), true, c);
});

test("isGitCommit: unity 側の複製が core と乖離していない", () => {
  for (const c of [...HITS, ...MISSES, ...KNOWN_FALSE_POSITIVES, ...HEREDOC_BODIES, ...HEREDOC_BUT_REAL, ...QUOTED_BUT_REAL]) {
    assert.equal(unity.isGitCommit(c), core.isGitCommit(c), `乖離: ${c}`);
  }
});
