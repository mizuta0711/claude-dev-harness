import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { mergeJson3, mergeArray3, JSON_MERGE_FILES } = await import(
  pathToFileURL(
    path.join(ROOT, "plugins", "harness-core", "skills", "harness-update", "scripts", "harness-diff.mjs")
  ).href
);

/**
 * `.claude/settings.json` のキー単位3方向マージ（harness-update §0-4b）
 *
 * ## なぜ要るのか
 *
 * テンプレートが配るファイルをプロジェクトも育てるので、`A≠B` かつ `A≠C` かつ `B≠C` が常態になり、
 * **ファイル単位の分類では `conflict` が既定になる**（実測: 導入済み3プロジェクトすべて）。
 * 競合1件につき `harness-update` の Step 3（査読つきの判断手続き）が起動するため、
 * テンプレートを1行直すたびに重い手続きが走っていた。
 *
 * この関数は**所有の境界をファイルからキーへ下げる**。実測では
 * **3プロジェクトすべてが `conflict` → `json-merge`（自動適用可）になった**。
 */

const A = {
  effortLevel: "high",
  enabledPlugins: { "harness-core@dev-harness": true },
  permissions: { allow: ["Read", "Bash(git status:*)"], ask: ["Bash(git push:*)"], deny: ["Bash(rm:*)"] },
};

test("テンプレートが削除したキーは、プロジェクトが触っていなければ消す", () => {
  const B = { effortLevel: "high", permissions: { allow: ["Read", "Bash(git status:*)"], deny: ["Bash(rm:*)"] } };
  const C = structuredClone(A);
  const { merged, conflicts } = mergeJson3(A, B, C);
  assert.deepEqual(conflicts, []);
  assert.ok(!("enabledPlugins" in merged));
  assert.ok(!("ask" in merged.permissions));
});

test("削除されたキーの値が空の入れ物なら、育てた値ではないので消す", () => {
  // 実測（2026-10-08）: 0.18.0 の展開がキーを消さずに空にしていた（"enabledPlugins": {}）。
  // これを育てた値と見なすと3プロジェクトとも永久に競合に残る。
  const B = { effortLevel: "high", permissions: A.permissions };
  const C = { ...structuredClone(A), enabledPlugins: {} };
  const { merged, conflicts } = mergeJson3(A, B, C);
  assert.deepEqual(conflicts, []);
  assert.ok(!("enabledPlugins" in merged));
});

test("削除されたキーに中身があれば、そのキーだけ競合にする（勝手に消さない）", () => {
  const B = { effortLevel: "high", permissions: A.permissions };
  const C = { ...structuredClone(A), enabledPlugins: { "my-own@local": true } };
  const { merged, conflicts } = mergeJson3(A, B, C);
  assert.deepEqual(conflicts, ["enabledPlugins"]);
  assert.deepEqual(merged.enabledPlugins, { "my-own@local": true }); // 消していない
});

test("プロジェクトが育てた値は、テンプレートが触っていなければ保つ", () => {
  const B = structuredClone(A);
  B.effortLevel = "high"; // テンプレートは変えていない
  const C = structuredClone(A);
  C.permissions.allow.push("Bash(npm run build)"); // プロジェクトが足した
  const { merged, conflicts } = mergeJson3(A, B, C);
  assert.deepEqual(conflicts, []);
  assert.ok(merged.permissions.allow.includes("Bash(npm run build)"));
});

test("配列は集合として扱う（消えた要素は消し、増えた要素は足し、独自の要素は残す）", () => {
  const a = ["Read", "Glob", "Bash(old:*)"];
  const b = ["Read", "Glob", "Bash(new:*)"]; // old を消して new を足した
  const c = ["Read", "Glob", "Bash(old:*)", "Bash(mine:*)"]; // プロジェクト独自
  const out = mergeArray3(a, b, c);
  assert.ok(!out.includes("Bash(old:*)"), "テンプレートが消した要素は消える");
  assert.ok(out.includes("Bash(new:*)"), "テンプレートが足した要素は入る");
  assert.ok(out.includes("Bash(mine:*)"), "プロジェクト独自の要素は残る");
});

test("プロジェクトが独自に消した要素を、テンプレートが変えていなければ足し戻さない", () => {
  const a = ["Read", "Glob"];
  const b = ["Read", "Glob"]; // テンプレートは変えていない
  const c = ["Read"]; // プロジェクトが Glob を消した
  assert.deepEqual(mergeArray3(a, b, c), ["Read"]);
});

test("テンプレートが変えたキーを、プロジェクトが既に同じ値にしていたら適用済みとして何もしない", () => {
  const B = { ...structuredClone(A), effortLevel: "medium" };
  const C = { ...structuredClone(A), effortLevel: "medium" };
  const { merged, conflicts } = mergeJson3(A, B, C);
  assert.deepEqual(conflicts, []);
  assert.equal(merged.effortLevel, "medium");
});

test("三者すべて違うスカラーはそのキーだけ競合にする", () => {
  const B = { ...structuredClone(A), effortLevel: "medium" };
  const C = { ...structuredClone(A), effortLevel: "low" };
  const { merged, conflicts } = mergeJson3(A, B, C);
  assert.deepEqual(conflicts, ["effortLevel"]);
  assert.equal(merged.effortLevel, "low"); // 現物を壊さない
});

test("三者すべて違うオブジェクトは1段下へ降りる（それが competing key を狭める要点）", () => {
  // A→B: ask を削除 / A→C: allow を育てた → permissions は三者すべて違うが、降りれば競合ゼロ
  const B = { effortLevel: "high", permissions: { allow: A.permissions.allow, deny: A.permissions.deny } };
  const C = structuredClone(A);
  C.permissions.allow = [...A.permissions.allow, "Bash(npm run dev)"];
  const { merged, conflicts } = mergeJson3(A, B, C);
  assert.deepEqual(conflicts, []);
  assert.ok(!("ask" in merged.permissions));
  assert.ok(merged.permissions.allow.includes("Bash(npm run dev)"));
});

test("キーの順序の違いは差分として数えない", () => {
  const B = { permissions: { deny: ["Bash(rm:*)"], allow: ["Read"] }, effortLevel: "high" };
  const C = { effortLevel: "high", permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] } };
  const Aa = { effortLevel: "high", permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] } };
  const { conflicts } = mergeJson3(Aa, B, C);
  assert.deepEqual(conflicts, []);
});

test("対象ファイルの一覧は settings.json だけ（増やすときは配列の順序依存を確かめる）", () => {
  assert.deepEqual([...JSON_MERGE_FILES], [".claude/settings.json"]);
});
