#!/usr/bin/env node
/**
 * create-project.mjs — claude-dev-harness のプロジェクト生成ツール
 *
 * `templates/base` と `templates/<env>` を合成して新規プロジェクトを生成する。
 * WPF テンプレートの `init-template.ps1` の Node 移植版（--dry-run 機能を含む）。
 *
 * **Node 標準ライブラリのみを使う（依存パッケージ禁止）。**
 *
 * 使い方:
 *   node tools/create-project.mjs --env wpf --dest ../MyApp
 *   node tools/create-project.mjs --env nextjs --dest ../my-app --set PROJECT_NAME=my-app --dry-run
 *
 * 合成のルール（Phase 2 指示書 §0-3〜§0-5）:
 *   - CLAUDE.md      : base の `<!-- ENV_SECTION -->` を env の CLAUDE.section.md で置換する
 *   - settings.json  : deep-merge（オブジェクトは再帰マージ、配列は連結 + 重複除去）
 *   - .gitignore     : base + env の連結
 *   - それ以外       : env が base を上書きする
 *
 * 出力は UTF-8（BOM 無し）・LF。ただし `.ps1` だけは UTF-8 BOM 付きを維持する
 * （PowerShell 5.1 が BOM 無し UTF-8 を CP932 と誤読して日本語が化けるため）。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES_DIR = path.join(HARNESS_ROOT, "templates");

/** 生成先へコピーしないテンプレート層のメタファイル */
const TEMPLATE_META_FILES = new Set(["template.json", "CLAUDE.section.md"]);

/**
 * 適用済みテンプレートの記録先（Phase 3 §0-2）。
 * `harness-update` スキルが「前回どの時点のテンプレートを適用したか」を知るために読む。
 * `harness.config.json` には入れない — config は実行時の契約、baseline は適用メタ情報で関心が異なる。
 */
const BASELINE_RELATIVE_PATH = ".claude/harness-baseline.json";

/** BOM を付けて出力する拡張子（§0-10） */
const BOM_EXTENSIONS = new Set([".ps1"]);

const BOM = "﻿";

// ============================================================
// 引数
// ============================================================

function parseArgs(argv) {
  const opts = { env: null, dest: null, dryRun: false, set: new Map(), yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--env") opts.env = argv[++i];
    else if (a === "--dest") opts.dest = argv[++i];
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--set") {
      const kv = argv[++i] || "";
      const eq = kv.indexOf("=");
      if (eq <= 0) fail(`--set の書式が不正です: ${kv}（KEY=VALUE 形式で指定してください）`);
      opts.set.set(kv.slice(0, eq).trim(), kv.slice(eq + 1));
    } else if (a === "--help" || a === "-h") {
      usage();
      process.exit(0);
    } else {
      fail(`不明な引数: ${a}`);
    }
  }
  return opts;
}

function usage() {
  const envs = listEnvironments().join(" | ");
  console.log(`
使い方:
  node tools/create-project.mjs --env <${envs}> --dest <生成先パス> [オプション]

オプション:
  --set KEY=VALUE   プレースホルダの値を指定する（複数可。未指定分は対話で尋ねる）
  --dry-run         生成予定のファイル一覧と置換内容を表示するだけで、何も書き込まない
  --yes, -y         既定値をそのまま使い、対話プロンプトを出さない
  --help, -h        このヘルプを表示する
`);
}

function fail(message) {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

/**
 * このハーネスリポジトリの現在のコミットハッシュ。
 * git リポジトリでない（zip 展開など）場合は null を返し、baseline には記録しない
 * （その場合 harness-update は3点比較ができず、全差分を「競合」として提示する）。
 */
function harnessCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: HARNESS_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** `YYYY-MM-DD` */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function listEnvironments() {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  return fs
    .readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "base")
    .filter((d) => fs.existsSync(path.join(TEMPLATES_DIR, d.name, "template.json")))
    .map((d) => d.name)
    .sort();
}

// ============================================================
// ファイル操作
// ============================================================

/** ディレクトリ配下の全ファイルを、ルートからの相対パス（`/` 区切り）で列挙する */
function walk(root, base = root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/** テキストとして読む（BOM は落とす。改行は LF へ正規化する） */
function readText(file) {
  return fs.readFileSync(file, "utf-8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

/** テキストを書く。`.ps1` のみ BOM 付き、それ以外は BOM 無し。改行は常に LF */
function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const normalized = content.replace(/\r\n/g, "\n");
  const withBom = BOM_EXTENSIONS.has(path.extname(file).toLowerCase())
    ? BOM + normalized
    : normalized;
  fs.writeFileSync(file, withBom, "utf-8");
}

// ============================================================
// 合成
// ============================================================

/**
 * deep-merge（§0-4）。
 * - オブジェクト同士は再帰的にマージする
 * - 配列同士は連結し、重複を除去する（プリミティブは値、それ以外は JSON 文字列で同一判定）
 * - それ以外は env（後勝ち）が base を上書きする
 */
function deepMerge(base, env) {
  if (Array.isArray(base) && Array.isArray(env)) {
    const seen = new Set();
    const out = [];
    for (const item of [...base, ...env]) {
      const key = typeof item === "object" && item !== null ? JSON.stringify(item) : `${typeof item}:${item}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }
  if (isPlainObject(base) && isPlainObject(env)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(env)) {
      out[k] = k in base ? deepMerge(base[k], v) : v;
    }
    return out;
  }
  return env === undefined ? base : env;
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `{{KEY}}` をすべて置換する */
function substitute(text, values) {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole
  );
}

/**
 * base と env を合成し、`相対パス -> 内容` のマップを作る。
 * この時点ではまだプレースホルダは置換していない。
 */
function composeFiles(baseDir, envDir) {
  /** @type {Map<string, string>} */
  const files = new Map();

  for (const rel of walk(baseDir)) {
    files.set(rel, readText(path.join(baseDir, rel)));
  }

  for (const rel of walk(envDir)) {
    if (TEMPLATE_META_FILES.has(rel)) continue; // テンプレート層のメタ情報は配らない
    const envContent = readText(path.join(envDir, rel));

    if (rel === ".gitignore" && files.has(rel)) {
      // §0-5: base + env の連結
      files.set(rel, `${files.get(rel).trimEnd()}\n\n${envContent.trimStart()}`);
      continue;
    }

    if (rel.endsWith("settings.json") && files.has(rel)) {
      // §0-4: deep-merge
      const merged = deepMerge(JSON.parse(files.get(rel)), JSON.parse(envContent));
      files.set(rel, JSON.stringify(merged, null, 2) + "\n");
      continue;
    }

    files.set(rel, envContent); // それ以外は env が上書き
  }

  // §0-3: CLAUDE.md の ENV_SECTION 置換
  const sectionPath = path.join(envDir, "CLAUDE.section.md");
  if (files.has("CLAUDE.md") && fs.existsSync(sectionPath)) {
    const marker = "<!-- ENV_SECTION -->";
    const claudeMd = files.get("CLAUDE.md");
    if (!claudeMd.includes(marker)) {
      fail(`templates/base/CLAUDE.md にマーカー ${marker} がありません。合成できません。`);
    }
    files.set("CLAUDE.md", claudeMd.replace(marker, readText(sectionPath).trimEnd() + "\n"));
  }

  return files;
}

// ============================================================
// プレースホルダ
// ============================================================

async function resolvePlaceholders(templateJson, preset, interactive) {
  /** @type {Record<string,string>} */
  const values = {};
  const declared = templateJson.placeholders || [];

  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;

  try {
    for (const p of declared) {
      if (preset.has(p.key)) {
        values[p.key] = preset.get(p.key);
        continue;
      }
      // default は既に決まった値を参照できる（例: "{{PROJECT_NAME}}.Core"）
      const fallback = p.default ? substitute(p.default, values) : "";
      if (!rl) {
        if (!fallback) {
          fail(
            `プレースホルダ ${p.key} の値がありません。` +
              `--set ${p.key}=... で指定するか、対話可能な端末で実行してください。`
          );
        }
        values[p.key] = fallback;
        continue;
      }
      const hint = fallback ? `[${fallback}]` : p.example ? `(例: ${p.example})` : "";
      let answer = "";
      while (!answer) {
        answer = (await rl.question(`${p.prompt} ${hint}: `)).trim();
        if (!answer && fallback) answer = fallback;
        if (!answer) console.log("  値が必要です。");
      }
      values[p.key] = answer;
    }
  } finally {
    rl?.close();
  }
  return values;
}

// ============================================================
// main
// ============================================================

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const environments = listEnvironments();

  if (!environments.length) fail(`templates/ に環境が見つかりません（${TEMPLATES_DIR}）。`);
  if (!opts.env) {
    usage();
    fail("--env は必須です。");
  }
  if (!environments.includes(opts.env)) {
    fail(`未知の環境: ${opts.env}（利用可能: ${environments.join(", ")}）`);
  }
  if (!opts.dest) {
    usage();
    fail("--dest は必須です。");
  }

  const baseDir = path.join(TEMPLATES_DIR, "base");
  const envDir = path.join(TEMPLATES_DIR, opts.env);
  const destDir = path.resolve(opts.dest);
  const templateJson = JSON.parse(readText(path.join(envDir, "template.json")));

  if (fs.existsSync(destDir) && fs.readdirSync(destDir).some((f) => f !== ".git")) {
    console.warn(`警告: 生成先が空ではありません: ${destDir}`);
    console.warn("      同名ファイルは上書きされます。");
  }

  // 対話できるのは TTY があり --yes でない場合のみ
  const interactive = Boolean(process.stdin.isTTY) && !opts.yes;
  const values = await resolvePlaceholders(templateJson, opts.set, interactive);

  const composed = composeFiles(baseDir, envDir);

  /** @type {Map<string,string>} */
  const rendered = new Map();
  for (const [rel, content] of composed) {
    rendered.set(substitute(rel, values), substitute(content, values));
  }

  // 適用済みテンプレートの記録（Phase 3 §0-2）。
  // placeholders も残すのは、harness-update が「同じ置換値で最新テンプレートを再合成し、
  // プロジェクトの現物と比較する」ために必要なため（値が無いと差分が全て別物になる）。
  const commit = harnessCommit();
  rendered.set(
    BASELINE_RELATIVE_PATH,
    JSON.stringify(
      {
        templatesCommit: commit,
        environment: opts.env,
        appliedAt: today(),
        placeholders: values,
      },
      null,
      2
    ) + "\n"
  );

  // 未置換のプレースホルダが残っていないか（§7-1.5）
  const leftovers = [];
  for (const [rel, content] of rendered) {
    const found = new Set([...content.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
    if (found.size) leftovers.push(`${rel}: ${[...found].join(", ")}`);
  }

  // ---- 出力 ----
  console.log(`\n環境        : ${opts.env}（${templateJson.description || ""}）`);
  console.log(`生成先      : ${destDir}`);
  console.log(`プラグイン  : harness-core@dev-harness, ${templateJson.plugin || "(なし)"}`);
  console.log("\n置換内容:");
  for (const [k, v] of Object.entries(values)) console.log(`  {{${k}}} -> ${v}`);

  console.log(`\n生成するファイル（${rendered.size} 件）:`);
  for (const rel of [...rendered.keys()].sort()) console.log(`  ${rel}`);

  if (leftovers.length) {
    console.warn("\n警告: 未置換のプレースホルダが残っています:");
    for (const l of leftovers) console.warn(`  ${l}`);
    console.warn("  （テンプレート側の template.json に宣言が不足している可能性があります）");
  }

  if (opts.dryRun) {
    console.log("\n--dry-run のため、ファイルは書き込んでいません。");
    return;
  }

  for (const [rel, content] of rendered) {
    writeText(path.join(destDir, rel), content);
  }
  console.log(`\n${rendered.size} 件のファイルを書き込みました。`);

  // git init（既存の .git があればスキップ）
  if (fs.existsSync(path.join(destDir, ".git"))) {
    console.log("git: 既存のリポジトリがあるため git init はスキップしました。");
  } else {
    try {
      execFileSync("git", ["init", "-q"], { cwd: destDir, stdio: "inherit" });
      console.log("git: リポジトリを初期化しました。");
    } catch {
      console.warn("git: 初期化に失敗しました（git が無い等）。手動で `git init` してください。");
    }
  }

  console.log(`
次の手順:

  1. cd ${opts.dest}
  2. claude                       # Claude Code を起動する
  3. プラグインの信頼を求められたら承認する
     （.claude/settings.json の extraKnownMarketplaces / enabledPlugins により
       harness-core と ${templateJson.plugin || "環境プラグイン"} が自動で導入される）
  4. 起動時に environment: ${opts.env} が表示されれば読み込み成功
  5. /harness-core:new-feature <機能名>   # 規模判定から開発を始める

  CLAUDE.md の <!-- TODO --> 箇所も忘れずに記入してください。${
    fs.existsSync(path.join(envDir, "SETUP.md")) ? "\n  環境固有のセットアップは SETUP.md を参照してください。" : ""
  }
`);
}

main().catch((e) => fail(e?.stack || String(e)));
