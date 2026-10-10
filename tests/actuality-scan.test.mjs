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

test("配っているテンプレートの指示文書では1行も鳴らない", () => {
  // **この検査自身が鳴りすぎていないかを、配り物で測る。**
  // 初版は 56行に当たった（判定を字面どおりに作ったため）。
  //
  // **閾値（`<= 3`）で逃げない。** 査読の指摘どおり、閾値だと**後退を見逃す**。
  // **0件でなければ落とす** —— 配り物に実態が1行でもあれば、
  // それを配られた全プロジェクトで鳴り続ける（実測: `01_development_docs/README.md` の
  // 実測の表が5プロジェクトで鳴っていた。引用へ移して解消した）。
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
    for (const h of scan.scanText(fs.readFileSync(file, "utf-8"))) {
      hits.push(`${rel}:${h.lineNo} ${h.line.trim().slice(0, 80)}`);
    }
  }
  assert.deepEqual(hits, [], `配り物に実態が残っている:${hits.join("\n")}`);
});

// ---- 査読（0.33.0 の初版）で出た穴の回帰 ----

test("条件・方針の文では鳴らない（査読 中1）", () => {
  // 初版はこれらで鳴り、**判定が語彙の偶然に依存していた**
  //（「1件ずつ取得せず」は鳴らないのに「1件ずつ使用して」は鳴る、という状態だった）。
  for (const line of [
    "違反は1件でも見つかったら直す",
    "同じ処理が3箇所に残っていたら共通化する",
    "1件でも使用していたら削除しない",
    "3本以上使っているなら抽出する",
    "3ファイル以上に残っていれば",
    "0件になるまで直す",
    "ファイルが 0 件の場合は何もしない",
    "N=0件のとき",
    "1件ずつ使用して",
    "1件ずつ取得せず",
  ]) {
    assert.deepEqual(scan.scanLine(line), [], line);
  }
});

test("取りこぼしていた書き方を捕まえる（査読 中3）", () => {
  // **日本語の文書では「年月日」表記と「現在 N 件」が自然な書き方である。**
  // 元の事故は ISO 日付だったが、次に起きるのは別の書き方かもしれない。
  for (const line of [
    "2026年8月16日時点の構成",
    "2026-08 時点",
    "(2026-08-16 確認済み)",
    "2026-08-16 確認した",
    "現在 14 件",
    "全14ファイルに残っている",
    "全 14 画面で確認済み",
    "26個のファイルがある",
    "hooks は 5本あります",
  ]) {
    assert.ok(scan.scanLine(line).length, line);
  }
});

test("「全N〈単位〉」は単独では鳴らない（査読 低2）", () => {
  // **期待値を変えた。** 初版は裸の「全14ファイル」で鳴らしていたが、
  // 「全5画面を対象にする」「全3ファイルを同時に更新する」のような
  // **方針の言い方で誤報していた**（再査読で指摘）。
  // **存在を述べていれば上の「存在の件数」が拾う**ので、取りこぼしにはならない。
  for (const line of ["全5画面を対象にする", "全3ファイルを同時に更新する。"]) {
    assert.deepEqual(scan.scanLine(line), [], line);
  }
  assert.ok(scan.scanLine("全14ファイルに残っている").length);
});

test("「つ」は単位に入れない（散文でいちばん汎用の助数詞）", () => {
  // 入れると「決まりが3つある」「手作業が1つ残る」のような**方針の説明に当たる**（実測）。
  for (const line of ["そのための決まりが3つある。", "消したかった手作業が1つ残る"]) {
    assert.deepEqual(scan.scanLine(line), [], line);
  }
});

test("`environment.md` は検査しない（あれは実態を書く場所）", () => {
  // H55 で「プロジェクト所有・配り切り」と決めた唯一の常時ファイルで、
  // **スタックの実際の版・構成・固有の注意点を書く場所**である。
  // 実測: WPF の実プロジェクトの「WPF アプリが3本ある」「テストは2本立てで既に存在する」で鳴った。
  assert.ok(!scan.isWatchedPath(".claude/harness/environment.md"));
  assert.ok(scan.isWatchedPath(".claude/harness/core.md"));
});

test("複数行の HTML コメントとコードフェンスの中身は検査しない（査読 中2）", () => {
  // `scanLine` は1行しか見ないので、**範囲を追うには本文を読む必要がある**。
  // `git diff -U0` には文脈が無い。
  const text = [
    "<!--",
    "3箇所すべてがこうなっている",   // コメントの中
    "-->",
    "```bash",
    "0件のとき",                      // フェンスの中
    "```",
    "現在 14 件",                     // ここだけ鳴る
  ].join("\n");
  const hits = scan.scanText(text);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].lineNo, 7);
});

test("scanText は行番号を返す（警告でどこを直すか示すため）", () => {
  const hits = scan.scanText(["方針の行", "現在 14 件"].join("\n"));
  assert.equal(hits[0].lineNo, 2);
});


