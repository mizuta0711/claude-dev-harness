import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { tryMarkerMerge, splitByMarker, MARKER_FILES } = await import(
  pathToFileURL(
    path.join(ROOT, "plugins", "harness-core", "skills", "harness-update", "scripts", "harness-diff.mjs")
  ).href
);

/**
 * 所有マーカーによる追従（§0-4d・H53-b）
 *
 * ## なぜ要るのか
 *
 * `constitution.md` は**テンプレート自身が §9 を用意してプロジェクトに書かせる**ため、
 * **使うほど競合が確定する**（実測・2026-10-11: 導入済み7プロジェクトのうち3つが
 * プロジェクト側の内容を持つ）。**ここで守るのは「外を触らないこと」である。**
 */

const NL = String.fromCharCode(10);
const BEGIN = "<!-- harness:begin ハーネスが所有する -->";
const END = "<!-- harness:end ここから下はプロジェクト -->";
const doc = (owned, project) =>
  ["# 不変原則", "", BEGIN, ...owned, END, "", "## 9. このプロジェクト固有の原則", ...project].join(NL) + NL;

const withWork = (fn) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "h53b-"));
  try {
    return fn(work);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
};
const mergedText = (work) =>
  fs.readFileSync(path.join(work, "merged", "constitution.md"), "utf-8");

test("constitution.md が対象に入っている", () => {
  assert.ok(MARKER_FILES.has("constitution.md"));
});

test("マーカーの中だけを置き換え、外のプロジェクト固有の原則は残す", () =>
  withWork((work) => {
    const B = doc(["## 1. 規模ゲート", "- 新しい規律"], ["<!-- TODO -->"]);
    const C = doc(["## 1. 規模ゲート"], ["- **独自の原則。** これは残る"]);
    const v = tryMarkerMerge("constitution.md", B, C, work);
    assert.equal(v.kind, "auto-merge");
    assert.equal(v.how, "marker");
    const out = mergedText(work);
    assert.ok(out.includes("- 新しい規律"), "テンプレートの追加が入っていない");
    assert.ok(out.includes("- **独自の原則。** これは残る"), "プロジェクトの原則が消えた");
    assert.ok(!out.includes("<!-- TODO -->"), "テンプレート側の雛形で外を上書きしている");
  }));

test("プロジェクトがマーカーの中を書き換えていても、テンプレートの内容へ戻す（所有の宣言どおり）", () =>
  withWork((work) => {
    const B = doc(["## 1. 規模ゲート", "- 正しい規律"], []);
    const C = doc(["## 1. 規模ゲート", "- プロジェクトが書き換えた規律"], ["- 独自"]);
    const v = tryMarkerMerge("constitution.md", B, C, work);
    assert.equal(v.kind, "auto-merge");
    const out = mergedText(work);
    assert.ok(out.includes("- 正しい規律"));
    assert.ok(!out.includes("プロジェクトが書き換えた規律"), "中が残っている（所有が守られていない）");
    assert.ok(out.includes("- 独自"), "外が消えた");
  }));

test("中身が同じなら already-applied（無駄な書き込みをしない）", () =>
  withWork((work) => {
    const owned = ["## 1. 規模ゲート"];
    const v = tryMarkerMerge("constitution.md", doc(owned, ["x"]), doc(owned, ["y"]), work);
    assert.equal(v.kind, "already-applied");
  }));

test("現物にマーカーが無ければ null を返す（呼び出し側が移行の案内へ落とす）", () =>
  withWork((work) => {
    const B = doc(["## 1. 規模ゲート"], []);
    const C = ["# 不変原則", "", "## 1. 規模ゲート", "", "## 9. 固有", "- 独自"].join(NL) + NL;
    assert.equal(tryMarkerMerge("constitution.md", B, C, work), null);
    assert.equal(splitByMarker(C), null);
    assert.ok(splitByMarker(B), "テンプレート側の分割に失敗している");
  }));

test("end が無い壊れた現物でも落ちない（null を返す）", () =>
  withWork((work) => {
    const broken = ["# 不変原則", BEGIN, "## 1. 規模ゲート"].join(NL) + NL;
    assert.equal(splitByMarker(broken), null);
    assert.equal(tryMarkerMerge("constitution.md", doc(["## 1."], []), broken, work), null);
  }));

test("マーカー行そのものもテンプレート側のものを使う（表記が変わっても追従する）", () =>
  withWork((work) => {
    const B = ["# 不変原則", "", "<!-- harness:begin 新しい説明 -->", "## 1.", END, "", "## 9. 固有"].join(NL) + NL;
    const C = doc(["## 1."], ["- 独自"]);
    const v = tryMarkerMerge("constitution.md", B, C, work);
    assert.equal(v.kind, "auto-merge");
    assert.ok(mergedText(work).includes("<!-- harness:begin 新しい説明 -->"));
  }));

test("マーカーの外にある前書きは、プロジェクト側のものを残す", () =>
  withWork((work) => {
    const B = ["# 不変原則", "> テンプレートの前書き", "", BEGIN, "## 1.", END, ""].join(NL) + NL;
    const C = ["# 不変原則", "> このプロジェクトの前書き", "", BEGIN, "## 1.", END, ""].join(NL) + NL;
    const v = tryMarkerMerge("constitution.md", B, C, work);
    // 中身が同じなので already-applied。**外の違いで書き換えに行かないこと**が要点
    assert.equal(v.kind, "already-applied");
  }));
