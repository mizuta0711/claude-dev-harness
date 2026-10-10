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

test("現物にマーカーが無ければ統合せず、理由を no-begin で返す（＝移行）", () =>
  withWork((work) => {
    const B = doc(["## 1. 規模ゲート"], []);
    const C = ["# 不変原則", "", "## 1. 規模ゲート", "", "## 9. 固有", "- 独自"].join(NL) + NL;
    assert.equal(tryMarkerMerge("constitution.md", B, C, work), null);
    assert.equal(splitByMarker(C).reason, "no-begin");
    assert.ok(!splitByMarker(B).reason, "テンプレート側の分割に失敗している");
  }));

test("end が無い壊れた現物は no-end（`begin` を足せという案内にしないため）", () =>
  withWork((work) => {
    const broken = ["# 不変原則", BEGIN, "## 1. 規模ゲート"].join(NL) + NL;
    assert.equal(splitByMarker(broken).reason, "no-end");
    assert.equal(tryMarkerMerge("constitution.md", doc(["## 1."], []), broken, work), null);
  }));

test("end が begin より前にあっても、境界と見なさない", () => {
  const reversed = ["# 不変原則", END, "## 1.", BEGIN].join(NL) + NL;
  // `begin` の後ろに `end` が無いので no-end
  assert.equal(splitByMarker(reversed).reason, "no-end");
});

test("マーカーが2組以上あれば統合しない（例示が本物を凍結させる事故を止める）", () =>
  withWork((work) => {
    // 前書きに移行手順を書き写した現物（例示が1組目になる）
    const C =
      [
        "# 不変原則",
        "> 例示:",
        "```markdown",
        BEGIN,
        "（中身）",
        END,
        "```",
        BEGIN,
        "## 1. 旧",
        END,
        "",
        "## 9. 固有",
        "- 独自",
      ].join(NL) + NL;
    assert.equal(splitByMarker(C).reason, "multiple");
    assert.equal(
      tryMarkerMerge("constitution.md", doc(["## 1. 新"], []), C, work),
      null,
      "例示を境界として統合している（本物の節が凍結する）"
    );
  }));

test("マーカーの外だけが違うとき、「同じ変更が既に入っている」と言わない", () =>
  withWork((work) => {
    const owned = ["## 1. 規模ゲート"];
    const B = ["# 不変原則", "", BEGIN, ...owned, END, "", "## 9. 固有", "- テンプレートの雛形"].join(NL) + NL;
    const C = ["# 不変原則", "", BEGIN, ...owned, END, "", "## 9. 固有", "- 独自"].join(NL) + NL;
    const v = tryMarkerMerge("constitution.md", B, C, work);
    assert.equal(v.kind, "already-applied");
    assert.match(v.note, /外は/, `外の違いに触れていない: ${v.note}`);
    assert.ok(
      !/^同じ変更が既に入っている$/.test(v.note),
      `テンプレートの変更が入っていないのに「既に入っている」と言っている: ${v.note}`
    );
  }));

test("インデントされたマーカー・行末の空白でも境界として読む", () => {
  const C = ["# 不変原則", "  " + BEGIN + "  ", "## 1.", "  " + END, "", "## 9."].join(NL) + NL;
  const r = splitByMarker(C);
  assert.ok(!r.reason, `境界として読めていない: ${JSON.stringify(r)}`);
  assert.equal(r.owned.length, 3);
});

test("note は削除と追加を取り違えない（説明責任）", () =>
  withWork((work) => {
    // テンプレートが2行足す（削除は無い）
    const B = doc(["## 1.", "- 新1", "- 新2"], []);
    const C = doc(["## 1."], ["- 独自"]);
    const v = tryMarkerMerge("constitution.md", B, C, work);
    assert.equal(v.kind, "auto-merge");
    assert.match(v.note, /追加 2 行/, `追加が出ていない: ${v.note}`);
    assert.ok(!/削除/.test(v.note), `削除が無いのに削除と言っている: ${v.note}`);
    assert.deepEqual(v.changes.deleted, []);
    assert.equal(v.changes.added.length, 2);
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

/**
 * 実物のテンプレートで一周させる（査読の指摘5）
 *
 * **CHANGELOG に「実物のテンプレートで確認した」と書いたなら、同じものを置く**（`CLAUDE.md` §4）。
 * 合成した短い文書だけでは、**マーカーの位置そのものの誤り**（前書きが外に出ている等）が捕まらない。
 */
test("実物の templates/base/constitution.md で、中が戻り外が残る", () =>
  withWork((work) => {
    const tmplPath = path.join(ROOT, "templates", "base", "constitution.md");
    const B = fs.readFileSync(tmplPath, "utf-8").replace(/\{\{PROJECT_NAME\}\}/g, "demo");

    // **所有の宣言（前書き）はマーカーの中にあること。** 外にあるとハーネスが二度と直せない
    const parts = splitByMarker(B);
    assert.ok(!parts.reason, "実物のテンプレートが分割できない");
    assert.match(
      parts.owned.join(NL),
      /この文書は2つの所有に分かれている/,
      "所有の宣言がマーカーの外にある（ハーネスが以後直せない）"
    );
    assert.match(parts.after.join(NL), /## 9\./, "§9 がマーカーの外に無い");

    // 現物: 中の1行を消し、§9 に独自の原則を書いた
    const C = B.replace(
      "原則どうしが衝突した場合は、**番号の小さい方を優先**する。",
      "（プロジェクトが消した行）"
    ).replace(
      "<!-- TODO: プロジェクト固有の不変原則があれば追記する",
      "- **独自の原則。** 後方互換を壊さない\n\n<!-- TODO: 以下は雛形"
    );
    const v = tryMarkerMerge("constitution.md", B, C, work);
    assert.equal(v.kind, "auto-merge");
    const out = mergedText(work);
    assert.ok(out.includes("原則どうしが衝突した場合は"), "中が戻っていない");
    assert.ok(out.includes("後方互換を壊さない"), "§9 の独自の原則が消えた");
    assert.equal(out.split(NL).length, C.split(NL).length, "行数が変わった");
  }));

test("生成直後のプロジェクト（B と C が同じ）は already-applied", () =>
  withWork((work) => {
    const B = fs.readFileSync(path.join(ROOT, "templates", "base", "constitution.md"), "utf-8");
    const v = tryMarkerMerge("constitution.md", B, B, work);
    assert.equal(v.kind, "already-applied");
    assert.equal(v.note, "同じ変更が既に入っている");
  }));
