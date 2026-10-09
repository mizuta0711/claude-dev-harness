import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bs = require(path.join(ROOT, "plugins", "harness-core", "hooks", "scripts", "backlog-sync.js"));

// 残作業台帳（docs/backlog.md）と docs/features/ の整合を見る判定（H63）。
//
// **この検査は両方向に間違えうる。**
//   - 食い違いを見逃す → 台帳が嘘になり、次に読む人が存在しない設計書を探す
//   - 食い違っていないのに鳴る → push が止まる。**正常な操作で鳴らないことが要件**
// そのため「鳴るべき」と「鳴ってはいけない」を対にして置く。

/** 使い捨てのプロジェクトを作る */
function mkProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-sync-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body ?? "", "utf-8");
  }
  return dir;
}

const PLAN = (rows) =>
  ["# 残作業", "", "## 計画", "", "| # | やること | 狙い | 設計書 |", "|---|---|---|---|", ...rows, ""].join("\n");

test("台帳が無ければ検査しない（0.27.0 より前のプロジェクト）", () => {
  const dir = mkProject({ "docs/features/.gitkeep": "" });
  const r = bs.check(dir);
  assert.equal(r.applicable, false);
  assert.match(r.reason, /backlog\.md/);
});

test("計画節が無ければ検査しない（開発計画層が届いていない）", () => {
  const dir = mkProject({ "docs/backlog.md": "# 残作業\n\n## 残作業\n\n- なにか\n" });
  const r = bs.check(dir);
  assert.equal(r.applicable, false);
  assert.match(r.reason, /計画節/);
});

test("合っていれば0件（正常な操作で鳴らない）", () => {
  const dir = mkProject({
    "docs/backlog.md": PLAN(["| 1 | a | b | `docs/features/20261010_a.md` |"]),
    "docs/features/20261010_a.md": "# a",
  });
  const r = bs.check(dir);
  assert.equal(r.applicable, true);
  assert.deepEqual(r.findings, []);
});

test("検査1: 行が指す設計書が無ければ鳴る", () => {
  const dir = mkProject({
    "docs/backlog.md": PLAN(["| 1 | a | b | `docs/features/20261010_a.md` |"]),
    "docs/features/.gitkeep": "",
  });
  const f = bs.check(dir).findings;
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "missing-doc");
});

test("検査1: 置き場そのものが無い場合は区別する（H62）", () => {
  // `docs/features/planned/` は harness-core 0.31.2 より前のテンプレートでは配られて
  // いなかった。**設計書が無いのではなく置き場が無い**ので、直し方が違う。
  // 実測: appcraft の計画 #3 がこれだった。
  const dir = mkProject({
    "docs/backlog.md": PLAN(["| 3 | a | b | `docs/features/planned/20261010_a.md` |"]),
    "docs/features/.gitkeep": "",
  });
  const f = bs.check(dir).findings;
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "missing-dir");
  assert.match(f[0].how, /harness-update/);
});

test("検査2: 計画節に載っていない設計書で鳴る", () => {
  const dir = mkProject({
    "docs/backlog.md": PLAN(["| 1 | a | b | `docs/features/20261010_a.md` |"]),
    "docs/features/20261010_a.md": "# a",
    "docs/features/20261010_b.md": "# b",
  });
  const f = bs.check(dir).findings;
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "doc-without-row");
  assert.match(f[0].what, /20261010_b/);
});

test("検査2 は `## 計画` のときだけ当てる（`## マイルストーン` は網羅を約束していない）", () => {
  // 0.27.0 より前の形。実測で CommSim 6本・skillup_mock 1本が載っていなかったが、
  // **あれは違反ではなく「あの節が網羅ではない」だけ**。
  // 当てると古いプロジェクトで一斉に鳴り、push が止まる。
  const body = [
    "# 残作業", "", "## マイルストーン", "",
    "| # | やること | 狙い | 設計書 |", "|---|---|---|---|",
    "| 1 | a | b | `docs/features/20261010_a.md` |", "",
  ].join("\n");
  const dir = mkProject({
    "docs/backlog.md": body,
    "docs/features/20261010_a.md": "# a",
    "docs/features/20261010_b.md": "# b", // 載っていないが鳴ってはいけない
  });
  const r = bs.check(dir);
  assert.equal(r.applicable, true);
  assert.deepEqual(r.findings, []);
  // ただし検査1（行が指す設計書が無い）は当たる
  const dir2 = mkProject({ "docs/backlog.md": body, "docs/features/.gitkeep": "" });
  assert.equal(bs.check(dir2).findings[0].kind, "missing-doc");
});

test("検査3: completed/ へ移ったのに行が残っていれば鳴る", () => {
  const dir = mkProject({
    "docs/backlog.md": PLAN(["| 1 | a | b | `docs/features/completed/20261010_a.md` |"]),
    "docs/features/completed/20261010_a.md": "# a",
  });
  const f = bs.check(dir).findings;
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "completed-still-listed");
});

test("pending/ は検査対象にしない（計画節に載らないのが正しい）", () => {
  const dir = mkProject({
    "docs/backlog.md": PLAN(["| 1 | a | b | `docs/features/20261010_a.md` |"]),
    "docs/features/20261010_a.md": "# a",
    "docs/features/pending/20261010_z.md": "# z",
  });
  assert.deepEqual(bs.check(dir).findings, []);
});

test("TEMPLATE.md は設計書ではない", () => {
  // 実測で「計画節に載っていない」と報告してしまった。設計書の雛形を設計書と数えない。
  const dir = mkProject({
    "docs/backlog.md": PLAN(["| 1 | a | b | `docs/features/20261010_a.md` |"]),
    "docs/features/20261010_a.md": "# a",
    "docs/features/TEMPLATE.md": "# 雛形",
  });
  assert.deepEqual(bs.check(dir).findings, []);
});

test("計画節の HTML コメントの中は読まない", () => {
  // あの節の先頭には書き方の説明がコメントで入っており、**例として設計書のパスが書かれている**。
  // 拾うと「存在しない設計書」を報告する誤検出になる。
  const body = [
    "# 残作業", "", "## 計画", "",
    "<!--", "| 1 | 例 | 例 | `docs/features/planned/yyyymmdd_<名前>.md` |", "-->", "",
    "| # | やること | 狙い | 設計書 |", "|---|---|---|---|",
    "| 1 | a | b | `docs/features/20261010_a.md` |", "",
  ].join("\n");
  const dir = mkProject({ "docs/backlog.md": body, "docs/features/20261010_a.md": "# a" });
  assert.deepEqual(bs.check(dir).findings, []);
});

test("行にパスが無ければ鳴る", () => {
  const dir = mkProject({
    "docs/backlog.md": PLAN(["| 1 | a | b | （未定） |"]),
    "docs/features/.gitkeep": "",
  });
  const f = bs.check(dir).findings;
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "row-without-doc");
});

test("見出し行・区切り行を行として数えない", () => {
  const dir = mkProject({
    "docs/backlog.md": PLAN(["| 1 | a | b | `docs/features/20261010_a.md` |"]),
    "docs/features/20261010_a.md": "# a",
  });
  const rows = bs.parsePlanRows(fs.readFileSync(path.join(dir, "docs/backlog.md"), "utf-8"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].num, "1");
});

test("太字の番号（`| **1** |`）も行として読む", () => {
  const dir = mkProject({
    "docs/backlog.md": PLAN(["| **1** | a | b | `docs/features/20261010_a.md` |"]),
    "docs/features/20261010_a.md": "# a",
  });
  assert.deepEqual(bs.check(dir).findings, []);
});

// ---- 査読（0.32.0 の初版）で出た誤検出の回帰 ----

test("`#` が空欄の行も拾う（`new-feature` の既定）", () => {
  // **初版はここで落ちた。** 行の判別を「1列目が数字」にしていたため、
  // `new-feature` が足す単発の行（`#` は空欄と定められている）が**1行も見えず**、
  // 「計画節に載っていない」と誤報告して**正常な push を deny していた**。
  const dir = mkProject({
    "docs/backlog.md": PLAN(["|  | 機能A | 狙い | `docs/features/20261010_a.md` |"]),
    "docs/features/20261010_a.md": "# a",
  });
  assert.deepEqual(bs.check(dir).findings, []);
  // 逆向き: `#` 空欄の行が指す設計書が無ければ、ちゃんと鳴る（初版は鳴らなかった）
  const dir2 = mkProject({
    "docs/backlog.md": PLAN(["|  | 機能A | 狙い | `docs/features/20261010_a.md` |"]),
    "docs/features/.gitkeep": "",
  });
  assert.equal(bs.check(dir2).findings[0].kind, "missing-doc");
});

test("設計書のパスは「設計書」の列からだけ拾う", () => {
  // 行全体の最初の一致を拾っていたため、「やること」に別のパスを書くと取り違えた。
  const dir = mkProject({
    "docs/backlog.md": PLAN([
      "|  | `docs/features/completed/old.md` の続き | 狙い | `docs/features/20261010_a.md` |",
    ]),
    "docs/features/20261010_a.md": "# a",
    "docs/features/completed/old.md": "# old",
  });
  assert.deepEqual(bs.check(dir).findings, []);

  // 設計書の欄が未定なら、他の列にパスがあっても見逃さない
  const dir2 = mkProject({
    "docs/backlog.md": PLAN(["|  | `docs/features/20261010_a.md` の件 | 狙い | （未定） |"]),
    "docs/features/20261010_a.md": "# a",
  });
  const kinds = bs.check(dir2).findings.map((f) => f.kind);
  assert.ok(kinds.includes("row-without-doc"), JSON.stringify(kinds));
});

test("1つのセルに2本のパスがあれば両方拾う", () => {
  const dir = mkProject({
    "docs/backlog.md": PLAN([
      "|  | a | b | `docs/features/20261010_a.md` / `docs/features/20261010_b.md` |",
    ]),
    "docs/features/20261010_a.md": "# a",
    "docs/features/20261010_b.md": "# b",
  });
  assert.deepEqual(bs.check(dir).findings, []);
});

test("README.md も設計書ではない", () => {
  const dir = mkProject({
    "docs/backlog.md": PLAN(["|  | a | b | `docs/features/20261010_a.md` |"]),
    "docs/features/20261010_a.md": "# a",
    "docs/features/README.md": "# 案内",
  });
  assert.deepEqual(bs.check(dir).findings, []);
});

test("1行に閉じと開きが混在する HTML コメントを読み飛ばす", () => {
  // `<!-- a --> <!-- b` は「`-->` を含むから開いていない」ではない。
  const body = [
    "# 残作業", "", "## 計画", "",
    "<!-- 説明 --> <!-- つづき",
    "| 1 | 例 | 例 | `docs/features/planned/例.md` |",
    "-->", "",
    "| # | やること | 狙い | 設計書 |", "|---|---|---|---|",
    "|  | a | b | `docs/features/20261010_a.md` |", "",
  ].join("\n");
  const dir = mkProject({ "docs/backlog.md": body, "docs/features/20261010_a.md": "# a" });
  assert.deepEqual(bs.check(dir).findings, []);
});

test("見出しは「語の直後が行末・空白・括弧」で見る（前方一致でも完全一致でもない）", () => {
  // **完全一致にしたら実物が外れた。** appcraft の見出しは `## 計画（この順で進める）` で、
  // 完全一致版は**計画節を1つも見つけられず、設計書6本すべてを誤報告した**（修正中の再実測で発覚）。
  // 前方一致だと `## 計画の進め方` まで拾う。どちらにも寄せられない。
  const M = bs.matchPlanHeading;
  assert.deepEqual(M("## 計画"), { plan: true, exhaustive: true });
  assert.deepEqual(M("## 計画（この順で進める）"), { plan: true, exhaustive: true });
  assert.deepEqual(M("## マイルストーン"), { plan: true, exhaustive: false });
  assert.deepEqual(M("## マイルストーン（分割）"), { plan: true, exhaustive: false });
  assert.deepEqual(M("## 計画の進め方"), { plan: false, exhaustive: false });
  assert.deepEqual(M("## 残作業"), { plan: false, exhaustive: false });
  // 計画節は `##`。小見出しは拾わない
  assert.deepEqual(M("### 計画"), { plan: false, exhaustive: false });
});

test("括弧つきの見出しでも表を読む（実物の形）", () => {
  const body = [
    "# 残作業", "", "## 計画（この順で進める）", "",
    "| # | やること | 狙い | 設計書 |", "|---|---|---|---|",
    "| 1 | a | b | `docs/features/20261010_a.md` |", "",
  ].join("\n");
  const dir = mkProject({ "docs/backlog.md": body, "docs/features/20261010_a.md": "# a" });
  const r = bs.check(dir);
  assert.equal(r.applicable, true);
  assert.deepEqual(r.findings, []);
  assert.equal(bs.parsePlanRows(body).length, 1);
});

test("`## 計画の進め方` のような別節は計画節ではない", () => {
  const body = [
    "# 残作業", "", "## 計画の進め方", "",
    "| # | やること | 狙い | 設計書 |", "|---|---|---|---|",
    "|  | 例 | 例 | `docs/features/存在しない.md` |", "",
    "## 計画", "",
    "| # | やること | 狙い | 設計書 |", "|---|---|---|---|",
    "|  | a | b | `docs/features/20261010_a.md` |", "",
  ].join("\n");
  const dir = mkProject({ "docs/backlog.md": body, "docs/features/20261010_a.md": "# a" });
  assert.deepEqual(bs.check(dir).findings, []);
});

test("置き場が無いときの案内は、設計書の作成にも触れる", () => {
  // `harness-update` を当てても設計書は生えない。片方だけ案内すると行き止まりになる。
  const dir = mkProject({
    "docs/backlog.md": PLAN(["|  | a | b | `docs/features/planned/20261010_a.md` |"]),
    "docs/features/.gitkeep": "",
  });
  const f = bs.check(dir).findings[0];
  assert.equal(f.kind, "missing-dir");
  assert.match(f.how, /harness-update/);
  assert.match(f.how, /new-feature/);
});
