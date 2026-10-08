import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "tools", "create-project.mjs");

// 全環境で生成が通り、**生成物に未置換のプレースホルダが 0 件**であることを見る。
// **環境を追加したら ENVS に足すこと**（足さないと新環境は生成テストを一度も通らない）。
// 生成物の中身までは検査しない（それは harness-update の3点比較の仕事）。
//
// ⚠️ `--dry-run` の出力には「置換内容」の表があり `{{NAME}} -> 値` が並ぶ。
//    そこを grep しても未置換の検出にはならない。**実際に生成して中身を見る。**

const ENVS = [
  { env: "nextjs", set: { PROJECT_NAME: "SmokeApp", PROJECT_DESCRIPTION: "スモークテスト用" } },
  { env: "unity", set: { PROJECT_NAME: "SmokeApp", PROJECT_DESCRIPTION: "スモークテスト用" } },
  {
    env: "wpf",
    set: {
      PROJECT_NAME: "SmokeApp",
      PROJECT_DESCRIPTION: "スモークテスト用",
      CORE_PROJECT: "SmokeApp.Core",
      UI_PROJECT: "SmokeApp.UI",
    },
  },
  {
    env: "android",
    set: {
      PROJECT_NAME: "SmokeApp",
      PROJECT_DESCRIPTION: "スモークテスト用",
      APPLICATION_ID: "com.example.smokeapp",
      MODULE_NAME: "app",
    },
  },
];

const argsFor = (env, set, dest, extra = []) => {
  const a = [SCRIPT, "--env", env, "--dest", dest, "--yes", ...extra];
  for (const [k, v] of Object.entries(set)) a.push("--set", `${k}=${v}`);
  return a;
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

for (const { env, set } of ENVS) {
  test(`生成物に未置換のプレースホルダが無い（${env}）`, () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), `harness-smoke-${env}-`));
    try {
      execFileSync(process.execPath, argsFor(env, set, dest), {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 60000,
      });

      const files = walk(dest);
      assert.ok(files.length > 0, "1件も生成されていない");

      const left = [];
      for (const f of files) {
        let text;
        try {
          text = fs.readFileSync(f, "utf-8");
        } catch {
          continue; // 読めないもの（バイナリ等）は対象外
        }
        for (const m of text.matchAll(/\{\{[A-Z_]+\}\}/g)) {
          left.push(`${path.relative(dest, f)}: ${m[0]}`);
        }
      }
      assert.deepEqual(left, [], `未置換のプレースホルダが残っている:\n${left.join("\n")}`);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
}

test("--dry-run は何も書き込まない", () => {
  const { env, set } = ENVS[0];
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "harness-smoke-dry-"));
  try {
    execFileSync(process.execPath, argsFor(env, set, dest, ["--dry-run"]), {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 60000,
    });
    assert.deepEqual(fs.readdirSync(dest), []);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test("未知の環境はエラーになる", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "harness-smoke-bad-"));
  try {
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [SCRIPT, "--env", "nosuchenv", "--dest", dest, "--dry-run", "--yes"],
        { encoding: "utf-8", stdio: "pipe", timeout: 60000 }
      )
    );
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// create-project スキルのラッパー（plugins/harness-core/skills/create-project/scripts/create.mjs）
//
// ラッパーは「取得して create-project.mjs を呼ぶ」だけだが、**引数の受け渡しと終了コードの伝播**を
// 誤ると、生成に失敗しても成功と報告する。`--repo` でこのリポジトリを渡してネットワークを使わない。
// ---------------------------------------------------------------------------

const WRAPPER = path.join(ROOT, "plugins", "harness-core", "skills", "create-project", "scripts", "create.mjs");

test("ラッパー: describe は環境ごとのプレースホルダ宣言を返す", () => {
  const out = execFileSync(process.execPath, [WRAPPER, "describe", "--repo", ROOT], {
    encoding: "utf-8",
    stdio: "pipe",
    timeout: 60000,
  });
  const json = JSON.parse(out);
  for (const { env, set } of ENVS) {
    assert.ok(json[env], `describe に ${env} が無い`);
    const keys = json[env].placeholders.map((p) => p.key);
    // ENVS の --set はプレースホルダを全部埋めている前提なので、宣言と一致するはず
    for (const k of keys) assert.ok(k in set || json[env].placeholders.find((p) => p.key === k).default, `${env}: ${k}`);
  }
});

test("ラッパー: run は生成し、baseline を残す", () => {
  const { env, set } = ENVS[0];
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "harness-smoke-wrap-"));
  try {
    const args = [WRAPPER, "run", "--repo", ROOT, "--env", env, "--dest", dest];
    for (const [k, v] of Object.entries(set)) args.push("--set", `${k}=${v}`);
    execFileSync(process.execPath, args, { encoding: "utf-8", stdio: "pipe", timeout: 60000 });
    const baseline = JSON.parse(fs.readFileSync(path.join(dest, ".claude", "harness-baseline.json"), "utf-8"));
    assert.equal(baseline.environment, env);
    assert.match(baseline.templatesCommit ?? "", /^[0-9a-f]{40}$/);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

/** ラッパーを実行し、終了コードと stderr を返す（失敗しても例外にしない） */
const runWrapper = (args) => {
  try {
    execFileSync(process.execPath, [WRAPPER, ...args], { encoding: "utf-8", stdio: "pipe", timeout: 60000 });
    return { status: 0, stderr: "" };
  } catch (e) {
    return { status: e.status, stderr: String(e.stderr) };
  }
};

/** このプロセスの一時ディレクトリにあるラッパーの作業フォルダ */
const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("harness-create-"));

test("ラッパー: プレースホルダが足りなければ、その名前を出して非ゼロで終わる", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "harness-smoke-wrap-bad-"));
  try {
    const r = runWrapper(["run", "--repo", ROOT, "--env", "nextjs", "--dest", dest, "--set", "PROJECT_NAME=x"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PROJECT_DESCRIPTION/);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test("ラッパー: --dry-run は何も書き込まない", () => {
  const { env, set } = ENVS[0];
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "harness-smoke-wrap-dry-"));
  try {
    const args = ["run", "--repo", ROOT, "--env", env, "--dest", dest, "--dry-run"];
    for (const [k, v] of Object.entries(set)) args.push("--set", `${k}=${v}`);
    assert.equal(runWrapper(args).status, 0);
    assert.deepEqual(fs.readdirSync(dest), []);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

// ⚠️ 失敗時に `process.exit` すると `finally` が走らず、一時ディレクトリが残る（査読で実測された）。
//    並行する他のテストも同じ接頭辞を作るので、「実行前後で増えていない」ではなく
//    **失敗経路のあとに、実行前に無かったものが残っていない**ことを見る。
for (const [label, args, pattern] of [
  ["未知の環境", ["describe", "--repo", ROOT, "--env", "nosuchenv"], /未知の環境/],
  ["--repo が別物", ["describe", "--repo", path.join(ROOT, "tests")], /クローンではありません/],
  ["--repo の値が無い", ["describe", "--repo"], /--repo に値がありません/],
  ["--env の値が無い", ["describe", "--repo", ROOT, "--env"], /--env に値がありません/],
]) {
  test(`ラッパー: 失敗しても一時ディレクトリを残さない（${label}）`, () => {
    const before = new Set(leftovers());
    const r = runWrapper(args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, pattern);
    const added = leftovers().filter((n) => !before.has(n));
    assert.deepEqual(added, [], `残った: ${added.join(", ")}`);
  });
}

// ---------------------------------------------------------------------------
// CLAUDE.md の所有の分離（0.25.0・H53 の第2弾）
//
// テンプレートが配るファイルをプロジェクトも育てると、ハーネス更新のたびに
// ファイル全体が「競合」になる（実測: 導入済み3プロジェクトすべてで CLAUDE.md が競合）。
// そこで **ハーネスの説明を `.claude/harness/` へ出し、CLAUDE.md は `@` で読み込む**形にした。
// 所有の境界がファイル単位に戻るので、既存の追従の仕組みがそのまま効く。
// ---------------------------------------------------------------------------

for (const { env, set } of ENVS) {
  test(`CLAUDE.md はハーネスの説明を持たず、@ で読み込む（${env}）`, () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), `harness-own-${env}-`));
    try {
      execFileSync(process.execPath, argsFor(env, set, dest), { encoding: "utf-8" });
      const claudeMd = fs.readFileSync(path.join(dest, "CLAUDE.md"), "utf-8");

      // import は**バッククォートの外**に書く（コードスパンの中では展開されない）
      assert.match(claudeMd, /^@\.claude\/harness\/core\.md$/m, "core.md の import が無い");
      assert.match(claudeMd, /^@\.claude\/harness\/environment\.md$/m, "environment.md の import が無い");

      // ハーネスの説明は CLAUDE.md に残っていない
      assert.doesNotMatch(claudeMd, /^## 開発フロー$/m);
      assert.doesNotMatch(claudeMd, /^## 運用ルール$/m);
      assert.doesNotMatch(claudeMd, /ENV_SECTION/, "合成マーカーが残っている");

      // 読み込み先が実在する（import 先が無いと起動時に展開されない）
      for (const rel of [".claude/harness/core.md", ".claude/harness/environment.md"]) {
        assert.ok(fs.existsSync(path.join(dest, rel)), `${rel} が無い`);
      }

      // 環境セクションは env 版に置き換わっている（base の予備が配られていない）
      const envMd = fs.readFileSync(path.join(dest, ".claude/harness/environment.md"), "utf-8");
      assert.doesNotMatch(
        envMd,
        /を用意すれば、ここは自動で置き換わる/,
        `base の予備が配られている（templates/${env}/.claude/harness/environment.md が無い）`
      );

      // ハーネス所有のファイルには「編集しない」が書かれている（競合の原因を先に潰す）
      const core = fs.readFileSync(path.join(dest, ".claude/harness/core.md"), "utf-8");
      assert.match(core, /プロジェクト側では編集しない/);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
}
