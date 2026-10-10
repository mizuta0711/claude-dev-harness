import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { tryTextMerge, lineChanges, TEXT_MERGE_FILES } = await import(
  pathToFileURL(
    path.join(ROOT, "plugins", "harness-core", "skills", "harness-update", "scripts", "harness-diff.mjs")
  ).href
);

/**
 * `.gitignore` の行単位3方向マージ（harness-update §0-4c）
 *
 * ## なぜ自前で行をマージしないのか
 *
 * `.gitignore` は**後の行が勝つ**（`*.log` の後の `!keep.log`）。
 * 集合として足し引きして末尾へ足すと、**テンプレートが足した無視パターンが
 * プロジェクトの打ち消しを上書きしてしまう**。順序を保つ3方向マージは git が持っているので、
 * `git merge-file` に任せている。**ここで守るのは「任せ方」である。**
 */

const NL = String.fromCharCode(10);
const withWork = (fn) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "h53-text-"));
  try {
    return fn(work);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
};

test("テンプレートが足した行を、元の節の中へ入れる（末尾へ流さない）", () =>
  withWork((work) => {
    const A = ["# 秘密", ".env*", "", "# OS", ".DS_Store"].join(NL) + NL;
    const B = ["# 秘密", ".env*", "secrets/", "", "# OS", ".DS_Store"].join(NL) + NL;
    const C = ["# 秘密", ".env*", "", "# OS", ".DS_Store", "", "# 独自", "dist/"].join(NL) + NL;
    const v = tryTextMerge(".gitignore", A, B, C, work);
    assert.equal(v.kind, "auto-merge");
    assert.equal(v.how, "text");
    const merged = fs.readFileSync(path.join(work, "merged", ".gitignore"), "utf-8");
    const lines = merged.split(NL);
    // secrets/ は .env* の直後（「秘密」の節の中）に入る
    assert.equal(lines[2], "secrets/");
    // プロジェクト独自の行は残る
    assert.ok(merged.includes("dist/"));
  }));

test("打ち消し（`!`）の順序を壊さない", () =>
  withWork((work) => {
    // プロジェクトが `!keep.log` で打ち消している。テンプレートが別の節に行を足す。
    const A = ["*.log", "", "# OS", ".DS_Store"].join(NL) + NL;
    const B = ["*.log", "", "# OS", ".DS_Store", "Thumbs.db"].join(NL) + NL;
    const C = ["*.log", "!keep.log", "", "# OS", ".DS_Store"].join(NL) + NL;
    const v = tryTextMerge(".gitignore", A, B, C, work);
    assert.equal(v.kind, "auto-merge");
    const lines = fs.readFileSync(path.join(work, "merged", ".gitignore"), "utf-8").split(NL);
    // `!keep.log` は `*.log` の後ろのまま（打ち消しが効く位置）
    assert.equal(lines.indexOf("!keep.log"), lines.indexOf("*.log") + 1);
    // 足された行は OS の節の中（打ち消しより後ろへ回り込んでいない）
    assert.ok(lines.indexOf("Thumbs.db") > lines.indexOf("!keep.log"));
  }));

test("テンプレートが消した行は消える", () =>
  withWork((work) => {
    const A = ["a", "b", "c"].join(NL) + NL;
    const B = ["a", "c"].join(NL) + NL;
    const C = ["a", "b", "c", "mine"].join(NL) + NL;
    const v = tryTextMerge(".gitignore", A, B, C, work);
    assert.equal(v.kind, "auto-merge");
    const merged = fs.readFileSync(path.join(work, "merged", ".gitignore"), "utf-8");
    assert.ok(!merged.split(NL).includes("b"));
    assert.ok(merged.split(NL).includes("mine"));
  }));

test("同じ行を両方が別々に変えたら衝突にする（自動適用しない）", () =>
  withWork((work) => {
    const A = ["x", "target", "y"].join(NL) + NL;
    const B = ["x", "template-side", "y"].join(NL) + NL;
    const C = ["x", "project-side", "y"].join(NL) + NL;
    const v = tryTextMerge(".gitignore", A, B, C, work);
    assert.equal(v.kind, "conflict");
    assert.match(v.note, /行の衝突が 1 箇所/);
    // 衝突したときは統合結果を書かない（マーカー入りのファイルを配らない）
    assert.ok(!fs.existsSync(path.join(work, "merged", ".gitignore")));
  }));

test("テンプレートの変更が既に入っていれば already-applied", () =>
  withWork((work) => {
    const A = ["a"].join(NL) + NL;
    const B = ["a", "b"].join(NL) + NL;
    const C = ["a", "b"].join(NL) + NL;
    assert.equal(tryTextMerge(".gitignore", A, B, C, work).kind, "already-applied");
  }));

test("note に行の増減が載る（自動適用の説明責任）", () =>
  withWork((work) => {
    const A = ["a", "", "# 末尾の節", "z"].join(NL) + NL;
    const B = ["a", "b", "", "# 末尾の節", "z"].join(NL) + NL;
    const C = ["a", "", "# 末尾の節", "z", "mine"].join(NL) + NL;
    const v = tryTextMerge(".gitignore", A, B, C, work);
    assert.equal(v.kind, "auto-merge");
    assert.deepEqual(v.changes.added, ["b"]);
    assert.deepEqual(v.changes.deleted, []);
    assert.match(v.note, /追加: b/);
  }));

test("⚠️ 両方がファイルの末尾に足すと衝突する（これが正しい挙動）", () =>
  withWork((work) => {
    // git merge-file は「同じ位置への別々の追加」を衝突として扱う。**勝手に並べない方が安全**。
    // 実務上の含み: **テンプレート側は `.gitignore` の末尾に足さず、節の中に足す。**
    // 末尾に足すと、末尾へ足しているプロジェクトすべてが競合になる（templates/README.md に明記）。
    const v = tryTextMerge(".gitignore", "a" + NL, "a" + NL + "b" + NL, "a" + NL + "mine" + NL, work);
    assert.equal(v.kind, "conflict");
    assert.match(v.note, /行の衝突が 1 箇所/);
  }));

test("⚠️ 同じ行の再掲を見落とさない（集合ではなく出現回数で数える）", () =>
  withWork((work) => {
    // `!.env.example` の後ろに `.env*` が足されると `.env.example` が無視対象に変わる。
    // 集合で比べると「その行は既にある」ので増分として報告されず、黙って適用されていた（査読で再現）。
    const A = [".env*", "!.env.example", "", "# OS", ".DS_Store"].join(NL) + NL;
    const B = [".env*", "!.env.example", "", "# OS", ".DS_Store", "", "# 追加節", ".env*"].join(NL) + NL;
    const C = [".env*", "!.env.example", "", "# OS", ".DS_Store"].join(NL) + NL;
    const v = tryTextMerge(".gitignore", A, B, C, work);
    assert.equal(v.kind, "auto-merge");
    assert.ok(v.changes.added.includes(".env*"), `再掲が報告されていない: ${v.note}`);
    assert.match(v.note, /\.env\*/);
  }));

test("増減が無いのに中身が違う（並べ替えだけ）なら自動適用しない", () =>
  withWork((work) => {
    const A = ["*.log", "!keep.log"].join(NL) + NL;
    const B = ["!keep.log", "*.log"].join(NL) + NL;
    const C = ["*.log", "!keep.log"].join(NL) + NL;
    const v = tryTextMerge(".gitignore", A, B, C, work);
    assert.equal(v.kind, "conflict");
  }));

test("lineChanges は出現回数で数える", () => {
  const c = lineChanges(["a", "b"].join(NL), ["a", "b", "b"].join(NL));
  assert.deepEqual(c.added, ["b"]);
  assert.deepEqual(c.deleted, []);
});

test("lineChanges は空行と前後の空白を数えない", () => {
  const c = lineChanges(["a", "", "  b  "].join(NL), ["a", "b", "", "c"].join(NL));
  assert.deepEqual(c.added, ["c"]);
  assert.deepEqual(c.deleted, []);
});

test("対象ファイルの一覧は明示する（増やすときは順序依存を確かめる）", () => {
  // **この検査は門である。** 行の意味が順序に依存するファイルだけを入れること。
  //   .gitignore     … 後の行が前を打ち消す
  //   docs/backlog.md … 行の順序が優先順位そのもの
  // どちらも `git merge-file` が位置を保つので通る（下の実測テスト）。
  // 衝突したら自動適用せず `conflict` のまま人へ返すので、壊れ方は安全側。
  assert.deepEqual([...TEXT_MERGE_FILES], [".gitignore", "docs/backlog.md"]);
});

test("一時ファイルを残さない", () =>
  withWork((work) => {
    tryTextMerge(".gitignore", "a" + NL, "a" + NL + "b" + NL, "a" + NL, work);
    assert.ok(!fs.existsSync(path.join(work, "merged", ".3way")), "3way の一時ディレクトリが残っている");
  }));

// ---- 台帳（docs/backlog.md）も行単位でマージする（0.30.0・査読 F16） ----
//
// テンプレートが骨格を配り、**プロジェクトが行を足して育てる**ファイル。
// 行が1本でも入ると A≠B かつ A≠C になり `conflict` が既定になり、
// **競合解決でテンプレート側を採ると残作業の行が丸ごと消える**（生きた台帳なので実害が大きい）。

test("台帳は行単位マージの対象に入っている", () => {
  assert.ok(TEXT_MERGE_FILES.has("docs/backlog.md"));
});

test("骨格の見出しを改名しても、プロジェクトが足した行は残る", () =>
  withWork((work) => {
    const head = (h) => ["# 残作業（backlog）", "", h, "", "| # | やること | 狙い | 設計書 |", "|---|---|---|---|"];
    const A = [...head("## マイルストーン（この順で進める）"), "| | | | |", "", "## 残作業"].join(NL) + NL;
    const B = [...head("## 計画（この順で進める）"), "| | | | |", "", "## 残作業"].join(NL) + NL;
    // プロジェクトは骨格のまま行を足している
    const C =
      [...head("## マイルストーン（この順で進める）"), "| 1 | 一覧画面 | 出る | `a.md` |", "", "## 残作業"].join(NL) +
      NL;

    const v = tryTextMerge("docs/backlog.md", A, B, C, work);
    assert.equal(v.kind, "auto-merge");
    const merged = fs.readFileSync(path.join(work, "merged", "docs", "backlog.md"), "utf-8");
    assert.ok(merged.includes("## 計画（この順で進める）"), "骨格の改名が入っていない");
    assert.ok(merged.includes("| 1 | 一覧画面 | 出る | `a.md` |"), "プロジェクトの行が消えた");
    assert.ok(!merged.includes("マイルストーン"), "旧い見出しが残っている");
  }));

/**
 * 衝突の「どこが」（H53-c）
 *
 * **「2箇所で衝突した」だけでは、人は現物のどこを見ればよいか分からない。**
 * 行番号と現物側の手がかりを note に載せる。**人が読む文面なので、ここで形を固定する。**
 */

test("衝突の note に、行番号と現物側の手がかりが入る", () =>
  withWork((work) => {
    const A = ["*.log", "", "# OS", ".DS_Store"].join(NL) + NL;
    // 同じ行をテンプレートとプロジェクトが別々に書き換える（＝衝突する）
    const B = ["*.log", "", "# OS", "Thumbs.db"].join(NL) + NL;
    const C = ["*.log", "", "# OS", ".DS_Store_project"].join(NL) + NL;
    const v = tryTextMerge(".gitignore", A, B, C, work);
    assert.equal(v.kind, "conflict");
    assert.match(v.note, /行の衝突が 1 箇所/);
    assert.match(v.note, /現物の \d+ 行目付近/, `場所が入っていない: ${v.note}`);
    // 手がかりは**現物側**の行（<<<<<<< の直後）であること
    assert.match(v.note, /\.DS_Store_project/, `現物側の手がかりが入っていない: ${v.note}`);
    assert.ok(!/Thumbs\.db/.test(v.note), `テンプレート側の行を現物として見せている: ${v.note}`);
  }));

test("衝突が複数あれば、場所を並べて出す", () =>
  withWork((work) => {
    // **離して置く。** 近いと git は1つのハンクにまとめてしまう（実測）
    const pad = (from) => Array.from({ length: 10 }, (_, i) => `line${from + i}`);
    const base = ["a", "b", ...pad(1), "f", "g"];
    const A = base.join(NL) + NL;
    const B = ["a", "B2", ...pad(1), "F2", "g"].join(NL) + NL;
    const C = ["a", "B3", ...pad(1), "F3", "g"].join(NL) + NL;
    const v = tryTextMerge(".gitignore", A, B, C, work);
    assert.equal(v.kind, "conflict");
    assert.match(v.note, /行の衝突が 2 箇所/);
    const places = v.note.match(/\d+ 行目付近/g) || [];
    assert.equal(places.length, 2, `場所が2つ出ていない: ${v.note}`);
    assert.match(v.note, /B3/);
    assert.match(v.note, /F3/);
  }));

test("行番号はマーカー行を数に入れない（現物を開いたときの位置に合わせる）", () =>
  withWork((work) => {
    // 7行目だけが衝突する
    const base = ["1", "2", "3", "4", "5", "6", "x", "8"];
    const A = base.join(NL) + NL;
    const B = [...base.slice(0, 6), "tmpl", "8"].join(NL) + NL;
    const C = [...base.slice(0, 6), "proj", "8"].join(NL) + NL;
    const v = tryTextMerge(".gitignore", A, B, C, work);
    assert.equal(v.kind, "conflict");
    // マーカー（<<<<<<< / ======= / >>>>>>>）を数えていれば 8 以上になる
    const n = Number((v.note.match(/(\d+) 行目付近/) || [])[1]);
    assert.equal(n, 7, `行番号がずれている（マーカーを数えている可能性）: ${v.note}`);
  }));

test("現物側が空の衝突で、テンプレート側の行を手がかりに出さない", () =>
  withWork((work) => {
    // プロジェクトは行を消し、テンプレートは同じ行を書き換えた（＝現物側が空のハンク）
    const A = ["keep", "old", "tail"].join(NL) + NL;
    const B = ["keep", "tmplonly", "tail"].join(NL) + NL;
    const C = ["keep", "tail"].join(NL) + NL;
    const v = tryTextMerge(".gitignore", A, B, C, work);
    assert.equal(v.kind, "conflict");
    assert.ok(
      !/tmplonly/.test(v.note),
      `テンプレート側の行を現物の手がかりとして出している: ${v.note}`
    );
    assert.match(v.note, /行目付近/, `場所が出ていない: ${v.note}`);
  }));
