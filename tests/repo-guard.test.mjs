import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guard = require(path.join(ROOT, ".claude", "hooks", "repo-guard.js"));

// ---------------------------------------------------------------------------
// コマンド位置の走査（R3 の中核）
//
// 初版は素の正規表現で、**引用符やコメントの中に文字列があるだけで deny した**。
// 実際にレビュー中と実装中の2回、正常な操作がブロックされている。
// ---------------------------------------------------------------------------
test("scanCommands: 区切りでコマンド位置を切り出す", () => {
  const segs = guard.scanCommands("git status && git add -A ; echo done");
  assert.deepEqual(
    segs.map((s) => s.text),
    ["git status", "git add -A", "echo done"]
  );
});

test("scanCommands: 引用符の内側は1つの断片にしない", () => {
  const segs = guard.scanCommands(`echo 'git add -A && git push' && ls`);
  assert.deepEqual(
    segs.map((s) => s.text),
    [`echo 'git add -A && git push'`, "ls"]
  );
});

test("scanCommands: コメントは読み飛ばす", () => {
  const segs = guard.scanCommands("ls # ここで git add -A の話をする");
  assert.deepEqual(
    segs.map((s) => s.text),
    ["ls"]
  );
});

test("scanCommands: ヒアドキュメントの本文は飛ばす", () => {
  // 本文は**データであってコマンドではない**。このリポジトリでは CLAUDE.md /
  // CHANGELOG / コミットメッセージをヒアドキュメントで書くのが常態で、
  // そこには禁止コマンド名が頻出する。
  // **本ガードの導入コミット自身がこれで止まった**（2026-08-16）。
  const cmd = [
    "git commit -q -F - -- CLAUDE.md <<'EOF'",
    "fix: 説明",
    "",
    "  git commit -a / -am は止める",
    "  git add -A も止める",
    "EOF",
  ].join("\n");

  assert.deepEqual(
    guard.scanCommands(cmd).map((s) => s.text),
    ["git commit -q -F - -- CLAUDE.md"]
  );
  assert.equal(guard.isBlockedAdd(cmd), false);
  assert.equal(guard.isBlockedCommitAll(cmd), false);
});

test("scanCommands: ヒアドキュメントの後ろのコマンドは拾う", () => {
  const cmd = ["cat <<EOF > a.txt", "git add -A", "EOF", "git add -A"].join("\n");
  const texts = guard.scanCommands(cmd).map((s) => s.text);
  assert.ok(texts.includes("git add -A"), "終端後の本物は拾う");
  assert.equal(texts.filter((t) => t === "git add -A").length, 1, "本文側は拾わない");
  assert.equal(guard.isBlockedAdd(cmd), true, "終端後の本物は deny 対象");
});

test("scanCommands: コマンド置換の内側はコマンド位置として拾う", () => {
  const segs = guard.scanCommands("echo $(git rev-parse HEAD)");
  assert.ok(segs.some((s) => s.text.startsWith("git rev-parse")));
});

test("parseGit: 環境変数代入とグローバルオプションを飛ばす", () => {
  const g = (c) => guard.parseGit(guard.scanCommands(c)[0]);
  assert.equal(g("git add -A").sub, "add");
  assert.equal(g("git -C /some/dir push origin master").sub, "push");
  assert.equal(g("git -c user.name=x commit -m y").sub, "commit");
  assert.equal(g("git --no-pager log").sub, "log");
  assert.equal(g("FOO=bar git status").sub, "status");
  assert.equal(g("ls -la"), null);
});

// ---------------------------------------------------------------------------
// R3: 誤検知しない
// ---------------------------------------------------------------------------
test("R3: 引用符・コメントの中の文字列では発火しない", () => {
  const benign = [
    `echo 'git add -A'`,
    `echo "git add -A"`,
    `node -e "console.log('git add -A')"`,
    `grep -n "git add -A" CLAUDE.md`,
    `ls # git add -A は使わない`,
    `git log --grep="git add -A"`,
  ];
  for (const c of benign) {
    assert.equal(guard.isBlockedAdd(c), false, c);
    assert.equal(guard.isBlockedCommitAll(c), false, c);
    assert.equal(guard.isBlockedStash(c), false, c);
    assert.equal(guard.isBlockedDiscard(c), false, c);
  }
});

test("R3: findPush も引用符の内側を拾わない", () => {
  // 第1便では位置 6 を返していた（既知の欠陥として固定していたもの）。
  // R3 で解消したので **ケースは残して期待値を変える**。
  assert.equal(guard.findPush("echo 'git push' # 説明"), -1);
  assert.equal(guard.findPush("git push origin master"), 0);
  assert.ok(guard.findPush("cd x && git push") > 0);
  assert.equal(guard.findPush("git status"), -1);
});

// ---------------------------------------------------------------------------
// git add の範囲指定
// ---------------------------------------------------------------------------
test("isBlockedAdd: 範囲まるごとの指定を止める", () => {
  for (const cmd of [
    "git add -A",
    "git add .",
    "git add --all",
    "git add :/",
    "git status --short && git add -A",
    "git -C /some/dir add -A",
  ]) {
    assert.equal(guard.isBlockedAdd(cmd), true, cmd);
  }
});

test("isBlockedAdd: パス指定・対話・dry-run は通す", () => {
  for (const cmd of [
    "git add src/foo.ts",
    "git add src/ docs/",
    "git add -p",
    "git add -A --dry-run",
    "git add -n -A",
    "git commit -- src/x.ts",
    "git status --short",
  ]) {
    assert.equal(guard.isBlockedAdd(cmd), false, cmd);
  }
});

// ---------------------------------------------------------------------------
// R4: 対象の拡張
// ---------------------------------------------------------------------------
test("R4: git commit -a / -am / --all を止める", () => {
  for (const cmd of ["git commit -a", 'git commit -am "x"', "git commit --all -m x", "git commit -ma x"]) {
    assert.equal(guard.isBlockedCommitAll(cmd), true, cmd);
  }
  for (const cmd of ["git commit -m x", "git commit -- src/a.ts", "git commit --amend", "git commit"]) {
    assert.equal(guard.isBlockedCommitAll(cmd), false, cmd);
  }
});

test("R4: 退避する形の git stash を止め、読み出し・復元は通す", () => {
  for (const cmd of ["git stash", "git stash push", "git stash -u", "git stash save wip"]) {
    assert.equal(guard.isBlockedStash(cmd), true, cmd);
  }
  for (const cmd of ["git stash list", "git stash show", "git stash pop", "git stash apply", "git stash drop"]) {
    assert.equal(guard.isBlockedStash(cmd), false, cmd);
  }
});

test("R4: 範囲指定なしの破棄を止める", () => {
  for (const cmd of [
    "git checkout -- .",
    "git restore .",
    "git restore --staged .",
    "git clean -fd",
    "git clean -fdx",
  ]) {
    assert.equal(guard.isBlockedDiscard(cmd), true, cmd);
  }
  for (const cmd of [
    "git checkout -- src/x.ts",
    "git restore src/x.ts",
    "git checkout master",
    "git switch master",
    "git clean -fd tests/",
    "git clean -n",
  ]) {
    assert.equal(guard.isBlockedDiscard(cmd), false, cmd);
  }
});

test("R4: パス指定なしの commit は deny せず警告の対象にする", () => {
  // レビューが唯一「deny にしない」と明示した提案。`git add <path>` の直後など
  // 正当な使い方があるため。**deny 判定には入れないこと。**
  assert.equal(guard.isUnscopedCommit("git commit -m x"), true);
  assert.equal(guard.isBlockedCommitAll("git commit -m x"), false, "deny 側に入れない");

  assert.equal(guard.isUnscopedCommit("git commit -- src/a.ts"), false, "パス指定あり");
  assert.equal(guard.isUnscopedCommit("git commit --amend"), false, "amend は対象外");
  assert.equal(guard.isUnscopedCommit("git commit -am x"), false, "-a は deny 側で扱う");
});

// ---------------------------------------------------------------------------
// git push の対象ディレクトリ解決
// ---------------------------------------------------------------------------
test("resolveTargetDir: cd は push より前の最後の1つを採る", () => {
  const a = ROOT;
  const b = path.join(ROOT, "plugins");
  const at = (c) => guard.findPush(c);

  const cmd = `cd ${a} && echo x && cd ${b} && git push`;
  assert.equal(
    path.resolve(guard.resolveTargetDir(cmd, at(cmd))),
    path.resolve(b),
    "最後の cd を採ること"
  );

  const single = `cd ${b} && git push`;
  assert.equal(path.resolve(guard.resolveTargetDir(single, at(single))), path.resolve(b));

  const viaC = `git -C ${b} push origin master`;
  assert.equal(
    path.resolve(guard.resolveTargetDir(viaC, at(viaC))),
    path.resolve(b),
    "git -C は push 自身に付くので最優先"
  );
});

test("resolveTargetDir: push より後ろの cd は採らない", () => {
  const a = ROOT;
  const b = path.join(ROOT, "plugins");
  const cmd = `cd ${a} && git push && cd ${b}`;
  assert.equal(path.resolve(guard.resolveTargetDir(cmd, guard.findPush(cmd))), path.resolve(a));
});

test("resolveTargetDir: 引用符の中の cd は採らない", () => {
  const b = path.join(ROOT, "plugins");
  const cmd = `echo "cd ${b}" && git push`;
  const got = path.resolve(guard.resolveTargetDir(cmd, guard.findPush(cmd)));
  assert.notEqual(got, path.resolve(b));
});

// ---------------------------------------------------------------------------
// R5: 検査コマンドの有無を、ロケールに依存せず判定する
// ---------------------------------------------------------------------------
test("hasCommand: PATH を自前で走査する（メッセージ照合に頼らない）", () => {
  // `execSync` の失敗メッセージは OS の言語で変わる。日本語 Windows では
  // 「'claude' は、内部コマンドまたは外部コマンド…」となり英語の照合は当たらない。
  // `e.code` も ENOENT にならず `status` は 1（通常の失敗と区別できない）。
  assert.equal(guard.hasCommand("node"), true, "node は PATH にあるはず");
  assert.equal(guard.hasCommand("definitely-not-a-real-command-xyz"), false);
});

test("toNativePath: MSYS の /d/foo を d:/foo に直す", () => {
  assert.equal(guard.toNativePath("/d/Develop/x"), "d:/Develop/x");
  assert.equal(guard.toNativePath('"/c/tmp"'), "c:/tmp");
  assert.equal(guard.toNativePath("D:/already/native"), "D:/already/native");
  assert.equal(guard.toNativePath("relative/path"), "relative/path");
});
