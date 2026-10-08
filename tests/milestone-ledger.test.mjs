import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "plugins", "harness-core", "hooks", "scripts", "session-start-context.js");
const NL = String.fromCharCode(10);

/**
 * 台帳（`docs/backlog.md`）の「次のマイルストーン」を SessionStart が出すこと
 *
 * ## なぜ要るのか
 *
 * **台帳は読まれないと意味が無い。** 1つの依頼をマイルストーンに分けると
 * **フェーズ間で必ず区切りが入る**ので、セッションをまたぐと「次は何か」が分からなくなる。
 * 進捗を台帳に書かない設計（書くと腐る）なので、**順序を指すのは台帳だけ**であり、
 * それが起動時に見えないと分割の意味が半分失われる。
 *
 * **台帳が無いプロジェクトでは何も出さない**（fail-open）。これが崩れると、
 * 台帳を持たない既存プロジェクトすべてで毎セッション余計な行が出る。
 */

const runHook = (dir) => {
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ source: "startup" }),
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  return JSON.parse(out).hookSpecificOutput.additionalContext;
};

const withProject = (backlog, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  try {
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    if (backlog !== null) fs.writeFileSync(path.join(dir, "docs", "backlog.md"), backlog, "utf-8");
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const ledger = (rows) =>
  [
    "# 残作業（backlog）",
    "",
    "## マイルストーン（この順で進める）",
    "",
    "| # | マイルストーン | 狙い | 設計書 |",
    "|---|---------------|------|--------|",
    ...rows,
    "",
    "## 残作業",
    "",
    "| # | 内容 | 参照 |",
    "|---|------|------|",
    "| 1 | 別の残作業 | — |",
  ].join(NL) + NL;

test("台帳の先頭のマイルストーンだけを出す", () =>
  withProject(ledger(["| 1 | 初期化 | 通る | `a.md` |", "| 2 | 次のやつ | 動く | `b.md` |"]), (dir) => {
    const ctx = runHook(dir);
    assert.match(ctx, /\[次のマイルストーン\] 1\. 初期化/);
    assert.ok(!ctx.includes("次のやつ"), "2行目まで出している");
  }));

test("ヘッダ行と区切り行を拾わない", () =>
  withProject(ledger(["| 1 | 初期化 | 通る | `a.md` |"]), (dir) => {
    const ctx = runHook(dir);
    assert.ok(!ctx.includes("マイルストーン] マイルストーン"), "表のヘッダを拾っている");
    assert.ok(!/\[次のマイルストーン\] *-+/.test(ctx), "区切り行を拾っている");
  }));

test("表が空なら何も出さない（骨格を配っただけの状態）", () =>
  withProject(ledger(["| | | | |"]), (dir) => {
    assert.ok(!runHook(dir).includes("次のマイルストーン"));
  }));

test("台帳が無ければ何も出さない（fail-open）", () =>
  withProject(null, (dir) => {
    assert.ok(!runHook(dir).includes("次のマイルストーン"));
  }));

test("「マイルストーン」の見出しが無い台帳では何も出さない", () =>
  withProject(
    ["# 残作業（backlog）", "", "## A. 進行中", "", "| # | 作業 |", "|---|------|", "| 1 | なにか |"].join(NL) + NL,
    (dir) => assert.ok(!runHook(dir).includes("次のマイルストーン"))
  ));

test("「残作業」の表の行を、マイルストーンとして拾わない", () =>
  withProject(ledger(["| | | | |"]), (dir) => {
    // マイルストーンの表が空でも、次の見出し以降（残作業）へは降りない
    const ctx = runHook(dir);
    assert.ok(!ctx.includes("別の残作業"), "次の見出しを越えて拾っている");
  }));

// ---------------------------------------------------------------------------
// 査読1（2026-10-08）が実測で落としたパターン
//
// 初版は1列目が `#` かどうかと `/^-+$/` で判定していたため、
// **標準の Markdown で普通に書かれる形で9パターン誤動作した。**
// 走査の起点を「区切り行の直後」にして列の名前と番号の有無から切り離した。
// ---------------------------------------------------------------------------

const ledgerRaw = (headerRow, sepRow, rows) =>
  ["# 残作業（backlog）", "", "## マイルストーン（この順で進める）", "", headerRow, sepRow, ...rows, ""].join(NL) + NL;

for (const [label, sep] of [
  ["左寄せ", "|:--|:---|:---|:---|"],
  ["右寄せ", "|---:|---:|---:|---:|"],
  ["中央寄せ", "|:---:|:---:|:---:|:---:|"],
])
  test(`位置揃えの区切り行を拾わない（${label}）`, () =>
    withProject(ledgerRaw("| # | マイルストーン | 狙い | 設計書 |", sep, ["| 1 | 初期化 | 通る | `a.md` |"]), (dir) => {
      const ctx = runHook(dir);
      assert.match(ctx, /\[次のマイルストーン\] 1\. 初期化/);
      assert.ok(!/[:\-]{2,}/.test(ctx.split("[次のマイルストーン]")[1].split(NL)[0]), "区切り行を出している");
    }));

test("ヘッダの列名が `#` でなくても拾わない", () =>
  withProject(ledgerRaw("| No | やること | 狙い | 設計書 |", "|---|---|---|---|", ["| 1 | 初期化 | 通る | `a.md` |"]), (dir) => {
    const ctx = runHook(dir);
    assert.match(ctx, /1\. 初期化/);
    assert.ok(!ctx.includes("やること"), "ヘッダ行を出している");
  }));

test("番号列が無い表でもヘッダを出さない", () =>
  withProject(ledgerRaw("| マイルストーン | 狙い |", "|---|---|", ["| 初期化 | 通る |"]), (dir) => {
    const ctx = runHook(dir);
    assert.match(ctx, /\[次のマイルストーン\] 初期化/);
    assert.ok(!ctx.includes("狙い"), "ヘッダ行を出している");
  }));

test("コードフェンスの中の書式例を拾わない", () =>
  withProject(
    ["# 残作業", "", "## マイルストーン", "", "```", "| # | 例 |", "|---|---|", "| 1 | 例です |", "```", "", "| # | 本物 |", "|---|---|", "| 1 | 本物です |"].join(NL) + NL,
    (dir) => {
      const ctx = runHook(dir);
      assert.match(ctx, /1\. 本物です/);
      assert.ok(!ctx.includes("例です"), "フェンスの中を拾っている");
    }
  ));

test("HTML コメントの中の書式例を拾わない", () =>
  withProject(
    ["# 残作業", "", "## マイルストーン", "", "<!--", "| # | 例 |", "|---|---|", "| 1 | コメント内 |", "-->", "", "| # | 本物 |", "|---|---|", "| 1 | 本物です |"].join(NL) + NL,
    (dir) => {
      const ctx = runHook(dir);
      assert.match(ctx, /1\. 本物です/);
      assert.ok(!ctx.includes("コメント内"), "コメントの中を拾っている");
    }
  ));

test("見出しが前置修飾されていても拾う", () =>
  withProject(ledgerRaw("| # | マイルストーン |", "|---|---|", ["| 1 | 初期化 |"]).replace("## マイルストーン（この順で進める）", "## 開発マイルストーン"), (dir) => {
    assert.match(runHook(dir), /1\. 初期化/);
  }));

test("見出しから表までが離れていても拾う（行数の上限を置かない）", () =>
  withProject(
    ["# 残作業", "", "## マイルストーン", ...Array(60).fill("説明の行。"), "| # | 名前 |", "|---|---|", "| 1 | 初期化 |"].join(NL) + NL,
    (dir) => assert.match(runHook(dir), /1\. 初期化/)
  ));

test("完了印が残っていたら、それ自体を知らせる", () =>
  withProject(ledgerRaw("| # | マイルストーン |", "|---|---|", ["| 1 | ✅ 済んだやつ |"]), (dir) => {
    // 台帳は進捗を持たない設計なので、**行の削除が唯一の進行信号**。
    // 消し忘れると古い先頭行を出し続けるため、腐りを機械で知らせる。
    assert.match(runHook(dir), /台帳に完了印が残っている/);
  }));

test("表の後ろに別の見出しと表があっても越えない", () =>
  withProject(
    ["# 残作業", "", "## マイルストーン", "", "| # | 名前 |", "|---|---|", "| | |", "", "#### 補足", "", "| # | 別 |", "|---|---|", "| 9 | 関係ない行 |"].join(NL) + NL,
    (dir) => assert.ok(!runHook(dir).includes("関係ない行"))
  ));

test("テンプレートが配る骨格では何も出さない（行が空）", () => {
  const skeleton = fs.readFileSync(path.join(ROOT, "templates", "base", "docs", "backlog.md"), "utf-8");
  withProject(skeleton, (dir) => {
    assert.ok(!runHook(dir).includes("次のマイルストーン"));
  });
});

test("テンプレートの骨格には、腐らせない規約と「マイルストーン」の見出しがある", () => {
  const skeleton = fs.readFileSync(path.join(ROOT, "templates", "base", "docs", "backlog.md"), "utf-8");
  assert.match(skeleton, /^#{1,3}\s*マイルストーン/m, "見出しが無いとフックもスキルも見つけられない");
  assert.match(skeleton, /完了したものは行ごと消す/, "腐らせない規約が無い");
  assert.match(skeleton, /残作業の唯一の正/, "唯一の正の宣言が無い");
});
