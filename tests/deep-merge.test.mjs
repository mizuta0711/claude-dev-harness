import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { deepMerge } = await import(
  pathToFileURL(path.join(ROOT, "tools", "create-project.mjs")).href
);

// `templates/base/.claude/settings.json` と `templates/<env>/...` の合成に使う。
// **配列は連結して重複を落とす**（permissions.allow が代表例）。

test("オブジェクトは再帰的にマージする", () => {
  assert.deepEqual(
    deepMerge({ a: 1, nest: { x: 1, y: 2 } }, { b: 2, nest: { y: 9, z: 3 } }),
    { a: 1, b: 2, nest: { x: 1, y: 9, z: 3 } }
  );
});

test("配列は連結して重複を落とす（順序は base → env）", () => {
  assert.deepEqual(
    deepMerge(["Bash(git add:*)", "Read"], ["Read", "Write"]),
    ["Bash(git add:*)", "Read", "Write"]
  );
});

test("配列内のオブジェクトも中身で重複判定する", () => {
  assert.deepEqual(deepMerge([{ a: 1 }], [{ a: 1 }, { b: 2 }]), [{ a: 1 }, { b: 2 }]);
});

test("型が違えば env で置き換える", () => {
  assert.equal(deepMerge({ a: 1 }, "文字列"), "文字列");
  assert.deepEqual(deepMerge("文字列", { a: 1 }), { a: 1 });
  assert.deepEqual(deepMerge(["x"], { a: 1 }), { a: 1 });
});

test("env が undefined なら base を保つ", () => {
  assert.equal(deepMerge("base", undefined), "base");
  assert.deepEqual(deepMerge({ a: 1 }, undefined), { a: 1 });
});

test("env の null は「消す」ではなく null で上書きする", () => {
  assert.equal(deepMerge({ a: 1 }, null), null);
});

test("base を書き換えない（非破壊）", () => {
  const base = { a: 1, nest: { x: 1 }, list: ["p"] };
  const snapshot = JSON.parse(JSON.stringify(base));
  deepMerge(base, { nest: { y: 2 }, list: ["q"] });
  assert.deepEqual(base, snapshot, "base が変更されている");
});
