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
 * 設計書同期台帳しか見ない）。**実測で乖離が出た**（実プロジェクト・2026-10-10:
 * 計画 #3 が指す設計書が存在しなかった）。
 *
 * **判定は純関数にしてある**（`check()`）。フックとスキルの両方が同じ実装を使う。
 */
const fs = require("node:fs");
const path = require("node:path");

/**
 * 設計書ではないファイル。**設計書の雛形や案内を設計書と数えない。**
 * （実測で `docs/features/TEMPLATE.md` と `docs/features/README.md` を
 * 「計画節に載っていない」と報告してしまった）
 */
const NOT_A_FEATURE_DOC = new Set(["TEMPLATE.md", "README.md"]);

/**
 * 計画節の見出しかを判定する。
 *
 * **前方一致でも完全一致でもいけない。**
 *   - 前方一致だと `## 計画の進め方` のような別節まで計画節として扱う（査読 L4）
 *   - 完全一致だと**実物が外れる** —— 実プロジェクトの見出しは `## 計画（この順で進める）` で、
 *     完全一致にした初版は**計画節を1つも見つけられず、設計書6本すべてを
 *     「計画節に載っていない」と誤報告した**（修正中の再実測で発覚）
 *
 * **見出し語の直後が、行末・空白・括弧・区切り記号**のときだけ計画節と見る。
 *
 * **見出しは2つあり、約束している内容が違う。**
 *   - `## 計画` … harness-core 0.27.0 の開発計画層。
 *     **「設計書を伴う作業はすべてここに1行ある」と宣言している**ので、
 *     載っていない設計書は違反である（検査2）
 *   - `## マイルストーン` … 0.27.0 より前の形。**網羅を約束していない**ので、
 *     検査2 を当てない（当てると古いプロジェクトで一斉に鳴る。
 *     実測: 実プロジェクト2件で 6本・1本が載っていなかったが、
 *     あれは違反ではなく「あの節が網羅ではない」だけ）
 *
 * @returns {{plan: boolean, exhaustive: boolean}} `exhaustive` は「網羅を約束している形」か
 */
function matchPlanHeading(line) {
  const m = /^##\s+(計画|マイルストーン)\s*(?:$|[（(:：・\-—\s])/.exec(line.trim());
  if (!m) return { plan: false, exhaustive: false };
  return { plan: true, exhaustive: m[1] === "計画" };
}

/** 区切り行（`|---|---|`） */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, "")));
}

/**
 * 計画節の表から行を拾う。
 *
 * **`#` の欄が空の行も拾う。** `new-feature` は
 * **「`#` は空欄にする。番号は `plan-milestones` が分けたときだけ振る」**と定めており
 * （`new-feature/SKILL.md` の「台帳に1行足す」）、**単発で作った設計書の行は番号を持たない**。
 * 番号のある行だけを拾う実装にしていたため、**単発の設計書が「計画節に載っていない」と
 * 誤報告され、正常な push が deny されていた**（0.32.0 の初版。査読で差し戻し）。
 *
 * **設計書のパスは「設計書」の列からだけ拾う。** 行全体から最初の一致を拾っていたため、
 * 「やること」や「狙い」に別のパスを書いた行で**取り違えていた**（同じ査読）。
 * 列は見出し行から決め、決められなければ最後の列を見る。
 *
 * **HTML コメントの中は読まない。** あの節の先頭には書き方の説明がコメントで入っており、
 * **例として設計書のパスが書かれている**（拾うと誤検出になる）。
 */
function parsePlanRows(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const rows = [];
  let inPlan = false;
  let inComment = false;
  let inFence = false;
  let docCol = null;

  const cellsOf = (line) => line.split("|").slice(1, -1).map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");

    // コードフェンスの中は本文ではない。中の `# …` を見出しと読むと節が切れる（査読 L3）
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // **1行に閉じと開きが混在する形を正しく扱う**（`<!-- a --> <!-- b`）。
    // 「`-->` を含むから開いていない」と見ると、後続のコメント内を拾う（査読 L1）。
    if (inComment) {
      const close = line.lastIndexOf("-->");
      if (close < 0) continue;
      inComment = line.indexOf("<!--", close) >= 0;
      continue;
    }
    {
      const open = line.lastIndexOf("<!--");
      if (open >= 0 && line.indexOf("-->", open) < 0) {
        inComment = true;
        continue;
      }
    }

    if (line.startsWith("#")) {
      // **`###` 以降で節を抜けない。** 小見出しで表を分ける書き方があり、
      // 抜けると**以降の行をすべて失う** —— `## 計画` は網羅を約束する形なので、
      // **設計書が全件「載っていない」と誤報告される**（査読 M1）。
      const level = /^#+/.exec(line)[0].length;
      if (level <= 2) {
        inPlan = matchPlanHeading(line).plan;
        docCol = null;
      }
      continue;
    }
    if (!inPlan || !line.startsWith("|")) continue;

    const cells = cellsOf(line);
    if (!cells.length) continue;
    if (isSeparatorRow(cells)) continue;

    // **見出し行は「次の行が区切り行」で見分ける**（Markdown の表の規則）。
    // 節ごとに1回しか見ないと、**同じ節に2つ目の表があるとその見出し行を
    // データ行として読み、`row-without-doc` の deny を出す**（査読 M1）。
    const next = (lines[i + 1] || "").replace(/\s+$/, "");
    if (next.startsWith("|") && isSeparatorRow(cellsOf(next))) {
      const idx = cells.findIndex((c) => c.replace(/\*/g, "").includes("設計書"));
      docCol = idx >= 0 ? idx : null;
      continue;
    }

    // 空のプレースホルダ行（`| | | | |`）は行ではない
    if (cells.every((c) => c === "")) continue;

    const cell = cells[docCol !== null && docCol < cells.length ? docCol : cells.length - 1] || "";
    const paths = [...cell.matchAll(/(docs\/features\/[^`|\s,、]+\.md)/g)].map((m) => m[1]);
    const num = cells[0].replace(/\*/g, "").trim();
    rows.push({
      num,
      // 番号が無い行も**人が特定できる名前**で呼べるようにする
      label: num || cells[1]?.replace(/\*/g, "").trim() || paths[0] || "(名前なし)",
      paths,
      line,
    });
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
    // 計画節に載らないのが正しい（実測: 2本をここに置いている実プロジェクトがある）。
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
  const headings = planLines.filter((l) => l.startsWith("#")).map(matchPlanHeading);
  const hasPlan = headings.some((h) => h.plan);
  const exhaustive = headings.some((h) => h.exhaustive);
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
    if (!row.paths.length) {
      findings.push({
        kind: "row-without-doc",
        what: `計画「${row.label}」の行に設計書のパスが書かれていない`,
        how: "「設計書」の欄に `docs/features/` 配下のパスをコードスパンで書く。設計書がまだ無いなら `/harness-core:new-feature` で作る。",
      });
      continue;
    }
    for (const rel of row.paths) {
      if (fs.existsSync(path.join(projectDir, rel))) continue;
      // **置き場が無いことと、設計書が無いことは別の事実である**（査読 M2）。
      // `docs/features/planned/` は harness-core 0.31.2 より前のテンプレートでは
      // 配られていなかった（H62）。**ただし置き場を配っても設計書は生えない。**
      // 片方だけ案内すると行き止まりになるので、**両方を出す**。
      const dir = path.dirname(rel);
      const dirMissing = !fs.existsSync(path.join(projectDir, dir));
      findings.push({
        kind: dirMissing ? "missing-dir" : "missing-doc",
        what: dirMissing
          ? `計画「${row.label}」が指す ${rel} が無い（置き場 \`${dir}/\` ごと無い）`
          : `計画「${row.label}」が指す ${rel} が無い`,
        how:
          (dirMissing
            ? `置き場（\`${dir}/\`）は \`/harness-core:harness-update\` で配られる（harness-core 0.31.2 以降）。**それだけでは設計書は生えない。** あわせて、`
            : "") +
          "①その作業を進めるなら設計書を作る（`/harness-core:new-feature`）②取り下げたなら計画節の行を消す。**どちらが正かは作業の実態で決まる。**",
      });
    }
  }

  // 検査2: 作業中・着手前の設計書が計画節に載っているか。
  // **`## 計画` のときだけ当てる**（`matchPlanHeading` の注記を見ること）。
  const listed = new Set(rows.flatMap((r) => r.paths));
  for (const doc of exhaustive ? [...docs.active, ...docs.planned] : []) {
    if (!listed.has(doc)) {
      findings.push({
        kind: "doc-without-row",
        what: `${doc} が計画節に載っていない`,
        how: "計画節へ1行足す（`/harness-core:new-feature` が足すはずの行。`#` は空欄でよい）。着手しないものなら `docs/features/pending/` へ移す。",
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

module.exports = { check, parsePlanRows, collectFeatureDocs, matchPlanHeading, NOT_A_FEATURE_DOC };
