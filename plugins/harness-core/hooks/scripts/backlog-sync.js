/**
 * 残作業台帳（`docs/backlog.md`）と機能設計書（`docs/features/`）の整合を判定する。
 *
 * **「台帳」は2つある**（H63 で呼び分けを決めた）。混同しないこと。
 *   - **残作業台帳** … `docs/backlog.md`。ここが見るのはこちら
 *   - **設計書同期台帳** … `docs/設計書/.doc-sync.md`。`pre-push-check` / `update-docs` が見る
 *
 * **なぜ検査が要るか。** 台帳の行を書くのは `new-feature`（1行足す）・
 * `plan-milestones`（順序を置く）・`complete-feature`（行を消す）の3箇所で、
 * **すべて手で書く**。整合を見る仕組みが1つも無かった（`pre-push-check` は
 * 設計書同期台帳しか見ない）。**実測で乖離が出た**（appcraft・2026-10-10:
 * 計画 #3 が指す設計書が存在しなかった）。
 *
 * **判定は純関数にしてある**（`check()`）。フックとスキルの両方が同じ実装を使う。
 */
const fs = require("node:fs");
const path = require("node:path");

/**
 * 計画節の見出し。**2つあり、約束している内容が違う。**
 *
 *   - `## 計画` … harness-core 0.27.0 の開発計画層。
 *     **「設計書を伴う作業はすべてここに1行ある」と宣言している**ので、
 *     載っていない設計書は違反である（検査2）
 *   - `## マイルストーン` … 0.27.0 より前の形。**網羅を約束していない**ので、
 *     検査2 を当てない（当てると古いプロジェクトで一斉に鳴る。
 *     実測: CommSim 6本・skillup_mock 1本が載っていなかったが、
 *     あれは違反ではなく「あの節が網羅ではない」だけ）
 */
const PLAN_HEADINGS = ["## 計画", "## マイルストーン"];
/** 検査2（載っていない設計書を見つける）を当てられる見出し */
const EXHAUSTIVE_HEADING = "## 計画";

/**
 * 設計書ではないファイル。**設計書の雛形を設計書と数えない。**
 * （実測で `docs/features/TEMPLATE.md` を「計画節に載っていない」と報告してしまった）
 */
const NOT_A_FEATURE_DOC = new Set(["TEMPLATE.md"]);

/**
 * 計画節の表から「設計書」の欄のパスを拾う。
 *
 * **HTML コメントの中は読まない。** あの節の先頭には書き方の説明が
 * コメントで入っており、例として設計書のパスが書かれている（拾うと誤検出になる）。
 */
function parsePlanRows(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const rows = [];
  let inPlan = false;
  let inComment = false;

  for (const line of lines) {
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (line.includes("<!--") && !line.includes("-->")) {
      inComment = true;
      continue;
    }
    if (line.startsWith("## ")) {
      inPlan = PLAN_HEADINGS.some((h) => line.startsWith(h));
      continue;
    }
    if (!inPlan) continue;
    if (!line.startsWith("|")) continue;

    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    // 見出し行・区切り行は飛ばす（1列目が番号の行だけを行と見る）
    if (!/^\*{0,2}\d+\*{0,2}$/.test(cells[0])) continue;

    const num = cells[0].replace(/\*/g, "");
    // 設計書の欄は**最後の列**に `docs/features/...md` が入る
    const joined = cells.join(" | ");
    const m = /`?(docs\/features\/[^`|\s]+\.md)`?/.exec(joined);
    rows.push({ num, path: m ? m[1] : null, line });
  }
  return rows;
}

/** `docs/features/` 配下の設計書を置き場ごとに集める */
function collectFeatureDocs(projectDir) {
  const base = path.join(projectDir, "docs", "features");
  const read = (sub) => {
    const dir = sub ? path.join(base, sub) : base;
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md") && !NOT_A_FEATURE_DOC.has(e.name))
        .map((e) => (sub ? `docs/features/${sub}/${e.name}` : `docs/features/${e.name}`));
    } catch {
      return [];
    }
  };
  return {
    active: read(null), // 作業中（直下）
    planned: read("planned"), // 着手前
    completed: read("completed"), // 完了
    // `pending/` は**検査対象にしない** — 「やると決めたが着手しない」置き場で、
    // 計画節に載らないのが正しい（実測: appcraft は2本をここに置いている）。
  };
}

/**
 * 整合を判定する。**設定不在・台帳不在は「検査しない」を返す**（素通りさせる）。
 *
 * @returns {{applicable: boolean, reason?: string, findings: Array}}
 */
function check(projectDir) {
  const backlogPath = path.join(projectDir, "docs", "backlog.md");
  let markdown;
  try {
    markdown = fs.readFileSync(backlogPath, "utf-8");
  } catch {
    // **0.27.0 より前のプロジェクトには残作業台帳が無い。** 無いこと自体は違反ではない。
    return { applicable: false, reason: "docs/backlog.md が無い", findings: [] };
  }

  const planLines = markdown.replace(/\r\n/g, "\n").split("\n");
  const hasPlan = PLAN_HEADINGS.some((h) => planLines.some((l) => l.startsWith(h)));
  const exhaustive = planLines.some((l) => l.startsWith(EXHAUSTIVE_HEADING));
  if (!hasPlan) {
    // **0.27.0 の開発計画層が届いていないプロジェクト。**
    // 計画節が無いのに「行が無い」と言っても直せない。
    return { applicable: false, reason: "残作業台帳に計画節が無い", findings: [] };
  }

  const rows = parsePlanRows(markdown);
  const docs = collectFeatureDocs(projectDir);
  const findings = [];

  // 検査1: 計画節の行が指す設計書が実在するか
  for (const row of rows) {
    if (!row.path) {
      findings.push({
        kind: "row-without-doc",
        what: `計画 #${row.num} に設計書のパスが書かれていない`,
        how: "`docs/features/` 配下のパスを「設計書」の欄に書く。設計書がまだ無いなら `/harness-core:new-feature` で作る。",
      });
      continue;
    }
    if (!fs.existsSync(path.join(projectDir, row.path))) {
      // **置き場だけが無い場合を区別する。** `docs/features/planned/` は
      // harness-core 0.31.2 より前のテンプレートでは配られていなかった（H62）。
      const dir = path.dirname(row.path);
      const dirMissing = !fs.existsSync(path.join(projectDir, dir));
      findings.push({
        kind: dirMissing ? "missing-dir" : "missing-doc",
        what: `計画 #${row.num} が指す ${row.path} が無い`,
        how: dirMissing
          ? `置き場（\`${dir}/\`）そのものが無い。\`/harness-core:harness-update\` で配られる（harness-core 0.31.2 以降）。`
          : "設計書を作る（`/harness-core:new-feature`）か、取り下げたなら計画節の行を消す。**どちらが正かは作業の実態で決まる**。",
      });
    }
  }

  // 検査2: 作業中・着手前の設計書が計画節に載っているか。
  // **`## 計画` のときだけ当てる**（上の `PLAN_HEADINGS` の注記を見ること）。
  const listed = new Set(rows.map((r) => r.path).filter(Boolean));
  for (const doc of exhaustive ? [...docs.active, ...docs.planned] : []) {
    if (!listed.has(doc)) {
      findings.push({
        kind: "doc-without-row",
        what: `${doc} が計画節に載っていない`,
        how: "計画節へ1行足す（`/harness-core:new-feature` が足すはずの行）。着手しないものなら `docs/features/pending/` へ移す。",
      });
    }
  }

  // 検査3: 完了済みの設計書が計画節に残っていないか
  for (const doc of docs.completed) {
    if (listed.has(doc)) {
      findings.push({
        kind: "completed-still-listed",
        what: `${doc} は completed/ にあるのに計画節に残っている`,
        how: "計画節の行を消す（`/harness-core:complete-feature` が消すはずの行）。**完了は行ごと消す**（✅ を積み上げない）。",
      });
    }
  }

  return { applicable: true, findings };
}

module.exports = { check, parsePlanRows, collectFeatureDocs, PLAN_HEADINGS, EXHAUSTIVE_HEADING, NOT_A_FEATURE_DOC };
