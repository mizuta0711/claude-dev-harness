#!/usr/bin/env node
/**
 * harness-diff.mjs — テンプレート層の追従差分エンジン（harness-update スキルの実体）
 *
 * **Node 標準ライブラリのみを使う（依存パッケージ禁止）。**
 *
 * ## 何をするか
 *
 * 「あるべき姿」を機械的に再現して、プロジェクトの現物と3点比較する:
 *
 *   A = baseline コミット時点のテンプレートから生成した姿
 *   B = 最新テンプレートから生成した姿
 *   C = プロジェクトの現物
 *
 * A と B は **クローンした claude-dev-harness の `tools/create-project.mjs` を
 * その時点のコミットで実行して**作る。合成規則（CLAUDE.md のマーカー置換 /
 * settings.json の deep-merge / .gitignore 連結）を二重実装しないための設計。
 * 置換値は `.claude/harness-baseline.json` の `placeholders` を再利用する。
 *
 * ## 分類（Phase 3 指示書 §0-3）
 *
 * | 条件 | 分類 |
 * |------|------|
 * | A≠B かつ A=C | `template-improvement` — テンプレート側の改善。適用を提案 |
 * | A=B かつ A≠C | `project-local` — プロジェクト固有の改変。保持 |
 * | A≠B かつ A≠C かつ B=C | `already-applied` — 既に同じ変更が入っている |
 * | A≠B かつ A≠C かつ B≠C | `conflict` — 競合。ユーザー判断 |
 * | A=B=C | `unchanged` |
 *
 * baseline が無い（旧生成プロジェクト）場合は A を欠いた2点比較になり、
 * **差分は全て `conflict` として提示する**（無断上書きを避けるため）。
 *
 * ## 使い方
 *
 *   node harness-diff.mjs analyze [--project <path>] [--repo <path>] [--set K=V]... [--json]
 *   node harness-diff.mjs apply <相対パス>...      # B の内容をプロジェクトへ書き込む
 *   node harness-diff.mjs finalize                 # baseline の templatesCommit を最新へ更新
 *
 * `--repo` にローカルクローンのパスを渡すとネットワークを使わない（開発・オフライン用）。
 * 省略時は GitHub から `git clone --depth 1` する。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO_URL = "https://github.com/mizuta0711/claude-dev-harness.git";
const CONFIG_REL = ".claude/harness.config.json";
const BASELINE_REL = ".claude/harness-baseline.json";
/** 解析結果と A/B ツリーを置く作業ディレクトリ（プロジェクト内・.gitignore 対象） */
const WORK_REL = ".claude/.harness-update";

/** 追従の対象外（プロジェクトの資産であり、テンプレートが上書きしてはいけない） */
const NEVER_TOUCH = [
  /^docs\/features\//,
  /^docs\/reviews\//,
  /^docs\/設計書\/(?!\.doc-sync\.md$)/, // 台帳以外の設計書は実態なので触らない
  /^\.claude\/harness-baseline\.json$/,
  /^\.claude\/\.harness-update\//,
];

// ============================================================
// 小物
// ============================================================

function fail(message) {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

function git(args, cwd, allowFail = false) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(" ")} が失敗しました: ${e.stderr || e.message}`);
  }
}

/** テキストとして読む（BOM 除去・CRLF 正規化）。存在しなければ null */
function readText(file) {
  try {
    return fs.readFileSync(file, "utf-8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

function readJson(file) {
  const raw = readText(file);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function walk(root, base = root, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

function isNeverTouch(rel) {
  return NEVER_TOUCH.some((re) => re.test(rel));
}

// ============================================================
// 引数
// ============================================================

function parseArgs(argv) {
  const opts = {
    command: argv[0] || "analyze",
    project: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    repo: null,
    set: new Map(),
    json: false,
    force: false,
    files: [],
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") opts.project = argv[++i];
    else if (a === "--repo") opts.repo = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--set") {
      const kv = argv[++i] || "";
      const eq = kv.indexOf("=");
      if (eq <= 0) fail(`--set の書式が不正です: ${kv}`);
      opts.set.set(kv.slice(0, eq).trim(), kv.slice(eq + 1));
    } else if (a.startsWith("--")) fail(`不明な引数: ${a}`);
    else opts.files.push(a);
  }
  opts.project = path.resolve(opts.project);
  return opts;
}

// ============================================================
// プロジェクトの状態
// ============================================================

function loadProjectState(projectDir) {
  const config = readJson(path.join(projectDir, CONFIG_REL));
  if (!config) {
    fail(`${CONFIG_REL} が読めません。ハーネス管理下のプロジェクトではないか、JSON が壊れています。`);
  }
  const environment = config.environment;
  if (!environment) fail(`${CONFIG_REL} に environment がありません。`);

  const baseline = readJson(path.join(projectDir, BASELINE_REL));
  return { config, environment, baseline };
}

// ============================================================
// テンプレートの取得と「あるべき姿」の生成
// ============================================================

function prepareRepo(opts, work) {
  if (opts.repo) {
    const abs = path.resolve(opts.repo);
    if (!fs.existsSync(path.join(abs, "tools", "create-project.mjs"))) {
      fail(`--repo に指定されたパスが claude-dev-harness のクローンではありません: ${abs}`);
    }
    // checkout でユーザーの作業ツリーを汚さないよう、作業用に clone し直す
    const dest = path.join(work, "repo");
    fs.rmSync(dest, { recursive: true, force: true });
    git(["clone", "--quiet", abs, dest], work);
    return { dir: dest, shallow: false, source: abs };
  }

  const dest = path.join(work, "repo");
  fs.rmSync(dest, { recursive: true, force: true });
  try {
    git(["clone", "--quiet", "--depth", "1", REPO_URL, dest], work);
  } catch (e) {
    fail(
      `テンプレートの取得に失敗しました（ネットワーク不通の可能性）。\n` +
        `${e.message}\n` +
        `対処: オフラインの場合は --repo <ローカルクローンのパス> を指定してください。`
    );
  }
  return { dir: dest, shallow: true, source: REPO_URL };
}

/**
 * baseline コミットを取得可能にする。
 * `--depth 1` のクローンには履歴が無いため、そのコミットだけを追加 fetch する
 * （GitHub は SHA 指定の fetch を許可している）。取れなければ false を返し、2点比較へ落とす。
 */
function ensureCommit(repoDir, commit) {
  if (!commit) return false;
  if (git(["cat-file", "-e", `${commit}^{commit}`], repoDir, true) !== null) return true;
  if (git(["fetch", "--quiet", "--depth", "1", "origin", commit], repoDir, true) === null) return false;
  return git(["cat-file", "-e", `${commit}^{commit}`], repoDir, true) !== null;
}

/**
 * 指定コミットのテンプレートから「あるべき姿」を生成する。
 * クローン側の create-project.mjs をそのまま実行するため、合成規則の二重実装が発生しない。
 */
function renderIdeal(repoDir, commit, env, placeholders, destDir) {
  if (commit) git(["checkout", "--quiet", commit], repoDir);
  fs.rmSync(destDir, { recursive: true, force: true });

  const args = [
    path.join(repoDir, "tools", "create-project.mjs"),
    "--env",
    env,
    "--dest",
    destDir,
    "--yes",
  ];
  for (const [k, v] of Object.entries(placeholders)) args.push("--set", `${k}=${v}`);

  try {
    execFileSync(process.execPath, args, {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });
  } catch (e) {
    throw new Error(
      `テンプレートの再現に失敗しました（commit=${commit || "HEAD"}, env=${env}）: ${e.stderr || e.message}`
    );
  }
  // 生成物側の .git と baseline は比較対象にしない
  fs.rmSync(path.join(destDir, ".git"), { recursive: true, force: true });
  fs.rmSync(path.join(destDir, BASELINE_REL), { force: true });
  return destDir;
}

// ============================================================
// 分類
// ============================================================

function classify(a, b, c) {
  const inA = a !== null;
  const inB = b !== null;
  const inC = c !== null;

  if (!inB && !inC) return null; // どちらにも無い（A のみ = 旧テンプレートの残骸）

  if (!inB && inC) {
    // テンプレートから消えたファイル
    return inA ? { kind: "template-removed", note: "テンプレート側で削除された" } : null;
  }

  if (inB && !inC) {
    if (!inA) return { kind: "template-improvement", note: "テンプレートに新規追加された" };
    return a === b
      ? { kind: "project-local", note: "プロジェクト側で削除された" }
      : { kind: "conflict", note: "テンプレート側が変更、プロジェクト側は削除" };
  }

  // inB && inC
  if (!inA) {
    return b === c
      ? { kind: "unchanged", note: "" }
      : { kind: "conflict", note: "baseline が無いため差分は全て要判断" };
  }

  const abSame = a === b;
  const acSame = a === c;
  if (abSame && acSame) return { kind: "unchanged", note: "" };
  if (!abSame && acSame) return { kind: "template-improvement", note: "テンプレート側の改善" };
  if (abSame && !acSame) return { kind: "project-local", note: "プロジェクト固有の改変" };
  return b === c
    ? { kind: "already-applied", note: "同じ変更が既に入っている" }
    : { kind: "conflict", note: "両方が同じファイルを変更している" };
}

/** harness.config.json は「値」ではなく「スキーマ」の差分として扱う（§0-4） */
function schemaDiff(baselineJson, latestJson, currentJson) {
  const keysOf = (obj, prefix = "", out = new Set()) => {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return out;
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      out.add(key);
      keysOf(v, key, out);
    }
    return out;
  };
  const latest = keysOf(latestJson);
  const current = keysOf(currentJson);
  const base = baselineJson ? keysOf(baselineJson) : null;

  const added = [...latest].filter((k) => !current.has(k)).sort();
  const removed = base ? [...base].filter((k) => !latest.has(k) && current.has(k)).sort() : [];

  return {
    addedKeys: added,
    deprecatedKeys: removed,
    schemaVersionChange:
      latestJson?.schemaVersion !== currentJson?.schemaVersion
        ? { from: currentJson?.schemaVersion, to: latestJson?.schemaVersion }
        : null,
  };
}

// ============================================================
// コマンド
// ============================================================

function cmdAnalyze(opts) {
  const { environment, baseline } = loadProjectState(opts.project);

  const placeholders = { ...(baseline?.placeholders || {}) };
  for (const [k, v] of opts.set) placeholders[k] = v;

  const work = path.join(opts.project, WORK_REL);
  fs.mkdirSync(work, { recursive: true });

  const repo = prepareRepo(opts, work);
  const latestCommit = git(["rev-parse", "HEAD"], repo.dir);

  const baselineCommit = baseline?.templatesCommit || null;
  const haveBaseline = baselineCommit ? ensureCommit(repo.dir, baselineCommit) : false;

  const warnings = [];
  if (!baseline) {
    warnings.push(
      `${BASELINE_REL} がありません（Phase 2 以前に生成されたプロジェクト）。` +
        `2点比較になるため、差分は全て「競合」として提示します。`
    );
  } else if (!haveBaseline) {
    warnings.push(
      `baseline コミット ${baselineCommit} を取得できませんでした` +
        `（shallow clone で追加 fetch にも失敗）。2点比較へ切り替えます。`
    );
  }
  if (!Object.keys(placeholders).length) {
    warnings.push(
      "プレースホルダの値が分かりません。--set KEY=VALUE で渡さないと、" +
        "テンプレート側のプレースホルダが未置換のまま比較され、差分が過剰に出ます。"
    );
  }

  // B（最新）と A（baseline 時点）を生成する
  const latestDir = renderIdeal(repo.dir, latestCommit, environment, placeholders, path.join(work, "latest"));
  const baseDir = haveBaseline
    ? renderIdeal(repo.dir, baselineCommit, environment, placeholders, path.join(work, "baseline"))
    : null;
  // 解析後はクローンを最新へ戻しておく（次回 analyze の起点を揃える）
  git(["checkout", "--quiet", latestCommit], repo.dir);

  const rels = new Set([...walk(latestDir), ...(baseDir ? walk(baseDir) : [])]);
  for (const rel of walk(opts.project)) {
    if (rel.startsWith(".claude/.harness-update/")) continue;
    rels.add(rel);
  }

  const results = [];
  for (const rel of [...rels].sort()) {
    if (isNeverTouch(rel)) continue;
    const a = baseDir ? readText(path.join(baseDir, rel)) : null;
    const b = readText(path.join(latestDir, rel));
    const c = readText(path.join(opts.project, rel));
    if (b === null && c !== null && a === null) continue; // プロジェクト固有ファイル（対象外）

    const verdict = classify(a, b, c);
    if (!verdict || verdict.kind === "unchanged") continue;
    results.push({ file: rel, ...verdict });
  }

  const configDiff = schemaDiff(
    baseDir ? readJson(path.join(baseDir, CONFIG_REL)) : null,
    readJson(path.join(latestDir, CONFIG_REL)),
    readJson(path.join(opts.project, CONFIG_REL))
  );

  const report = {
    environment,
    baselineCommit: haveBaseline ? baselineCommit : null,
    latestCommit,
    repoSource: repo.source,
    twoWayFallback: !haveBaseline,
    placeholders,
    warnings,
    workDir: path.relative(opts.project, work).split(path.sep).join("/"),
    idealDir: path.relative(opts.project, latestDir).split(path.sep).join("/"),
    baselineDir: baseDir ? path.relative(opts.project, baseDir).split(path.sep).join("/") : null,
    configSchemaDiff: configDiff,
    files: results,
  };

  fs.writeFileSync(path.join(work, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf-8");

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printHuman(report);
}

const LABEL = {
  "template-improvement": "テンプレート側の改善（適用を提案）",
  "project-local": "プロジェクト固有の改変（保持）",
  conflict: "競合（ユーザー判断）",
  "already-applied": "適用済み（対応不要）",
  "template-removed": "テンプレート側で削除（判断）",
};

function printHuman(r) {
  console.log(`環境          : ${r.environment}`);
  console.log(`baseline      : ${r.baselineCommit || "(無し — 2点比較)"}`);
  console.log(`最新          : ${r.latestCommit}`);
  console.log(`取得元        : ${r.repoSource}`);
  console.log(`あるべき姿(B) : ${r.idealDir}`);
  if (r.baselineDir) console.log(`baseline姿(A) : ${r.baselineDir}`);

  for (const w of r.warnings) console.log(`\n⚠️  ${w}`);

  const groups = {};
  for (const f of r.files) (groups[f.kind] ||= []).push(f);

  for (const kind of ["template-improvement", "conflict", "template-removed", "project-local", "already-applied"]) {
    const list = groups[kind];
    if (!list?.length) continue;
    console.log(`\n## ${LABEL[kind]}（${list.length} 件）`);
    for (const f of list) console.log(`  ${f.file}${f.note ? ` — ${f.note}` : ""}`);
  }
  if (!r.files.length) console.log("\n差分はありません。テンプレート層は最新に追従済みです。");

  const cd = r.configSchemaDiff;
  if (cd.addedKeys.length || cd.deprecatedKeys.length || cd.schemaVersionChange) {
    console.log("\n## harness.config.json のスキーマ差分");
    if (cd.schemaVersionChange) {
      console.log(`  schemaVersion: ${cd.schemaVersionChange.from} -> ${cd.schemaVersionChange.to}（要ユーザー承認）`);
    }
    for (const k of cd.addedKeys) console.log(`  + ${k}（新フィールド。既定値つきで追加を提案）`);
    for (const k of cd.deprecatedKeys) console.log(`  - ${k}（テンプレートから消えた。非推奨の可能性）`);
  }

  console.log(`\n報告は ${r.workDir}/report.json にも保存しました。`);
}

function cmdApply(opts) {
  if (!opts.files.length) fail("適用するファイルの相対パスを1つ以上指定してください。");
  const work = path.join(opts.project, WORK_REL);
  const report = readJson(path.join(work, "report.json"));
  if (!report) fail("先に analyze を実行してください（report.json がありません）。");

  const idealDir = path.join(opts.project, report.idealDir);
  const byFile = new Map(report.files.map((f) => [f.file, f.kind]));
  const applied = [];
  for (const rel of opts.files) {
    if (isNeverTouch(rel)) fail(`${rel} は追従対象外です（プロジェクトの資産）。`);

    // 競合をまとめて上書きさせない（「ローカル改変の無断上書き禁止」の機械的な担保）。
    // 競合は A/B/C を突き合わせてハンク単位で解決し、Edit で書くこと。
    if (byFile.get(rel) === "conflict") {
      fail(
        `${rel} は「競合」に分類されています。apply では上書きしません。\n` +
          `  A（前回適用時）: ${report.baselineDir ? report.baselineDir + "/" + rel : "(baseline 無し)"}\n` +
          `  B（最新）      : ${report.idealDir}/${rel}\n` +
          `  C（現物）      : ${rel}\n` +
          `この3つを突き合わせ、ハンク単位でユーザーの判断を得てから直接編集してください。`
      );
    }

    const src = path.join(idealDir, rel);
    const content = readText(src);
    if (content === null) fail(`${rel} は「あるべき姿」に存在しません。パスを確認してください。`);
    const dest = path.join(opts.project, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // 出力規約は create-project と同じ（UTF-8 BOM 無し・LF、.ps1 のみ BOM 付き）
    const bom = path.extname(dest).toLowerCase() === ".ps1" ? "﻿" : "";
    fs.writeFileSync(dest, bom + content, "utf-8");
    applied.push(rel);
  }
  console.log(`適用しました（${applied.length} 件）:`);
  for (const f of applied) console.log(`  ${f}`);
  console.log(`\n適用が完了したら finalize を実行して baseline を更新してください。`);
}

function cmdFinalize(opts) {
  const work = path.join(opts.project, WORK_REL);
  const report = readJson(path.join(work, "report.json"));
  if (!report) fail("先に analyze を実行してください（report.json がありません）。");

  // baseline を進めると、未解決の差分は次回から「プロジェクト固有」に見える
  // （A=B になるため）。テンプレート側の変更が視界から消えるので、
  // **未解決の競合が残ったままの finalize はブロックする**。
  const idealDir = path.join(opts.project, report.idealDir);
  const stillDiffers = (rel) => {
    const b = readText(path.join(idealDir, rel));
    const c = readText(path.join(opts.project, rel));
    return b !== c;
  };

  const unresolvedConflicts = report.files
    .filter((f) => f.kind === "conflict")
    .map((f) => f.file)
    .filter(stillDiffers);

  if (unresolvedConflicts.length && !opts.force) {
    fail(
      `未解決の競合が ${unresolvedConflicts.length} 件残っています:\n` +
        unresolvedConflicts.map((f) => `  ${f}`).join("\n") +
        `\n\nbaseline を進めると、これらは次回から「プロジェクト固有の改変」に見え、` +
        `\nテンプレート側の変更が差分として出てこなくなります。` +
        `\n先に競合を解決してください。意図的に見送る場合のみ --force を付けてください。`
    );
  }

  const unappliedImprovements = report.files
    .filter((f) => f.kind === "template-improvement")
    .map((f) => f.file)
    .filter(stillDiffers);

  if (unappliedImprovements.length) {
    console.warn(`⚠️  未適用のテンプレート改善が ${unappliedImprovements.length} 件あります:`);
    for (const f of unappliedImprovements) console.warn(`      ${f}`);
    console.warn("    これらは次回から「プロジェクト固有の改変」として扱われます（再提案されません）。\n");
  }

  const file = path.join(opts.project, BASELINE_REL);
  const baseline = readJson(file) || {};
  const previous = baseline.templatesCommit || null;

  baseline.templatesCommit = report.latestCommit;
  baseline.environment = report.environment;
  baseline.appliedAt = new Date().toISOString().slice(0, 10);
  if (report.placeholders && Object.keys(report.placeholders).length) {
    baseline.placeholders = report.placeholders;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(baseline, null, 2) + "\n", "utf-8");
  console.log(`${BASELINE_REL} を更新しました: ${previous || "(無し)"} -> ${report.latestCommit}`);

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`作業ディレクトリ ${WORK_REL} を削除しました。`);
}

// ============================================================
// main
// ============================================================

const opts = parseArgs(process.argv.slice(2));
try {
  if (opts.command === "analyze") cmdAnalyze(opts);
  else if (opts.command === "apply") cmdApply(opts);
  else if (opts.command === "finalize") cmdFinalize(opts);
  else fail(`不明なコマンド: ${opts.command}（analyze | apply | finalize）`);
} catch (e) {
  fail(e?.message || String(e));
}
