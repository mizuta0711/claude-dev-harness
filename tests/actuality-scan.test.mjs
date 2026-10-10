import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scan = require(path.join(ROOT, "plugins", "harness-core", "hooks", "scripts", "actuality-scan.js"));

// **常時読まれる指示に実態（件数・日付）を書くのを捕まえる**（H23）。
//
// **この判定は実物で較正してある。** 指示書 §3-5 の表を字面どおり正規表現にした初版は
// テンプレートの指示文書に **56行**当たり、ほぼ全部が誤検出だった ——
// 「1箇所に集約する」「最大5ファイル」「1行残す」のように、**数は方針の言い方として
// 日常的に出てくる**。実態と方針を分けるのは「数」ではなく「存在を述べているか」である。
//
// **鳴りすぎる安全弁は外される**（R3）。だから**誤検出を削る方へ倒してあり、取りこぼしはある**。

test("実態（日付つきの但し書き）を捕まえる", () => {
  for (const line of [
    "2026-08-16 時点の構成はこうなっている",
    "2026/08/16 現在の一覧",
    "2026-08-16 の棚卸しで確認した",
  ]) {
    assert.ok(scan.scanLine(line).length, line);
  }
});

test("実態（存在の件数）を捕まえる", () => {
  for (const line of [
    "`src/components/ui/` の **26本すべてが kebab-case**",
    "domain が Android SDK に依存している箇所が 22箇所ある",
    "`x:Key=\"Spacing*\"` は0件",
    "12箇所で違反している",
  ]) {
    assert.ok(scan.scanLine(line).length, line);
  }
});

test("方針の言い方では鳴らない（ここが最重要）", () => {
  // **実物に当てて残った誤検出をすべてここに置いてある。**
  // 1件でも鳴ると、棚卸しのたびにノイズが出て安全弁ごと外される。
  for (const line of [
    "- **画面やリポジトリのコンストラクタで `new` しない。** 生成場所を1箇所に決める",
    "- キー定義は1箇所に集約する",
    "- 一度に編集するファイルは最大5ファイル。段階的にビルド確認する",
    "**目安は1ファイル200行**",
    "- **N+1 クエリを作らない。** ループ内で1件ずつ取得せず、`include` でまとめて取得する",
    "同じ情報を2箇所に書かない",
    "「ブランチ `<名前>` を作成した」の1行を必ず入れ",
    "`01_app_architecture.md`（同梱）**1本で足りることが多い**",
    "**受け入れ基準が独立に確認できる塊に2つ以上に分かれるなら、1本の設計書に収めない**",
    "採用しなかった理由も1行ずつ残すと後で効く",
    "`.kt` を1本触るだけで層の規約が全部ロードされる",
    "この2行を消すとハーネスの規律が全部読まれなくなる",
  ]) {
    assert.deepEqual(scan.scanLine(line), [], line);
  }
});

test("改訂履歴の行は除外する（変更内容の説明であって実態ではない）", () => {
  for (const line of [
    "| 1.2 | 2026-08-16 | 6→7値に増えた（3箇所） |",
    "| **3.15** | 2026-10-10 | 12ファイル34行を削除した |",
  ]) {
    assert.deepEqual(scan.scanLine(line), [], line);
  }
});

test("引用と HTML コメントは除外する", () => {
  // 引用は**実測の根拠**。指示書 §3-5 自身が「件数を書くなら数えた範囲を併記する」と認めている。
  // HTML コメントは**書く人への注記**で、読ませる指示ではない。
  for (const line of [
    "> **実測（2026-08-17）**: ある文書が「窓」を14箇所で使っていた",
    "> 2026-08-16 時点では0件だった",
    "<!-- TODO: 2026-08-16 時点の構成に合わせる -->",
  ]) {
    assert.deepEqual(scan.scanLine(line), [], line);
  }
});

test("検査するのは常時読まれる指示だけ（`docs/` は対象外）", () => {
  // `docs/reviews/` の実測記録は**件数を書くのが正しい**。同じ基準を当ててはいけない。
  assert.ok(scan.isWatchedPath("CLAUDE.md"));
  assert.ok(scan.isWatchedPath("constitution.md"));
  assert.ok(scan.isWatchedPath(".claude/rules/api.md"));
  assert.ok(scan.isWatchedPath(".claude/harness/core.md"));
  assert.ok(!scan.isWatchedPath("docs/reviews/20261010_x.md"));
  assert.ok(!scan.isWatchedPath("docs/backlog.md"));
  assert.ok(!scan.isWatchedPath(".claude/settings.json")); // .md だけ
  assert.ok(!scan.isWatchedPath("src/app/page.tsx"));
});

test("diff の追加行だけを見る（消す側ではなく書き直す側が目的）", () => {
  const diff = [
    "diff --git a/.claude/rules/x.md b/.claude/rules/x.md",
    "--- a/.claude/rules/x.md",
    "+++ b/.claude/rules/x.md",
    "@@ -1 +1 @@",
    "-2026-01-01 時点の古い記述",          // 消す側は見ない
    "+2026-08-16 の棚卸しで確認した",        // 書き直す側を見る
    "diff --git a/docs/reviews/r.md b/docs/reviews/r.md",
    "--- a/docs/reviews/r.md",
    "+++ b/docs/reviews/r.md",
    "@@ -0,0 +1 @@",
    "+2026-08-16 時点で12箇所ある",         // docs/ は対象外
  ].join("\n");
  const hits = scan.scanDiff(diff);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, ".claude/rules/x.md");
  assert.match(hits[0].line, /棚卸しで確認/);
});

test("新規ファイルの追加行も見る", () => {
  const diff = [
    "diff --git a/.claude/rules/new.md b/.claude/rules/new.md",
    "--- /dev/null",
    "+++ b/.claude/rules/new.md",
    "@@ -0,0 +1 @@",
    "+いま `Spacing*` は0件",
  ].join("\n");
  assert.equal(scan.scanDiff(diff).length, 1);
});

test("削除されたファイルで取り違えない（`+++ /dev/null`）", () => {
  const diff = [
    "diff --git a/.claude/rules/gone.md b/.claude/rules/gone.md",
    "--- a/.claude/rules/gone.md",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-2026-08-16 時点",
  ].join("\n");
  assert.deepEqual(scan.scanDiff(diff), []);
});

// ---- 配っているテンプレート自身に当てる（鳴りすぎを機械で押さえる） ----

test("テンプレートの指示文書に当てて、鳴る行が3行を超えない", () => {
  // **この検査自身が鳴りすぎていないかを、配り物で測る。**
  // 初版は 56行に当たった。較正後は2行（うち1件は本物の実態 ——
  // `templates/nextjs/.claude/rules/typescript.md` の「26本すべてが kebab-case」）。
  // **閾値を緩めたくなったら、それは判定が粗いという合図である。**
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else out.push(full);
    }
    return out;
  };
  const hits = [];
  for (const file of walk(path.join(ROOT, "templates"))) {
    if (!file.endsWith(".md")) continue;
    const rel = file.split(path.sep).join("/").replace(/^.*\/templates\/[^/]+\//, "");
    if (!scan.isWatchedPath(rel)) continue;
    fs.readFileSync(file, "utf-8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (scan.scanLine(line).length) hits.push(`${rel}:${i + 1} ${line.trim().slice(0, 80)}`);
      });
  }
  assert.ok(hits.length <= 3, `鳴りすぎている（${hits.length}行）:\n${hits.join("\n")}`);
});
