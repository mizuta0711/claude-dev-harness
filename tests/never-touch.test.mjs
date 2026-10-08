import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { isNeverTouch } = await import(
  pathToFileURL(
    path.join(ROOT, "plugins", "harness-core", "skills", "harness-update", "scripts", "harness-diff.mjs")
  ).href
);

// `NEVER_TOUCH` に載ったパスは**追従の対象から外れる**（差分を出さない）。
// ここを間違えると、**プロジェクトが育てたファイルを雛形で無断上書きする**。

test("environment.md は追従しない（プロジェクトが実態を記入する）", () => {
  // 0.25.0 で誤ってハーネス所有と宣言し、Next.js 15.3 のプロジェクトへ
  // 「Next.js 16」と書いた雛形を自動適用した。その再発防止。
  assert.ok(isNeverTouch(".claude/harness/environment.md"));
});

test("core.md は追従する（ハーネスが持つ規律そのもの）", () => {
  assert.ok(!isNeverTouch(".claude/harness/core.md"));
});

test("CLAUDE.md は追従の対象に残る（project-local として保持される）", () => {
  // 除外ではなく分類で守る。除外すると新規プロジェクトへ配れなくなる。
  assert.ok(!isNeverTouch("CLAUDE.md"));
});

test("設計方針層の中身は追従しないが README は追従する", () => {
  assert.ok(isNeverTouch(".claude/01_development_docs/01_architecture.md"));
  assert.ok(!isNeverTouch(".claude/01_development_docs/README.md"));
});

test("似た名前に広がらない", () => {
  assert.ok(!isNeverTouch(".claude/harness/environment.md.bak"));
  assert.ok(!isNeverTouch("docs/.claude/harness/environment.md"));
});
