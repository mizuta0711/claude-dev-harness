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
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPO_URL = "https://github.com/mizuta0711/claude-dev-harness.git";
const CONFIG_REL = ".claude/harness.config.json";
const BASELINE_REL = ".claude/harness-baseline.json";
/** 解析結果と A/B ツリーを置く作業ディレクトリ（プロジェクト内・.gitignore 対象） */
const WORK_REL = ".claude/.harness-update";

/** 追従の対象外（プロジェクトの資産であり、テンプレートが上書きしてはいけない） */
const NEVER_TOUCH = [
  // **`.gitkeep` は除外しない。** あれはプロジェクトの資産ではなく、
  // **ハーネスが規定する置き場そのもの（骨格）**である。ディレクトリを丸ごと除外すると、
  // 後から足した置き場が**既存プロジェクトへ永久に届かない** → 下の `SEED_ONCE` で配り切る。
  /^docs\/features\/(?!(?:.*\/)?\.gitkeep$)/,
  /^docs\/reviews\/(?!(?:.*\/)?\.gitkeep$)/,
  /^docs\/設計書\/(?!\.doc-sync\.md$)/, // 台帳以外の設計書は実態なので触らない
  // 設計方針層。骨格は初回生成時のみ配り、以後の中身はプロジェクトが育てる。
  // README.md だけはテンプレ所有（運用ルールと推奨軸メニュー）なので追従させる。
  // `core.md` はハーネスが持つ規律そのものなので追従させる。
  // `environment.md` は **SEED_ONCE**（下を見ること）。
  /^\.claude\/01_development_docs\/(?!README\.md$)/,
  /^\.claude\/02_design_system\//,
  /^\.claude\/00_project\//,
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

/**
 * 正規化済みテキストのハッシュ。
 *
 * `readText` が BOM と CRLF を落としたあとの内容を対象にするため、
 * 改行コードの違いだけで「変更された」と誤判定しない。
 * ファイルが存在しない場合（`null`）は固定値を返す。
 */
function hashOf(text) {
  if (text === null) return "absent";
  return createHash("sha256").update(text).digest("hex");
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

// **配り切り（無ければ配る・あれば触らない）。**
// `NEVER_TOUCH` との違いは「初回は配る」こと。**プロジェクトが実態を記入する雛形**が対象で、
// 記入後は追従させない。追従させると、**記入した事実を雛形で上書きする**か、
// 記入するたびに競合になる（0.25.0 でそれを実際にやってしまった:
// Next.js 15.3 のプロジェクトへ「Next.js 16」と書いた雛形を自動適用した）。
//
// **`NEVER_TOUCH` に入れてはいけない** — 除外すると analyze のレポートに出ず
// apply もできないので、**まだ持っていないプロジェクトへ初回を配る経路が消える**。
// `CLAUDE.md` が `@` で読み込むため、**無いとハーネスの環境節が無言で消える**
// （読み込みの失敗は警告が出ない）。
//
// **`docs/` 配下の `.gitkeep` も配り切りである。** 置き場（`docs/features/planned/` 等）は
// ハーネスが規定するが、**中身はプロジェクトの資産**なので、配った後は触らない。
// 0.27.0 で `docs/features/planned/` を足したのに、`NEVER_TOUCH` が
// `docs/features/` を丸ごと除外していたため、**既存7プロジェクトの 0/7 に届いていなかった**
// （`plan-milestones` / `new-feature` / `design-review` の3スキルが指示する置き場が無い状態）。
const SEED_ONCE = [/^\.claude\/harness\/environment\.md$/, /^docs\/(?:.*\/)?\.gitkeep$/];

function isSeedOnce(rel) {
  return SEED_ONCE.some((re) => re.test(rel));
}

/**
 * 配り切りのファイルが**プロジェクトに無い**ときの扱いを決める。
 *
 * **`classify` には任せられない。** あれは baseline（A）に入っていて現物（C）が無いと
 * `project-local`（「プロジェクト側で削除された」＝保持）を返すため、
 * **baseline が「配り始めた版」以降のプロジェクトには永久に届かない**
 * （0.31.1 の初版がこれを踏んだ。`docs/features/planned/.gitkeep` は
 * baseline 0.27.0 以降の5プロジェクトで `project-local` になり、1つも配られなかった）。
 * **配り切りの意味は「現物が無ければ配る」**であって、A の有無とは関係しない。
 *
 * ただし**消したものを無条件に配り直すと再提案が止まらない**。`.gitkeep` は
 * 「空ディレクトリを git に載せる」ためのものなので、**置き場が実在するなら不要**である
 * （実測: 中身があるので `.gitkeep` を消している実プロジェクトが2件あった）。
 *
 * @returns 配るときは verdict、配らないときは null
 */
function seedOnceVerdict(rel, projectDir) {
  if (/(?:^|\/)\.gitkeep$/.test(rel)) {
    if (fs.existsSync(path.join(projectDir, path.dirname(rel)))) return null;
    return { kind: "template-improvement", note: "配り切り: 置き場そのものが無いので配る" };
  }
  return { kind: "template-improvement", note: "配り切り: 現物が無いので配る" };
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
      : { kind: "conflict", note: "baseline にこのファイルが無い（テンプレートの新規配布とローカルの両方がある）" };
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

/**
 * JSON を「キー単位」で3方向マージする対象（§0-4b）
 *
 * ## なぜファイル単位では足りないのか
 *
 * `classify` の単位はファイルである。ところが**テンプレートが配るファイルを
 * プロジェクトも育てる**ので、`.claude/settings.json` は `A≠B` かつ `A≠C` かつ `B≠C` が
 * 常態になり、**`conflict` が既定になる**（実測: 導入済み3プロジェクトすべてで競合）。
 *
 * 競合1件につき `harness-update` の Step 3（材料集め → 査読 → 裏取り → 提示）が起動するため、
 * **テンプレートを1行直すたびに重い手続きが走る**。これが「最新化しても気軽に適用できない」の正体だった。
 *
 * ## 何をするか
 *
 * **所有の境界をファイルからキーへ下げる。** A→B の変更を**キーごとに** C へ当て、
 * **本当に食い違うキーだけ**をユーザー判断に残す。
 *
 * | A→B | C | 結果 |
 * |---|---|---|
 * | 削除 | A と同じ／空の入れ物 | **C からも削除**（育てた値ではない。`isEmptyContainer` を参照） |
 * | 削除 | A と違い中身がある | **そのキーだけ競合**（プロジェクトが育てたものを消さない） |
 * | 追加 | 無い | **C へ追加** |
 * | 追加 | B と同じ | 何もしない（既に入っている） |
 * | 追加 | B と違う | **そのキーだけ競合** |
 * | 変更 | A と同じ | **B の値にする** |
 * | 変更 | B と同じ | 何もしない（適用済み） |
 * | 変更 | A とも B とも違う | **中がオブジェクト／配列なら1段下へ降りる**。降りられなければ競合 |
 * | 不変 | — | **C のまま**（プロジェクトの改変を保持） |
 *
 * **配列は集合として扱う**（`permissions.allow` が代表例）。
 * A から B で**消えた要素は C からも消し、増えた要素は C の末尾へ足す**。
 * C が独自に足した要素・独自に消した要素はそのまま残る。
 * これは `create-project.mjs` の `deepMerge`（配列は連結＋重複除去）と同じ向きである。
 *
 * **順序が意味を持つ配列には使えない。** 現在の対象（`permissions.allow` / `deny` /
 * `enabledMcpjsonServers`）はいずれも集合なので成り立つ。**対象を増やすときはここを確かめること。**
 */
const JSON_MERGE_FILES = new Set([".claude/settings.json"]);
const MERGED_REL = "merged";

/** 比較用に正規化する（キーの順序の違いを差分として数えない） */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  }
  return v;
}

const same = (x, y) => JSON.stringify(canon(x)) === JSON.stringify(canon(y));
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 空の入れ物（`{}` / `[]`）。**テンプレートがキーを削除した場合に限り**、不在と同じに扱う。
 *
 * **判定は C の値だけを見る**（A に中身があっても、C が空なら消す）。
 * `settings.json` では `{}` / `[]` は不在と同じ意味なので実害が無い。
 * **`JSON_MERGE_FILES` に「空に意味がある」ファイルを足すときはここを絞ること。**
 *
 * **実測で要った**（2026-10-08・導入済み3プロジェクト）。0.18.0 で `enabledPlugins` を
 * テンプレートから削除したあと、各プロジェクトへの展開が**キーを消さずに空にしていた**（`"enabledPlugins": {}`）。
 * これを「プロジェクトが育てた値」と見なすと**3件とも永久に競合に残る**が、
 * 中身の無い入れ物は育てた値ではなく残骸である。
 *
 * **削除の場合だけに限る。** 追加・変更では空を特別扱いしない（意図して空にしたのかもしれない）。
 */
const isEmptyContainer = (v) =>
  (isPlainObject(v) && Object.keys(v).length === 0) || (Array.isArray(v) && v.length === 0);

/** 配列を集合として3方向マージする */
function mergeArray3(a, b, c) {
  const key = (e) => JSON.stringify(canon(e));
  const aKeys = new Set(a.map(key));
  const bKeys = new Set(b.map(key));
  const removed = new Set([...aKeys].filter((k) => !bKeys.has(k)));
  const out = c.filter((e) => !removed.has(key(e)));
  const present = new Set(out.map(key));
  for (const e of b) {
    if (!aKeys.has(key(e)) && !present.has(key(e))) {
      out.push(e);
      present.add(key(e));
    }
  }
  return out;
}

/**
 * JSON の3方向マージ。
 *
 * @returns {{merged: unknown, conflicts: string[], changes: {added: string[], updated: string[], deleted: string[]}}}
 *   `conflicts` は食い違ったキーのパス。`changes` は**実際に動かしたキーのパス**。
 *
 * **`changes` は飾りではない。** この分類は承認を求めずに適用するので、
 * **「何が消えたか」を利用者へ出せないと説明責任が果たせない**
 * （`template-improvement` が承認不要なのは A=C ＝ 守るべきローカルの意図が無いからで、
 * この分類は A≠C なので同じ論法が使えない。SKILL.md「なぜ全ファイル承認をやめたのか」を参照）。
 */
function mergeJson3(a, b, c, at = "", conflicts = [], changes = { added: [], updated: [], deleted: [] }) {
  if (isPlainObject(a) && isPlainObject(b) && isPlainObject(c)) {
    const out = { ...c };
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = at ? `${at}.${k}` : k;
      const inA = k in a;
      const inB = k in b;
      const inC = k in out;

      if (inA && !inB) {
        if (!inC) continue;
        if (same(out[k], a[k]) || isEmptyContainer(out[k])) {
          delete out[k];
          changes.deleted.push(p);
        } else conflicts.push(p);
        continue;
      }
      if (!inA && inB) {
        if (!inC) {
          out[k] = b[k];
          changes.added.push(p);
        } else if (!same(out[k], b[k])) {
          // テンプレートもプロジェクトも新しく足した。**降りられるなら降りる** —
          // 降りないとキー丸ごと競合になり、生成時の deepMerge（配列は union）と向きが食い違う。
          // A を「空」と見なして同じ規則を当てる。
          if (isPlainObject(b[k]) && isPlainObject(out[k])) {
            out[k] = mergeJson3({}, b[k], out[k], p, conflicts, changes).merged;
          } else if (Array.isArray(b[k]) && Array.isArray(out[k])) {
            out[k] = mergeArray3([], b[k], out[k]);
            changes.updated.push(p);
          } else conflicts.push(p);
        }
        continue;
      }
      // inA && inB
      if (same(a[k], b[k])) continue; // テンプレートは変えていない → C のまま
      if (!inC) {
        conflicts.push(p); // テンプレートが変えたキーをプロジェクトが消している
        continue;
      }
      if (same(out[k], a[k])) {
        // プロジェクトは触っていないので B を採ればよい。**ただしオブジェクトは降りる** —
        // 丸ごと置き換えると `changes` が「permissions を変更」としか言えず、
        // **中で何が消えたのか（例: permissions.ask）が利用者に見えない**。
        // C==A なので、降りた結果は B と同じ内容になる。
        if (isPlainObject(a[k]) && isPlainObject(b[k]) && isPlainObject(out[k])) {
          out[k] = mergeJson3(a[k], b[k], out[k], p, conflicts, changes).merged;
        } else {
          out[k] = b[k];
          changes.updated.push(p);
        }
        continue;
      }
      if (same(out[k], b[k])) continue; // 適用済み
      // 三者すべて違う → 1段下へ降りられるか
      if (isPlainObject(a[k]) && isPlainObject(b[k]) && isPlainObject(out[k])) {
        out[k] = mergeJson3(a[k], b[k], out[k], p, conflicts, changes).merged;
      } else if (Array.isArray(a[k]) && Array.isArray(b[k]) && Array.isArray(out[k])) {
        const before = out[k];
        out[k] = mergeArray3(a[k], b[k], out[k]);
        if (!same(before, out[k])) changes.updated.push(p);
      } else {
        conflicts.push(p);
      }
    }
    return { merged: out, conflicts, changes };
  }

  if (Array.isArray(a) && Array.isArray(b) && Array.isArray(c)) {
    const merged = mergeArray3(a, b, c);
    if (!same(c, merged)) changes.updated.push(at || "(ルート)");
    return { merged, conflicts, changes };
  }

  // 型が揃っていない／スカラー
  if (same(a, b)) return { merged: c, conflicts, changes };
  if (same(c, a)) {
    changes.updated.push(at || "(ルート)");
    return { merged: b, conflicts, changes };
  }
  if (same(c, b)) return { merged: c, conflicts, changes };
  conflicts.push(at || "(ルート)");
  return { merged: c, conflicts, changes };
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

/**
 * JSON のキー単位マージを試す。
 * マージできたら `auto-merge`（適用可）を返し、結果を work/merged/<rel> へ書く。
 * 食い違うキーが残れば `conflict` のまま、**どのキーか**を note に載せて返す。
 * パースできなければ null（従来の分類にまかせる）。
 */
function tryJsonMerge(rel, aText, bText, cText, work) {
  let a, b, c;
  try {
    a = JSON.parse(aText);
    b = JSON.parse(bText);
    c = JSON.parse(cText);
  } catch {
    return null; // 壊れた JSON は人が見る
  }
  const { merged, conflicts, changes } = mergeJson3(a, b, c);
  const summary = () => {
    const parts = [];
    // **削除を先に出す。** 自動適用で一番知りたいのは「何が消えるか」である。
    if (changes.deleted.length) parts.push(`削除: ${changes.deleted.join(" / ")}`);
    if (changes.updated.length) parts.push(`変更: ${changes.updated.join(" / ")}`);
    if (changes.added.length) parts.push(`追加: ${changes.added.join(" / ")}`);
    return parts.join("、") || "変更なし";
  };
  if (conflicts.length) {
    return {
      kind: "conflict",
      note: `食い違うキー: ${conflicts.join(" / ")}（他は自動で統合できる — ${summary()}）`,
      changes,
      conflictKeys: conflicts,
    };
  }
  if (same(merged, c)) return { kind: "already-applied", note: "同じ変更が既に入っている" };

  const dest = path.join(work, MERGED_REL, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return { kind: "auto-merge", how: "json", note: `キー単位で統合した — ${summary()}`, changes };
}

/**
 * 行単位で3方向マージする対象（§0-4c）
 *
 * `.gitignore` は**テンプレートが配り、プロジェクトも足す**ファイルなので、
 * `settings.json` と同じ理由で `conflict` が既定になる（実測: 2/3 のプロジェクトで競合）。
 * ただし JSON ではないのでキー単位に分けられない。
 *
 * **`git merge-file` を使う。** 自前で行をマージしない。理由は2つ:
 *
 * 1. **順序を保つ必要がある。** `.gitignore` は後の行が勝つ（`*.log` の後の `!keep.log`）。
 *    集合として足し引きして末尾へ足すと、**テンプレートが足した無視パターンが
 *    プロジェクトの打ち消しを上書きしてしまう**
 * 2. **行単位の3方向マージは git が持っている。** 実測（2026-10-08）でも、
 *    テンプレートが足した1行を**元の節の中（12行目の次）へ挿入**し、
 *    プロジェクトが末尾に足した6行をそのまま残した
 *
 * **衝突したら自動適用しない**（`conflict` のまま人へ返す）。実測では、
 * テンプレート層を持たない旧世代の `.gitignore` が正しく衝突した。
 */
//
// **`docs/backlog.md`（台帳）も行単位でマージする**（0.30.0）。あれは
// **テンプレートが骨格を配り、プロジェクトが行を足して育てる**ファイルで、
// 行が1本でも入ると A≠B かつ A≠C になり `conflict` が既定になる。
// **競合解決でテンプレート側を採ると、残作業の行が丸ごと消える** — 生きた台帳なので実害が大きい。
// 骨格の変更（見出しの改名・コメントの差し替え）とプロジェクトの行は**別の位置にある**ので、
// `git merge-file` が素直に通る（`.gitignore` で実証済みの経路）。
// `SEED_ONCE` にしない理由: 以後の骨格の改善が永久に届かなくなるため。
const TEXT_MERGE_FILES = new Set([".gitignore", "docs/backlog.md"]);

/**
 * `git merge-file` を呼ぶ。衝突しても stdout の結果は使えるので、終了コードと一緒に返す。
 * @returns {{merged: string, conflicts: number} | null} git が使えなければ null
 */
function gitMergeFile(curFile, baseFile, otherFile) {
  try {
    const out = execFileSync("git", ["merge-file", "-p", curFile, baseFile, otherFile], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });
    return { merged: out, conflicts: 0 };
  } catch (e) {
    // 終了コードは衝突の数。stdout にはマーカー入りの結果が入っている
    // 終了コードは**衝突の数**（git は 127 で打ち切る）。**エラーは負値**で、
    // プロセスの終了コードとしては 255 などになる。それを「衝突 255 箇所」と報告すると、
    // 存在しない競合の突き合わせを人に求めることになる。
    if (typeof e.status === "number" && e.status >= 1 && e.status <= 127 && typeof e.stdout === "string") {
      return { merged: e.stdout, conflicts: e.status };
    }
    return null; // git が無い・使えない
  }
}

/**
 * 行の増減を数える（自動適用の説明責任。`mergeJson3` の `changes` と同じ役目）
 *
 * **集合ではなく出現回数で数える。** `.gitignore` では**同じ行の再掲が意味を変える** —
 * `!.env.example` の後ろに `.env*` がもう1つ足されると、`.env.example` が無視対象に変わる。
 * 集合で比べると「その行は既にある」ので**増分として報告されず、黙って適用される**（実測で再現）。
 */
function lineChanges(before, after) {
  const count = (text) => {
    const m = new Map();
    for (const l of text.split("\n").map((x) => x.trim()).filter(Boolean)) {
      m.set(l, (m.get(l) || 0) + 1);
    }
    return m;
  };
  const b = count(before);
  const a = count(after);
  const added = [];
  const deleted = [];
  for (const l of new Set([...b.keys(), ...a.keys()])) {
    const d = (a.get(l) || 0) - (b.get(l) || 0);
    for (let i = 0; i < d; i++) added.push(l);
    for (let i = 0; i < -d; i++) deleted.push(l);
  }
  return { added, deleted };
}

/**
 * **所有マーカー**で中と外の持ち主を分ける対象（§0-4d・H53-b）
 *
 * ## なぜファイル単位では足りないのか
 *
 * `constitution.md` は**テンプレート自身が §9「このプロジェクト固有の原則」を用意して
 * プロジェクトに書かせる**。つまり**使うほど `A≠C` が確定し、テンプレートが §1〜§8 を
 * 1行直すたびに `conflict` になる**（実測・2026-10-11: 導入済み7プロジェクトのうち3つが
 * プロジェクト側の内容を持ち、うち1つは47行）。
 *
 * 散文なので `git merge-file` には投げられない（行単位で混ぜると**意味が壊れる**）。
 * JSON のようにキーも無い。**残る境界は「どこからどこまでがハーネスのものか」の明示**である。
 *
 * ## なぜファイル分割（0.25.0 の `CLAUDE.md`）ではないのか
 *
 * `CLAUDE.md` は `@` import で**必ず読み込まれる**ので、切り出しても読み落ちない。
 * 一方 `constitution.md` は**必要になったときに読む文書**で、import されない。
 * 分割するとリンクを辿らない限り不変原則が読まれない経路が新しく増える。
 * **1ファイルのまま所有を分ける方が、読む側の経路を変えない。**
 */
const MARKER_FILES = new Set(["constitution.md"]);

const MARKER_BEGIN = "<!-- harness:begin";
const MARKER_END = "<!-- harness:end";

/**
 * 所有マーカーで本文を3つに割る。
 *
 * **行の配列で返す。** 文字列で返して連結すると、**境界の改行が落ちる**
 * （検査で実際に踏んだ。前書きとマーカー行がつながってしまう）。
 *
 * @returns {{before: string[], owned: string[], after: string[]} | null} マーカーが無ければ null
 */
function splitByMarker(text) {
  const lines = text.split("\n");
  const begin = lines.findIndex((l) => l.trimStart().startsWith(MARKER_BEGIN));
  if (begin < 0) return null;
  const end = lines.findIndex((l, i) => i > begin && l.trimStart().startsWith(MARKER_END));
  if (end < 0) return null;
  // **2組目以降は見ない。** 1ファイルに1組だけという前提をここで固定する
  // （複数組を許すと「どの組が対応するか」を決める規則が要る）
  return {
    before: lines.slice(0, begin),
    owned: lines.slice(begin, end + 1),
    after: lines.slice(end + 1),
  };
}

/**
 * 所有マーカーの中だけをテンプレートの内容へ置き換える。
 *
 * **外は一切触らない。** 中が同じなら `already-applied`、
 * どちらかにマーカーが無ければ `null`（呼び出し側が `conflict` のまま残す）。
 */
function tryMarkerMerge(rel, bText, cText, work) {
  const bParts = splitByMarker(bText);
  const cParts = splitByMarker(cText);
  if (!bParts || !cParts) return null;

  const merged = [...cParts.before, ...bParts.owned, ...cParts.after].join("\n");
  if (merged === cText) return { kind: "already-applied", note: "同じ変更が既に入っている" };

  const ch = lineChanges(cParts.owned.join("\n"), bParts.owned.join("\n"));
  const parts = [];
  if (ch.deleted.length) parts.push(`削除 ${ch.deleted.length} 行`);
  if (ch.added.length) parts.push(`追加 ${ch.added.length} 行`);

  const dest = path.join(work, MERGED_REL, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, merged, "utf-8");
  return {
    kind: "auto-merge",
    how: "marker",
    note: `所有マーカーの中だけを置き換えた — ${parts.join("、") || "変更なし"}（外は触っていない）`,
    changes: { ...ch, updated: [] },
  };
}

/** 衝突マーカーの行か（`<<<<<<< ラベル` の形。単独の記号列も許す） */
function isMarker(line, sign) {
  return line === sign || line.startsWith(`${sign} `);
}

/**
 * `git merge-file` が返したマーカー入りの結果から、**衝突した場所**を読む。
 *
 * **「2箇所で衝突した」だけでは、人は現物のどこを見ればよいか分からない。**
 * 行番号（統合結果の中での位置）と、現物側（`<<<<<<<` の直後）の先頭行を出す。
 * 突き合わせる3ファイル（A/B/C）の置き場は apply の失敗メッセージが案内する。
 *
 * ## 行番号は**現物（C）**のものを出す
 *
 * 統合結果の中で数えると**現物とずれる** —— ①自動統合でテンプレート側が挿入した行、
 * ②先行する衝突のテンプレート側の行、が余分に入るため（査読の実測で最大4行ずれた）。
 * **「現物の N 行目」と言うなら、現物を開いたときの位置でなければ意味がない。**
 *
 * そこで**文脈行を手がかりに現物の中を前方へ追う**。衝突の直前に一致した文脈行の
 * 次の行を、そのハンクの位置とする。見つからないときは**番号を出さない**（嘘を言わない）。
 *
 * @param {string} merged マーカー入りの統合結果
 * @param {string} cText 現物（C）の全文
 * @param {number} expected `git merge-file` が返した衝突の数（**偽マーカーの安全弁**）
 * @returns {string} 例: `現物の 12 行目付近「.env*」/ 40 行目付近「dist/」`
 */
function conflictHunks(merged, cText, expected) {
  const lines = merged.split("\n");
  const cLines = cText.split("\n");
  const out = [];
  let cursor = 0; // 現物の中で、ここまで照合し終えた位置（0 始まり）

  // 現物の `from` 以降から `text` と同じ行を探す（単調に進める）
  const findIn = (text, from) => {
    for (let k = from; k < cLines.length; k++) if (cLines[k] === text) return k;
    return -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // **三つ組が順に揃ったものだけをハンクと見る。** 現物に `<<<<<<<` や `=======` に
    // 似た行（setext 見出しの下線・前回の解決の残骸）があると、件数と場所が食い違う
    if (!isMarker(l, "<<<<<<<")) {
      const at = findIn(l, cursor);
      if (at >= 0) cursor = at + 1;
      continue;
    }
    let sep = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (sep < 0 && isMarker(lines[j], "=======")) sep = j;
      else if (sep >= 0 && isMarker(lines[j], ">>>>>>>")) {
        end = j;
        break;
      }
    }
    if (sep < 0 || end < 0) continue; // 揃っていない = マーカーではない

    const mine = lines.slice(i + 1, sep); // 現物側
    const hint = mine.map((t) => t.trim()).find(Boolean) || "";
    // 現物側の最初の行を現物の中で探し、**その位置**を報告する。
    // 現物側が空（プロジェクトが消した）なら、直前の文脈行の次を指す
    let at = hint ? findIn(mine.find((t) => t.trim()), cursor) : cursor;
    if (at < 0) at = -1;
    out.push({ at, hint });
    if (at >= 0) cursor = at + Math.max(mine.length, 1);
    i = end; // ハンクを読み飛ばす
  }

  // **件数は `git merge-file` が返した数が正。** 超えたら読み違えているので場所を出さない
  if (!out.length || (expected && out.length > expected)) return "";
  const shown = out.slice(0, 5).map((h) =>
    `${h.at >= 0 ? `${h.at + 1} 行目付近` : "位置は特定できず"}${h.hint ? `「${h.hint}」` : ""}`
  );
  return (
    `現物の ${shown.join(" / ")}` +
    (out.length > shown.length ? ` ほか ${out.length - shown.length} 箇所` : "")
  );
}

/**
 * 行単位のマージを試す。
 * 統合できたら `auto-merge` を返し、結果を work/merged/<rel> へ書く。
 * 衝突が残れば `conflict` のまま、**何箇所か**を note に載せて返す。
 */
function tryTextMerge(rel, aText, bText, cText, work) {
  // 一意な名前にする（このリポジトリは複数セッションが同時に触る。固定名だと並行実行が壊し合う）
  fs.mkdirSync(path.join(work, MERGED_REL), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(work, MERGED_REL, ".3way-"));
  let r;
  try {
    const w = (name, text) => {
      const f = path.join(tmp, name);
      fs.writeFileSync(f, text, "utf-8");
      return f;
    };
    r = gitMergeFile(w("current", cText), w("base", aText), w("latest", bText));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (!r) return null;

  if (r.conflicts > 0) {
    const where = conflictHunks(r.merged, cText, r.conflicts);
    return {
      kind: "conflict",
      note: `行の衝突が ${r.conflicts} 箇所${where ? `（${where}）` : ""}。自動では統合できない`,
    };
  }
  if (r.merged === cText) return { kind: "already-applied", note: "同じ変更が既に入っている" };

  const ch = lineChanges(cText, r.merged);
  // **増減が無いのに中身が違う ＝ 並べ替えだけ。** `.gitignore` では順序こそが意味なので
  // （後の行が勝つ）、何が変わったかを言えないまま自動適用しない。
  if (!ch.added.length && !ch.deleted.length) {
    return { kind: "conflict", note: "行の順序だけが変わる（何が変わるか言えないので自動適用しない）" };
  }
  const parts = [];
  if (ch.deleted.length) parts.push(`削除: ${ch.deleted.join(" / ")}`);
  if (ch.added.length) parts.push(`追加: ${ch.added.join(" / ")}`);

  const dest = path.join(work, MERGED_REL, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, r.merged, "utf-8");
  return {
    kind: "auto-merge",
    how: "text",
    note: `行単位で統合した — ${parts.join("、") || "変更なし"}`,
    changes: { ...ch, updated: [] },
  };
}

function cmdAnalyze(opts) {
  const { environment, baseline } = loadProjectState(opts.project);

  const placeholders = { ...(baseline?.placeholders || {}) };
  for (const [k, v] of opts.set) placeholders[k] = v;

  const work = path.join(opts.project, WORK_REL);
  fs.mkdirSync(work, { recursive: true });
  // **上書きする前に前回の report を読む**（H53-f）。競合が「解決されたか」は
  // analyze 時点のハッシュとの比較で判定するため、**解決してから analyze をやり直すと
  // 証拠が消える**（新しいハッシュは解決後の現物と一致してしまい、finalize が
  // 「手つかず」と判定して --force を要求する）。2026-10-08 の展開では
  // **4プロジェクトすべてで --force が必要**になった。
  const prevReport = readJson(path.join(work, "report.json"));
  // 前回の統合結果を残さない（別のコミットに対する結果がディスクに居座るのを避ける）
  fs.rmSync(path.join(work, MERGED_REL), { recursive: true, force: true });

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

  // 比較対象は A ∪ B に存在するファイルだけ。プロジェクト側のツリーは walk しない —
  // C にしか無いファイルは定義上すべて「プロジェクト固有」で対象外なうえ、
  // 実プロジェクトの walk は node_modules / Library / .next 等の巨大ツリーを舐めてしまう。
  const rels = new Set([...walk(latestDir), ...(baseDir ? walk(baseDir) : [])]);

  const results = [];
  for (const rel of [...rels].sort()) {
    if (isNeverTouch(rel)) continue;
    const a = baseDir ? readText(path.join(baseDir, rel)) : null;
    const b = readText(path.join(latestDir, rel));
    const c = readText(path.join(opts.project, rel));
    // 配り切り: **現物があれば以後は一切触らない**（記入済みの実態を雛形で上書きしない）。
    // 無いときだけ比較に乗せる = 初回は `template-improvement` として配られる。
    if (isSeedOnce(rel) && c !== null) continue;

    // 現物が無い配り切りは **`classify` を通さない**（通すと `project-local` になり配られない）。
    let verdict =
      isSeedOnce(rel) && c === null ? seedOnceVerdict(rel, opts.project) : classify(a, b, c);
    if (!verdict || verdict.kind === "unchanged") continue;

    // JSON はキー単位で3方向マージする（§0-4b）。baseline が無いときは従来どおり。
    if (JSON_MERGE_FILES.has(rel) && verdict.kind === "conflict" && a !== null && c !== null) {
      const merged = tryJsonMerge(rel, a, b, c, work);
      if (merged) verdict = merged;
    }
    // 行単位（§0-4c）。JSON でないテキストは `git merge-file` に任せる
    if (TEXT_MERGE_FILES.has(rel) && verdict.kind === "conflict" && a !== null && c !== null) {
      const merged = tryTextMerge(rel, a, b, c, work);
      if (merged) verdict = merged;
    }
    // 所有マーカーの中だけを置き換える（§0-4d・H53-b）。**baseline は要らない** ——
    // 境界が文書に書いてあるので、A を見なくても「どこがハーネスのものか」が分かる
    if (MARKER_FILES.has(rel) && verdict.kind === "conflict" && b !== null && c !== null) {
      const merged = tryMarkerMerge(rel, b, c, work);
      if (merged) verdict = merged;
      else if (splitByMarker(b) && !splitByMarker(c)) {
        // **移行は一度だけ。** 現物にマーカーが無い（0.40.0 より前に生成した）
        verdict = {
          kind: "conflict",
          note:
            "所有マーカーが現物に無い（0.40.0 で一度だけの移行）。" +
            "テンプレートの begin / end を現物へ入れ、プロジェクト固有の原則を end の外へ出す。" +
            "手順は harness-update/SKILL.md の「constitution.md の移行は一度だけ」",
        };
      }
    }
    // 競合は finalize で「解決されたか」を判定する必要がある。
    // 判定に使うため、analyze 時点の現物のハッシュを控えておく（下の cmdFinalize を参照）
    const entry = { file: rel, ...verdict };
    // conflict は finalize で「解決されたか」を、auto-merge は apply で
    // 「analyze 以降に現物が変わっていないか」を見るために控える。
    if (verdict.kind === "conflict" || verdict.kind === "auto-merge") entry.currentHash = hashOf(c);
    // **conflict だけは、同じ更新に対する前回の analyze のハッシュを引き継ぐ**（H53-f）。
    // こちらの用途は「人が手を入れたか」の証拠なので、基準は
    // **この更新で最初に analyze したときの現物**でなければならない。
    // auto-merge は引き継がない —— あちらの用途は apply の安全弁（統合結果が
    // 今の現物から作られたものか）で、analyze をやり直せば統合結果も作り直されるため、
    // 古いハッシュを持ち越すと正当な apply を拒否してしまう。
    // 引き継ぐのは**同じ3点比較に対する前回の結果**だけ。比較の両端（最新と baseline）が
    // 同じでなければ `conflict` の意味が違う（2点比較の report は全部 conflict になる）。
    // `files` が配列でない壊れた report でも落ちないようにする
    if (
      verdict.kind === "conflict" &&
      prevReport?.latestCommit === latestCommit &&
      prevReport?.baselineCommit === (haveBaseline ? baselineCommit : null) &&
      Array.isArray(prevReport?.files)
    ) {
      const prev = prevReport.files.find((f) => f.file === rel);
      if (prev?.kind === "conflict" && prev.currentHash) entry.currentHash = prev.currentHash;
    }
    results.push(entry);
  }

  const configDiff = schemaDiff(
    baseDir ? readJson(path.join(baseDir, CONFIG_REL)) : null,
    readJson(path.join(latestDir, CONFIG_REL)),
    readJson(path.join(opts.project, CONFIG_REL))
  );

  const report = {
    // **いつ作った report か**を残す。競合の「手つかず」判定の基準は
    // この report のハッシュなので、古い report を使い回すと基準も古くなる（下の cmdFinalize）
    createdAt: new Date().toISOString(),
    environment,
    baselineCommit: haveBaseline ? baselineCommit : null,
    latestCommit,
    repoSource: repo.source,
    twoWayFallback: !haveBaseline,
    placeholders,
    warnings,
    workDir: path.relative(opts.project, work).split(path.sep).join("/"),
    idealDir: path.relative(opts.project, latestDir).split(path.sep).join("/"),
    mergedDir: path.relative(opts.project, path.join(work, MERGED_REL)).split(path.sep).join("/"),
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
  "auto-merge": "ファイルより細かい単位で統合済み（適用を提案）",
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

  for (const kind of ["template-improvement", "auto-merge", "conflict", "template-removed", "project-local", "already-applied"]) {
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
  const byFile = new Map(report.files.map((f) => [f.file, f]));
  const applied = [];
  for (const rel of opts.files) {
    if (isNeverTouch(rel)) fail(`${rel} は追従対象外です（プロジェクトの資産）。`);
    if (isSeedOnce(rel) && fs.existsSync(path.join(opts.project, rel))) {
      fail(
        `${rel} は配り切りのファイルで、既にプロジェクトが持っています。
` +
          `ここはプロジェクトの実態を書く場所なので、テンプレートで上書きしません。
` +
          `構成そのものを見直したいときは、テンプレートの同名ファイルを見て手で取り込んでください。`
      );
    }

    // 競合をまとめて上書きさせない（「ローカル改変の無断上書き禁止」の機械的な担保）。
    // 競合は A/B/C を突き合わせてハンク単位で解決し、Edit で書くこと。
    // **未知の分類は拒否する（既定拒否）。** 分類名は report.json というディスク上の契約で、
    // 古い版の report を新しい版の apply に食わせると、**どのガードにも当たらず
    // 「あるべき姿（B）」で上書きしてしまう** — プロジェクト固有の値が無警告で消える。
    // 実際に `json-merge` → `auto-merge` の改名（0.26.0）でこの穴が開いた。
    const KNOWN_KINDS = new Set([
      "template-improvement",
      "auto-merge",
      "project-local",
      "already-applied",
      "conflict",
      "template-removed",
    ]);
    const kind = byFile.get(rel)?.kind;
    if (kind === undefined) {
      fail(`${rel} は report.json にありません。先に analyze を実行してください。`);
    }
    if (!KNOWN_KINDS.has(kind)) {
      fail(
        `${rel} の分類 "${kind}" は、この版の apply が知らないものです。\n` +
          `report.json が古い版で作られている可能性があります。analyze をやり直してください。`
      );
    }

    if (byFile.get(rel)?.kind === "conflict") {
      fail(
        `${rel} は「競合」に分類されています。apply では上書きしません。\n` +
          `  A（前回適用時）: ${report.baselineDir ? report.baselineDir + "/" + rel : "(baseline 無し)"}\n` +
          `  B（最新）      : ${report.idealDir}/${rel}\n` +
          `  C（現物）      : ${rel}\n` +
          `この3つを突き合わせ、ハンク単位でユーザーの判断を得てから直接編集してください。`
      );
    }

    // ローカル改変の上書きも既定で拒否する（apply は B の内容で上書きするため、
    // project-local に対して実行するとローカルの変更が失われる = テンプレートへの巻き戻し）。
    // 意図的に巻き戻す場合のみ --force。
    if (byFile.get(rel)?.kind === "project-local" && !opts.force) {
      fail(
        `${rel} は「プロジェクト固有の改変」に分類されています。apply するとローカルの変更が` +
          `テンプレートの内容で失われます。テンプレートへ意図的に戻す場合のみ --force を付けてください。`
      );
    }

    // auto-merge は「B で上書き」ではなく「細かい単位で統合した結果」を書く（§0-4b・§0-4c）。
    // 統合結果は analyze 時点の現物から作ったものなので、**その後に現物が変わっていたら書かない**
    // （project-local を --force で守っているのと同じ理由。ここだけ無検査で上書きしていた）。
    const entry = byFile.get(rel);
    const isAutoMerge = entry?.kind === "auto-merge" && report.mergedDir;
    if (isAutoMerge && entry.currentHash) {
      const now = hashOf(readText(path.join(opts.project, rel)));
      if (now !== entry.currentHash) {
        fail(
          `${rel} は analyze 以降に変更されています。統合結果は analyze 時点の内容から作ったものなので、` +
            `そのまま書くと今の変更が失われます。\nanalyze をやり直してください。`
        );
      }
    }
    const src = isAutoMerge
      ? path.join(opts.project, report.mergedDir, rel)
      : path.join(idealDir, rel);
    const content = readText(src);
    if (content === null) fail(`${rel} は「あるべき姿」に存在しません。パスを確認してください。`);
    const dest = path.join(opts.project, rel);
    // **書く前に、現物の改行と BOM を見る。**
    // readText が CRLF を LF へ、BOM を無しへ揃えるので、apply は差分の中身と関係なく
    // **ファイル全体の改行を書き換える**ことがある。**差分には現れないので黙って起きる**
    // （ステージ時の正規化で blob が変わり、他セッションの作業と食い違った先例がある）。
    const rawBefore = (() => {
      try {
        return fs.readFileSync(dest, "latin1");
      } catch {
        return null;
      }
    })();
    const reshaped = [];
    if (rawBefore !== null) {
      const keepsBom = path.extname(dest).toLowerCase() === ".ps1";
      const hadBom = rawBefore.startsWith("\xEF\xBB\xBF");
      if (rawBefore.includes("\r\n")) reshaped.push("改行を LF に揃えた（現物は CRLF）");
      if (hadBom && !keepsBom) reshaped.push("BOM を落とした");
      if (!hadBom && keepsBom) reshaped.push("BOM を付けた（.ps1 の規約）");
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // 出力規約は create-project と同じ（UTF-8 BOM 無し・LF、.ps1 のみ BOM 付き）
    const bom = path.extname(dest).toLowerCase() === ".ps1" ? "﻿" : "";
    fs.writeFileSync(dest, bom + content, "utf-8");
    applied.push({ rel, reshaped });
  }
  console.log(`適用しました（${applied.length} 件）:`);
  for (const f of applied) {
    console.log(`  ${f.rel}${f.reshaped.length ? ` — ${f.reshaped.join("、")}` : ""}`);
  }
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

  // 競合が「解決されたか」は **最初の analyze 以降に人が手を入れたか** で判定する。
  // 基準になるハッシュは analyze が引き継ぐ（H53-f。やり直しても証拠が消えない）。
  //
  // かつては「現物 == 最新テンプレート」を解決条件にしていたが、競合の正しい解決は
  // 多くの場合「テンプレートの改善 + ローカル改変の統合」であり、**必然的にテンプレートとは
  // 一致しない**。そのため正しく統合するほど「未解決」と判定され、毎回 --force が要求されていた。
  // 本来「見送り」用の安全弁が日常操作になって鈍る（C1 の還元 #14。実際に2回とも要求された）。
  //
  // 手を入れていれば、統合したのであれテンプレートを丸ごと採ったのであれ、人が判断を下している。
  // 手つかずのままなら、それが本当の「見送り」なので従来どおり --force を要求する。
  const unresolvedConflicts = report.files
    .filter((f) => f.kind === "conflict")
    .filter((f) => {
      // analyze 時のハッシュが無い古い report は、従来どおりテンプレートとの一致で判定する
      if (!f.currentHash) return stillDiffers(f.file);
      // ここで比べる currentHash は「この更新で最初に analyze したときの現物」（H53-f）
      const now = hashOf(readText(path.join(opts.project, f.file)));
      return now === f.currentHash;
    })
    .map((f) => f.file);

  // **基準が古いと、解決と無関係な編集でも「解決済み」に見える。**
  // 判定は「最初の analyze 以降に手を入れたか」なので、report を何日も放置して使い回すと、
  // その間に入った無関係な編集まで「解決」として数えてしまう。黙って進めない
  const reportAgeHours = report.createdAt
    ? (Date.now() - Date.parse(report.createdAt)) / 3600000
    : null;
  if (reportAgeHours !== null && reportAgeHours > 24) {
    console.warn(
      `⚠️  この report は ${Math.floor(reportAgeHours / 24)} 日前の analyze で作られています` +
        `（${report.createdAt}）。`
    );
    console.warn(
      "    競合の「解決したか」はこの時点の内容と比べて判定します。" +
        "判定をやり直したいときは .claude/.harness-update/ を消して analyze から始めてください。\n"
    );
  }

  if (unresolvedConflicts.length && !opts.force) {
    fail(
      `手つかずの競合が ${unresolvedConflicts.length} 件残っています:\n` +
        unresolvedConflicts.map((f) => `  ${f}`).join("\n") +
        `\n\nこれらは analyze 以降ファイルが変更されていません。` +
        `\nbaseline を進めると、次回から「プロジェクト固有の改変」に見え、` +
        `\nテンプレート側の変更が差分として出てこなくなります。` +
        `\n先に競合を解決してください。意図的に見送る場合のみ --force を付けてください。`
    );
  }

  // auto-merge は「統合結果」と比べる（B とは意図的に一致しないため stillDiffers では判定できない）
  const mergedDiffers = (rel) => {
    if (!report.mergedDir) return true;
    const m = readText(path.join(opts.project, report.mergedDir, rel));
    if (m === null) return true;
    const c = readText(path.join(opts.project, rel));
    try {
      return !same(JSON.parse(m), JSON.parse(c));
    } catch {
      return m !== c;
    }
  };

  const unappliedImprovements = [
    ...report.files.filter((f) => f.kind === "template-improvement").map((f) => f.file).filter(stillDiffers),
    ...report.files.filter((f) => f.kind === "auto-merge").map((f) => f.file).filter(mergedDiffers),
  ];

  if (unappliedImprovements.length) {
    console.warn(`⚠️  未適用のテンプレート改善が ${unappliedImprovements.length} 件あります:`);
    for (const f of unappliedImprovements) console.warn(`      ${f}`);
    console.warn("    これらは次回から「プロジェクト固有の改変」として扱われます（再提案されません）。\n");
  }

  // template-removed も baseline が進むと視界から消える（A からも消えるため）。
  // 「残す」は正当な判断なのでブロックはしないが、黙って飲み込まない
  const unresolvedRemovals = report.files
    .filter((f) => f.kind === "template-removed")
    .map((f) => f.file)
    .filter((rel) => readText(path.join(opts.project, rel)) !== null);

  if (unresolvedRemovals.length) {
    console.warn(`⚠️  テンプレートから削除されたファイルが ${unresolvedRemovals.length} 件プロジェクトに残っています:`);
    for (const f of unresolvedRemovals) console.warn(`      ${f}`);
    console.warn("    残す判断は有効ですが、次回以降は差分として提示されません。\n");
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

// エントリポイントとして起動されたときだけ実行する（require されたときは判定関数を取り出せるように）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
const opts = parseArgs(process.argv.slice(2));
try {
  if (opts.command === "analyze") cmdAnalyze(opts);
  else if (opts.command === "apply") cmdApply(opts);
  else if (opts.command === "finalize") cmdFinalize(opts);
  else fail(`不明なコマンド: ${opts.command}（analyze | apply | finalize）`);
} catch (e) {
  fail(e?.message || String(e));
}
}

export {
  classify,
  isNeverTouch,
  isSeedOnce,
  seedOnceVerdict,
  mergeJson3,
  mergeArray3,
  tryJsonMerge,
  tryTextMerge,
  tryMarkerMerge,
  splitByMarker,
  lineChanges,
  JSON_MERGE_FILES,
  TEXT_MERGE_FILES,
  MARKER_FILES,
};
