import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guard = require(path.join(ROOT, ".claude", "hooks", "repo-guard.js"));

// ---------------------------------------------------------------------------
// git add の範囲指定
//
// 元は CHANGELOG「9ケースで判定を確認」としか残っていなかったもの。ここに固定する。
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
    "git add -A --dry-run", // 実際にはステージしない
    "git commit -- src/x.ts",
    "git status --short",
  ]) {
    assert.equal(guard.isBlockedAdd(cmd), false, cmd);
  }
});

// ---------------------------------------------------------------------------
// git push の対象ディレクトリ解決
//
// 2026-08-16 の欠陥: `cd` の「最初の1つ」を採っていたため
// `cd A && ... && cd B && git push` で **A を検査して B へ push** していた。
// ---------------------------------------------------------------------------
test("findPush: push の位置を返す（無ければ -1）", () => {
  assert.equal(guard.findPush("git push origin master"), 0);
  assert.ok(guard.findPush("cd x && git push") > 0);
  assert.equal(guard.findPush("git status"), -1);
  // ⚠️ 引用符の内側でも拾ってしまう。これは R3（誤検知）の既知の欠陥であり、
  //    直したらこのケースを -1 に変えること（**消さずに期待値を変える**）。
  assert.equal(guard.findPush("echo 'git push' # 説明"), 6);
});

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

test("toNativePath: MSYS の /d/foo を d:/foo に直す", () => {
  assert.equal(guard.toNativePath("/d/Develop/x"), "d:/Develop/x");
  assert.equal(guard.toNativePath('"/c/tmp"'), "c:/tmp");
  assert.equal(guard.toNativePath("D:/already/native"), "D:/already/native");
  assert.equal(guard.toNativePath("relative/path"), "relative/path");
});
