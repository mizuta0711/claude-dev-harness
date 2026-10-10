import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIFF = path.join(
  ROOT,
  "plugins",
  "harness-core",
  "skills",
  "harness-update",
  "scripts",
  "harness-diff.mjs",
);

// ---------------------------------------------------------------------------
// `analyze` / `apply` / `finalize` を**実際に通す**（H53-a）
//
// ここまで `harness-diff.mjs` の検査は純関数（classify / mergeJson3 / tryTextMerge）
// だけで、**3つのコマンドを通すテストが1本も無かった**。
// 0.26.0 の査読が見つけた高①（古い report.json で無警告上書き）はここをすり抜けている。
//
// テンプレート本体ではなく**偽のハーネスリポジトリ**を相手にする。
// `analyze` が要求するのは「`tools/create-project.mjs` を持つ git リポジトリ」だけで、
// あとはそれを `--env` / `--dest` / `--set` 付きで実行した結果を比較するため、
// 骨格を模した小さなリポジトリで配線を検査できる（本物の templates を使うと
// 1ケースごとに全環境を生成することになり、守りたい配線と関係のない重さが乗る）。
// ---------------------------------------------------------------------------

const ENV = "nextjs";

/** 偽の create-project.mjs。`payload/` を `--dest` へ写し、{{KEY}} を置換する */
const STUB = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  "const argv = process.argv.slice(2);",
  "let dest = null; const set = new Map();",
  "for (let i = 0; i < argv.length; i++) {",
  "  if (argv[i] === '--dest') dest = argv[++i];",
  "  else if (argv[i] === '--set') { const kv = argv[++i]; const e = kv.indexOf('='); set.set(kv.slice(0, e), kv.slice(e + 1)); }",
  "}",
  // パスにスペースや非 ASCII が入ると、URL の pathname をそのまま使うと壊れる
  "const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'payload');",
  "const walk = (d, base) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {",
  "  const full = path.join(d, e.name);",
  "  return e.isDirectory() ? walk(full, base) : [path.relative(base, full)];",
  "});",
  "for (const rel of walk(src, src)) {",
  "  let body = fs.readFileSync(path.join(src, rel), 'utf-8');",
  "  for (const [k, v] of set) body = body.split('{{' + k + '}}').join(v);",
  "  const out = path.join(dest, rel);",
  "  fs.mkdirSync(path.dirname(out), { recursive: true });",
  "  fs.writeFileSync(out, body, 'utf-8');",
  "}",
].join("\n");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(dir, rel, body) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, "utf-8");
}

/** 偽ハーネスリポジトリを作る。payload を2世代コミットし、両方のコミットを返す */
function mkTemplateRepo(root, generations) {
  const dir = path.join(root, "harness");
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "t"], dir);
  write(dir, "tools/create-project.mjs", STUB);
  const commits = [];
  for (const files of generations) {
    fs.rmSync(path.join(dir, "payload"), { recursive: true, force: true });
    for (const [rel, body] of Object.entries(files)) write(dir, path.join("payload", rel), body);
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", `gen${commits.length}`], dir);
    commits.push(git(["rev-parse", "HEAD"], dir));
  }
  return { dir, commits };
}

/** プロジェクトを作る（config と baseline を置き、現物を書く） */
function mkProject(root, baselineCommit, files) {
  const dir = path.join(root, "project");
  fs.mkdirSync(dir, { recursive: true });
  write(dir, ".claude/harness.config.json", JSON.stringify({ schemaVersion: 1, environment: ENV }, null, 2));
  write(
    dir,
    ".claude/harness-baseline.json",
    JSON.stringify({ templatesCommit: baselineCommit, environment: ENV }, null, 2),
  );
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  return dir;
}

/**
 * コマンドを実行し、終了コードと**stdout + stderr**を返す。
 *
 * 未適用・未解決の警告は `console.warn`（＝ stderr）で出る。stdout だけを見ると
 * 「警告が出ていない」ことを確かめたつもりで何も確かめていない状態になる。
 */
function exec(command, project, repo, extra = []) {
  const r = spawnSync(
    process.execPath,
    [DIFF, command, "--project", project, "--repo", repo, ...extra],
    { encoding: "utf-8" },
  );
  return { status: r.status, text: (r.stdout || "") + (r.stderr || "") };
}

/** 成功を期待する実行 */
function run(command, project, repo, extra = []) {
  const r = exec(command, project, repo, extra);
  assert.equal(r.status, 0, `${command} が失敗した:\n${r.text}`);
  return r.text;
}

/** 失敗を期待する実行。失敗しなければ null */
function runFail(command, project, repo, extra = []) {
  const r = exec(command, project, repo, extra);
  return r.status === 0 ? null : { status: r.status, stderr: r.text };
}

const analyze = (project, repo) => JSON.parse(run("analyze", project, repo, ["--json"]));
const kindOf = (report, rel) => report.files.find((f) => f.file === rel)?.kind ?? null;
const readReport = (project) =>
  JSON.parse(fs.readFileSync(path.join(project, ".claude/.harness-update/report.json"), "utf-8"));

/**
 * 3分類が出る土台。
 *
 * | ファイル | A→B | 現物 | 期待 |
 * |---|---|---|---|
 * | `docs/guide.md` | 変わる | A のまま | `template-improvement` |
 * | `notes.md` | 変わる | 独自 | `conflict` |
 * | `.gitignore` | 末尾に行が増える | **先頭に**行を足してある | `auto-merge`（行単位） |
 *
 * `.gitignore` のローカル改変を**先頭**に置いているのは意図的である。末尾に足すと
 * テンプレートの追記と同じハンクになり、`git merge-file` が衝突して `conflict` に落ちる
 * （H53 が「`.gitignore` は末尾で衝突する」と記録している性質）。
 */
function scenario() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-flow-"));
  const repo = mkTemplateRepo(root, [
    {
      "docs/guide.md": "# 手引き\n\nv1\n",
      "notes.md": "テンプレートの注記 v1\n",
      ".gitignore": "node_modules/\n.next/\n",
    },
    {
      "docs/guide.md": "# 手引き\n\nv2（テンプレート側の改善）\n",
      "notes.md": "テンプレートの注記 v2\n",
      ".gitignore": "node_modules/\n.next/\ncoverage/\n",
    },
  ]);
  const project = mkProject(root, repo.commits[0], {
    "docs/guide.md": "# 手引き\n\nv1\n",
    "notes.md": "プロジェクト独自の注記\n",
    ".gitignore": ".env.local\nnode_modules/\n.next/\n",
  });
  return { root, repo, project };
}

test("analyze: 3点比較の分類がコマンド経由でも出る（配線）", () => {
  const { root, repo, project } = scenario();
  try {
    const report = analyze(project, repo.dir);
    assert.equal(report.environment, ENV);
    assert.equal(report.latestCommit, repo.commits[1]);
    assert.equal(report.baselineCommit, repo.commits[0]);
    assert.equal(report.twoWayFallback, false);
    assert.equal(kindOf(report, "docs/guide.md"), "template-improvement");
    assert.equal(kindOf(report, "notes.md"), "conflict");
    assert.equal(kindOf(report, ".gitignore"), "auto-merge");
    // conflict / auto-merge には analyze 時点のハッシュが入る（finalize と apply が使う）
    const conflict = report.files.find((f) => f.file === "notes.md");
    assert.ok(conflict.currentHash, "conflict には currentHash が要る");
    // 統合結果は merged/ に置かれる
    const merged = fs.readFileSync(path.join(project, report.mergedDir, ".gitignore"), "utf-8");
    assert.match(merged, /\.env\.local/, "ローカルの行が残る");
    assert.match(merged, /coverage\//, "テンプレートの行が入る");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apply: auto-merge は merged/ の統合結果を書く（B の丸ごと上書きではない）", () => {
  const { root, repo, project } = scenario();
  try {
    analyze(project, repo.dir);
    run("apply", project, repo.dir, [".gitignore"]);
    const now = fs.readFileSync(path.join(project, ".gitignore"), "utf-8");
    assert.match(now, /\.env\.local/, "ローカルの行を消していない");
    assert.match(now, /coverage\//, "テンプレートの行が入っている");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apply: analyze 以降に現物が変わっていたら auto-merge を書かない", () => {
  const { root, repo, project } = scenario();
  try {
    analyze(project, repo.dir);
    // analyze のあとに人が触った。統合結果は古い内容から作ったものなので書いてはいけない
    fs.appendFileSync(path.join(project, ".gitignore"), "後から足した.txt\n", "utf-8");
    const failed = runFail("apply", project, repo.dir, [".gitignore"]);
    assert.ok(failed, "拒否されるはず");
    assert.match(failed.stderr, /analyze 以降に変更されています/);
    assert.match(fs.readFileSync(path.join(project, ".gitignore"), "utf-8"), /後から足した/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apply: 競合は上書きしない／未知の分類は既定拒否（0.26.0 の高①）", () => {
  const { root, repo, project } = scenario();
  try {
    analyze(project, repo.dir);
    const conflict = runFail("apply", project, repo.dir, ["notes.md"]);
    assert.ok(conflict);
    assert.match(conflict.stderr, /競合/);
    assert.match(fs.readFileSync(path.join(project, "notes.md"), "utf-8"), /プロジェクト独自/);

    // 古い版の report（知らない分類名）を食わせても、B で上書きしないこと
    const file = path.join(project, ".claude/.harness-update/report.json");
    const report = JSON.parse(fs.readFileSync(file, "utf-8"));
    for (const f of report.files) if (f.file === "docs/guide.md") f.kind = "json-merge";
    fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf-8");
    const unknown = runFail("apply", project, repo.dir, ["docs/guide.md"]);
    assert.ok(unknown, "未知の分類は拒否するはず");
    assert.match(unknown.stderr, /知らないもの/);
    assert.match(fs.readFileSync(path.join(project, "docs/guide.md"), "utf-8"), /v1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("finalize: 手つかずの競合が残っていたら止まる（--force で進む）", () => {
  const { root, repo, project } = scenario();
  try {
    analyze(project, repo.dir);
    const blocked = runFail("finalize", project, repo.dir);
    assert.ok(blocked, "手つかずの競合があるので止まるはず");
    assert.match(blocked.stderr, /手つかずの競合/);
    // baseline は進んでいない
    const baseline = JSON.parse(fs.readFileSync(path.join(project, ".claude/harness-baseline.json"), "utf-8"));
    assert.equal(baseline.templatesCommit, repo.commits[0]);

    run("finalize", project, repo.dir, ["--force"]);
    const after = JSON.parse(fs.readFileSync(path.join(project, ".claude/harness-baseline.json"), "utf-8"));
    assert.equal(after.templatesCommit, repo.commits[1]);
    assert.equal(fs.existsSync(path.join(project, ".claude/.harness-update")), false, "作業ディレクトリを消す");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("finalize: 解決した競合なら --force は要らない", () => {
  const { root, repo, project } = scenario();
  try {
    analyze(project, repo.dir);
    // テンプレートの改善とローカルの注記を統合した（＝テンプレートとは一致しない）
    fs.writeFileSync(path.join(project, "notes.md"), "テンプレートの注記 v2 ＋ プロジェクト独自の注記\n", "utf-8");
    const out = run("finalize", project, repo.dir);
    assert.match(out, /harness-baseline\.json を更新しました/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// H53-f: 解決してから analyze をやり直すと、判定の基準が解決後の内容になり、
// **解決したのに「手つかず」と判定されて --force を要求されていた。**
// 2026-10-08 の展開では4プロジェクトすべてで --force が必要になった。
test("finalize: 解決後に analyze をやり直しても --force を要求しない（H53-f）", () => {
  const { root, repo, project } = scenario();
  try {
    const first = analyze(project, repo.dir);
    const firstHash = first.files.find((f) => f.file === "notes.md").currentHash;
    fs.writeFileSync(path.join(project, "notes.md"), "テンプレートの注記 v2 ＋ プロジェクト独自の注記\n", "utf-8");

    // 解決したあとに状態を確かめ直す（現場では普通に起きる）
    const second = analyze(project, repo.dir);
    assert.equal(kindOf(second, "notes.md"), "conflict", "まだ競合として出る（統合なので B とは一致しない）");
    assert.equal(
      second.files.find((f) => f.file === "notes.md").currentHash,
      firstHash,
      "最初の analyze のハッシュを引き継ぐ",
    );

    const out = run("finalize", project, repo.dir);
    assert.match(out, /harness-baseline\.json を更新しました/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("analyze: auto-merge のハッシュは引き継がない（apply の安全弁を殺さない）", () => {
  const { root, repo, project } = scenario();
  try {
    analyze(project, repo.dir);
    // 人が触ってから analyze をやり直す。統合結果も作り直されるので apply は通るべき。
    // **先頭に足す**（末尾だとテンプレートの追記と衝突して conflict になり、別の理由で止まる）
    const gitignore = path.join(project, ".gitignore");
    fs.writeFileSync(gitignore, "後から足した.txt\n" + fs.readFileSync(gitignore, "utf-8"), "utf-8");
    analyze(project, repo.dir);
    run("apply", project, repo.dir, [".gitignore"]);
    const now = fs.readFileSync(path.join(project, ".gitignore"), "utf-8");
    assert.match(now, /後から足した/, "やり直し後の内容を土台にしている");
    assert.match(now, /coverage\//);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 引き継ぎの条件そのものを守る。**査読が変異テストで「条件を外しても12本全部通る」ことを示した** ——
// 条件は安全弁の本体なので、外れたら落ちるようにしておく。
test("analyze: 別コミットに対する report からは引き継がない", () => {
  const { root, repo, project } = scenario();
  try {
    analyze(project, repo.dir);
    const firstHash = readReport(project).files.find((f) => f.file === "notes.md").currentHash;
    // テンプレートがさらに進む ＝ 別の更新になる。前回の判定材料は使えない
    write(repo.dir, "payload/notes.md", "テンプレートの注記 v3\n");
    git(["add", "-A"], repo.dir);
    git(["commit", "-q", "-m", "gen2"], repo.dir);
    fs.writeFileSync(path.join(project, "notes.md"), "別の更新に向けて書き換えた\n", "utf-8");
    const report = analyze(project, repo.dir);
    const now = report.files.find((f) => f.file === "notes.md").currentHash;
    assert.notEqual(now, firstHash, "前の更新のハッシュを持ち越さない");
    // 新しい更新に対しては手つかずなので、finalize は止まる
    const blocked = runFail("finalize", project, repo.dir);
    assert.ok(blocked, "新しい更新としては手つかずなので止まるはず");
    assert.match(blocked.stderr, /手つかずの競合/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("analyze: baseline が変わった report からは引き継がない（比較の意味が違う）", () => {
  const { root, repo, project } = scenario();
  try {
    analyze(project, repo.dir);
    const threeWay = readReport(project).files.find((f) => f.file === "notes.md").currentHash;
    // baseline を失うと2点比較になり、同じ `conflict` でも意味が違う
    fs.rmSync(path.join(project, ".claude/harness-baseline.json"));
    fs.writeFileSync(path.join(project, "notes.md"), "2点比較の下で書き換えた\n", "utf-8");
    const report = analyze(project, repo.dir);
    assert.equal(report.twoWayFallback, true);
    assert.notEqual(
      report.files.find((f) => f.file === "notes.md").currentHash,
      threeWay,
      "3点比較のときのハッシュを持ち越さない",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("analyze: 前回が競合でなかったものは引き継がない", () => {
  const { root, repo, project } = scenario();
  try {
    // 1回目: docs/guide.md は template-improvement（現物は baseline と同じ）
    const first = analyze(project, repo.dir);
    assert.equal(kindOf(first, "docs/guide.md"), "template-improvement");
    // 現物を独自に書き換えると conflict になる。**この時点が基準**でなければならない
    fs.writeFileSync(path.join(project, "docs/guide.md"), "# 手引き\n\n独自\n", "utf-8");
    const second = analyze(project, repo.dir);
    assert.equal(kindOf(second, "docs/guide.md"), "conflict");
    assert.equal(
      second.files.find((f) => f.file === "docs/guide.md").currentHash,
      // 引き継がず取り直すので、今の現物のハッシュになる（＝まだ手つかず）
      readReport(project).files.find((f) => f.file === "docs/guide.md").currentHash,
    );
    const blocked = runFail("finalize", project, repo.dir);
    assert.ok(blocked, "いまの内容が基準なので手つかず扱いで止まる");
    assert.match(blocked.stderr, /docs\/guide\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 引き継ぐのは `conflict` → `conflict` のときだけ。
// `auto-merge` のハッシュを引き継ぐと、**人がまだ解決していない競合が「解決済み」に見える**
// （`auto-merge` だった時点の内容が基準になるため、競合を生んだ編集そのものが「解決」に数えられる）。
test("analyze: 前回 auto-merge だったものが競合になっても引き継がない", () => {
  const { root, repo, project } = scenario();
  try {
    analyze(project, repo.dir);
    assert.equal(kindOf(readReport(project), ".gitignore"), "auto-merge");
    // 末尾に足すとテンプレートの追記と同じハンクになり、行単位では統合できなくなる
    fs.appendFileSync(path.join(project, ".gitignore"), "tmp/\n", "utf-8");
    const second = analyze(project, repo.dir);
    assert.equal(kindOf(second, ".gitignore"), "conflict");
    // notes.md は解決しておく（止まる理由を .gitignore だけにする）
    fs.writeFileSync(path.join(project, "notes.md"), "テンプレートの注記 v2 ＋ 独自\n", "utf-8");
    const blocked = runFail("finalize", project, repo.dir);
    assert.ok(blocked, ".gitignore の競合はまだ手つかずなので止まるはず");
    assert.match(blocked.stderr, /\.gitignore/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 0.27.0 より前の report には currentHash が無い。そのときは従来どおり
// 「テンプレートと一致するか」で判定する（**止めるべきものを通してはいけない**）。
test("finalize: currentHash の無い古い report でも手つかずを止める", () => {
  const { root, repo, project } = scenario();
  try {
    analyze(project, repo.dir);
    const file = path.join(project, ".claude/.harness-update/report.json");
    const report = JSON.parse(fs.readFileSync(file, "utf-8"));
    for (const f of report.files) delete f.currentHash;
    fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf-8");
    const blocked = runFail("finalize", project, repo.dir);
    assert.ok(blocked, "古い report でも止まるはず");
    assert.match(blocked.stderr, /手つかずの競合/);
    assert.match(blocked.stderr, /notes\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 基準が古い report のままだと、解決と無関係な編集まで「解決」として数える。
// 止めはしないが**黙って進めない**（査読の中①）。
test("finalize: 1日より古い report を使うと警告する", () => {
  const { root, repo, project } = scenario();
  try {
    analyze(project, repo.dir);
    const file = path.join(project, ".claude/.harness-update/report.json");
    const report = JSON.parse(fs.readFileSync(file, "utf-8"));
    report.createdAt = new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString();
    fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf-8");
    const out = run("finalize", project, repo.dir, ["--force"]);
    assert.match(out, /3 日前の analyze/);
    assert.match(out, /\.claude\/\.harness-update\/ を消して/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 非 JSON の auto-merge（`.gitignore`）で `JSON.parse` が落ちる経路。
// 落ちた側（`m !== c` の比較）に行かないと、**適用済みでも「未適用」と警告する**。
test("finalize: 非 JSON の auto-merge は文字列として比べる（未適用の警告）", () => {
  const { root, repo, project } = scenario();
  try {
    analyze(project, repo.dir);
    // 適用しないまま finalize すると「未適用」と警告される
    const before = run("finalize", project, repo.dir, ["--force"]);
    assert.match(before, /未適用のテンプレート改善/);
    assert.match(before, /\.gitignore/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const again = scenario();
  try {
    analyze(again.project, again.repo.dir);
    run("apply", again.project, again.repo.dir, [".gitignore", "docs/guide.md"]);
    const after = run("finalize", again.project, again.repo.dir, ["--force"]);
    assert.doesNotMatch(after, /\.gitignore/, "適用済みなら警告に出ない");
  } finally {
    fs.rmSync(again.root, { recursive: true, force: true });
  }
});

test("finalize: analyze より前には進めない（report.json が無ければ止まる）", () => {
  const { root, repo, project } = scenario();
  try {
    const failed = runFail("finalize", project, repo.dir);
    assert.ok(failed);
    assert.match(failed.stderr, /先に analyze を実行してください/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("analyze: baseline が無ければ2点比較になり、差分は全部 conflict になる", () => {
  const { root, repo, project } = scenario();
  try {
    fs.rmSync(path.join(project, ".claude/harness-baseline.json"));
    const report = analyze(project, repo.dir);
    assert.equal(report.twoWayFallback, true);
    assert.equal(kindOf(report, "docs/guide.md"), "conflict");
    assert.equal(kindOf(report, "notes.md"), "conflict");
    assert.ok(report.warnings.some((w) => w.includes("2点比較")));
    // 2点比較では無断上書きをしない
    const failed = runFail("apply", project, repo.dir, ["docs/guide.md"]);
    assert.ok(failed);
    assert.match(failed.stderr, /競合/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("report.json は analyze のたびに作り直される（別コミットの結果が居座らない）", () => {
  const { root, repo, project } = scenario();
  try {
    analyze(project, repo.dir);
    const first = readReport(project);
    assert.equal(first.latestCommit, repo.commits[1]);
    // テンプレート側がさらに進んだ
    write(repo.dir, "payload/docs/guide.md", "# 手引き\n\nv3\n");
    git(["add", "-A"], repo.dir);
    git(["commit", "-q", "-m", "gen2"], repo.dir);
    const third = git(["rev-parse", "HEAD"], repo.dir);
    analyze(project, repo.dir);
    assert.equal(readReport(project).latestCommit, third);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// `apply` は改行と BOM を揃え直す。**それを黙ってやらない**（H53-c）
//
// 読み込みの時点で CRLF → LF・BOM の除去が起きるため、`apply` は**差分の中身と
// 関係なくファイル全体の改行を書き換える**ことがある。**差分には現れない**ので、
// 報告しなければ気づけない（ステージ時の正規化で blob が変わり、他セッションの
// 作業と食い違った先例がある）。
// ---------------------------------------------------------------------------

/** 改行・BOM の揃え直しを見るための土台（`template-improvement` を1本だけ持つ） */
function reshapeScenario(current, rel = "docs/guide.md") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "h53c-apply-"));
  const repo = mkTemplateRepo(root, [{ [rel]: "v1\n" }, { [rel]: "v2\n" }]);
  const project = mkProject(root, repo.commits[0], {});
  // 現物は**バイト列で**置く（write() は utf-8 文字列を書くので、ここは直接書く）
  const full = path.join(project, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, current);
  return { root, repo, project, rel };
}

test("CRLF の現物へ適用すると、LF に揃えたことを報告する", () => {
  const { root, repo, project, rel } = reshapeScenario(Buffer.from("v1\r\n"));
  try {
    const report = analyze(project, repo.dir);
    assert.equal(kindOf(report, rel), "template-improvement");
    const text = run("apply", project, repo.dir, [rel]);
    assert.match(text, /改行を LF に揃えた（現物は CRLF）/, `報告に出ていない:\n${text}`);
    // 実際に LF で書かれている
    assert.ok(!fs.readFileSync(path.join(project, rel), "latin1").includes("\r\n"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("BOM 付きの現物へ適用すると、BOM を落としたことを報告する", () => {
  const { root, repo, project, rel } = reshapeScenario(
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("v1\n")]),
  );
  try {
    analyze(project, repo.dir);
    const text = run("apply", project, repo.dir, [rel]);
    assert.match(text, /BOM を落とした/, `報告に出ていない:\n${text}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(".ps1 は BOM を付けた側も言う（黙って変えないことが目的）", () => {
  const rel = "tools/script.ps1";
  const { root, repo, project } = reshapeScenario(Buffer.from("v1\n"), rel);
  try {
    analyze(project, repo.dir);
    const text = run("apply", project, repo.dir, [rel]);
    assert.match(text, /BOM を付けた（\.ps1 の規約）/, `報告に出ていない:\n${text}`);
    const raw = fs.readFileSync(path.join(project, rel), "latin1");
    assert.ok(raw.startsWith("\u00ef\u00bb\u00bf"), ".ps1 に BOM が付いていない");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("揃っている現物では、余計なことを言わない", () => {
  const { root, repo, project, rel } = reshapeScenario(Buffer.from("v1\n"));
  try {
    analyze(project, repo.dir);
    const text = run("apply", project, repo.dir, [rel]);
    assert.ok(!/改行を LF|BOM を/.test(text), `言わなくてよいことを言っている:\n${text}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 所有マーカーは `analyze` の配線まで通っているか（H53-b）
//
// `tests/marker-merge.test.mjs` は `tryMarkerMerge` を直接呼ぶので、
// **`cmdAnalyze` の分岐を丸ごと消しても緑になる**（査読が実測で示した）。
// ここでコマンド経由の配線を固定する。
// ---------------------------------------------------------------------------

const MK_BEGIN = "<!-- harness:begin ハーネスが所有する -->";
const MK_END = "<!-- harness:end ここから下はプロジェクト -->";
const constitution = (owned, project) =>
  ["# 不変原則", MK_BEGIN, ...owned, MK_END, "", "## 9. このプロジェクト固有の原則", ...project].join("\n") + "\n";

test("analyze: マーカー付きの constitution.md は auto-merge になる（配線）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "h53b-wire-"));
  try {
    const repo = mkTemplateRepo(root, [
      { "constitution.md": constitution(["## 1. 規模ゲート"], ["<!-- TODO -->"]) },
      { "constitution.md": constitution(["## 1. 規模ゲート", "- 足した規律"], ["<!-- TODO -->"]) },
    ]);
    const project = mkProject(root, repo.commits[0], {
      "constitution.md": constitution(["## 1. 規模ゲート"], ["- **独自の原則。** これは残る"]),
    });
    const report = analyze(project, repo.dir);
    assert.equal(kindOf(report, "constitution.md"), "auto-merge");

    run("apply", project, repo.dir, ["constitution.md"]);
    const out = fs.readFileSync(path.join(project, "constitution.md"), "utf-8");
    assert.ok(out.includes("- 足した規律"), "テンプレートの追加が入っていない");
    assert.ok(out.includes("- **独自の原則。** これは残る"), "プロジェクトの原則が消えた");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("analyze: マーカーの無い現物は conflict になり、移行だと案内する（配線）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "h53b-wire2-"));
  try {
    const repo = mkTemplateRepo(root, [
      { "constitution.md": constitution(["## 1. 規模ゲート"], []) },
      { "constitution.md": constitution(["## 1. 規模ゲート", "- 足した規律"], []) },
    ]);
    // 現物はマーカー無し（0.40.0 より前に生成したプロジェクト）
    const project = mkProject(root, repo.commits[0], {
      "constitution.md": ["# 不変原則", "## 1. 規模ゲート", "", "## 9. 固有", "- 独自"].join("\n") + "\n",
    });
    const report = analyze(project, repo.dir);
    const entry = report.files.find((f) => f.file === "constitution.md");
    assert.equal(entry.kind, "conflict");
    assert.match(entry.note, /所有マーカーが現物に無い/, `移行の案内が出ていない: ${entry.note}`);
    assert.match(entry.note, /前書きと begin \/ end/, `前書きの持ち込みに触れていない: ${entry.note}`);

    // 競合は apply で書かない（事故にならないこと）
    const failed = runFail("apply", project, repo.dir, ["constitution.md"]);
    assert.ok(failed, "競合なのに apply が通った");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("analyze: end が無い壊れた現物は、begin を足せと言わない（配線）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "h53b-wire3-"));
  try {
    const repo = mkTemplateRepo(root, [
      { "constitution.md": constitution(["## 1. 規模ゲート"], []) },
      { "constitution.md": constitution(["## 1. 規模ゲート", "- 足した規律"], []) },
    ]);
    const project = mkProject(root, repo.commits[0], {
      "constitution.md": ["# 不変原則", MK_BEGIN, "## 1. 規模ゲート", "", "## 9. 固有", "- 独自"].join("\n") + "\n",
    });
    const report = analyze(project, repo.dir);
    const entry = report.files.find((f) => f.file === "constitution.md");
    assert.equal(entry.kind, "conflict");
    assert.match(entry.note, /harness:end が無い/, `壊れた現物として案内していない: ${entry.note}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
