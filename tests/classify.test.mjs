import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { classify } = await import(
  pathToFileURL(
    path.join(ROOT, "plugins", "harness-core", "skills", "harness-update", "scripts", "harness-diff.mjs")
  ).href
);

// 3点比較。**追従の中核で、壊れると無断上書きになる。**
//   A = baseline コミットでの生成結果（前回適用時のテンプレート）
//   B = 最新コミットでの生成結果（あるべき姿）
//   C = プロジェクトの現物
// 引数は各ファイルのハッシュ（存在しなければ null）。

const kind = (a, b, c) => {
  const r = classify(a, b, c);
  return r === null ? null : r.kind;
};

test("3つとも同じ → unchanged", () => {
  assert.equal(kind("x", "x", "x"), "unchanged");
});

test("テンプレートだけ変わった（A≠B かつ A=C）→ template-improvement", () => {
  assert.equal(kind("x", "y", "x"), "template-improvement");
});

test("プロジェクトだけ変わった（A=B かつ A≠C）→ project-local", () => {
  assert.equal(kind("x", "x", "y"), "project-local");
});

test("両方変わって結果が同じ（B=C）→ already-applied", () => {
  assert.equal(kind("x", "y", "y"), "already-applied");
});

test("両方が別々に変わった → conflict", () => {
  assert.equal(kind("x", "y", "z"), "conflict");
});

test("テンプレートに新規追加（A も C も無い）→ template-improvement", () => {
  assert.equal(kind(null, "y", null), "template-improvement");
});

test("テンプレートから削除された → template-removed", () => {
  assert.equal(kind("x", null, "x"), "template-removed");
});

test("プロジェクト側で削除した（テンプレートは不変）→ project-local", () => {
  assert.equal(kind("x", "x", null), "project-local");
});

test("プロジェクト側で削除したがテンプレートは変わった → conflict", () => {
  assert.equal(kind("x", "y", null), "conflict");
});

test("baseline が無い（A=null）と差分は全て要判断", () => {
  assert.equal(kind(null, "y", "y"), "unchanged", "同一なら unchanged");
  assert.equal(kind(null, "y", "z"), "conflict", "違えば conflict（安全側）");
});

test("B にも C にも無いものは対象外（null を返す）", () => {
  assert.equal(kind("x", null, null), null, "A のみ = 旧テンプレートの残骸");
  assert.equal(kind(null, null, null), null);
  assert.equal(kind(null, null, "x"), null, "テンプレートに無くプロジェクトだけにある新規ファイル");
});
