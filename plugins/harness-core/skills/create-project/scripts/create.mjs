#!/usr/bin/env node
/**
 * create.mjs — create-project スキルの実行部
 *
 * claude-dev-harness を一時ディレクトリへ取得し、その `tools/create-project.mjs` を実行する。
 * **生成ロジック本体は持たない**（`tools/create-project.mjs` が唯一の正）。
 *
 * 使い方:
 *   node create.mjs describe [--env <env>] [--repo <path>]
 *       利用可能な環境と、各環境のプレースホルダ宣言（template.json）を JSON で出す
 *   node create.mjs run --env <env> --dest <path> --set K=V ... [--dry-run] [--repo <path>]
 *       `--repo` 以外の引数はそのまま create-project.mjs へ渡す
 *
 * ## なぜ毎回取得するのか
 *
 * プラグインのキャッシュ（`~/.claude/plugins/marketplaces/dev-harness`）にも `tools/` と
 * `templates/` は入っているが、**読み取り専用の配信キャッシュであって、どの版かの保証が無い**。
 * `harness-update` と同じく GitHub から `--depth 1` で取る。
 * `.claude/harness-baseline.json` の `templatesCommit` もこのクローンの HEAD になるので、
 * 以後の `harness-update` の3点比較の起点が正しく記録される。
 *
 * `--repo` にローカルクローンを渡すとネットワークを使わない（開発・オフライン用）。
 * その場合も作業ツリーを直接使わず clone し直す（未コミットの変更を生成物に混ぜないため）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const REPO_URL = "https://github.com/mizuta0711/claude-dev-harness.git";

/**
 * 失敗は例外で伝え、`main` の最上位で終了コードに変える。
 * ⚠️ ここで `process.exit` しないこと — `finally` が走らず一時ディレクトリが残る。
 */
class CreateError extends Error {}

function fail(message) {
  throw new CreateError(message);
}

/** `--key value` の value を取る。値が無い・次のオプションを食う場合はエラー */
function takeValue(argv, i, key) {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`${key} に値がありません。`);
  return v;
}

function git(args, cwd) {
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/** `--repo <path>` だけを抜き取り、残りは create-project.mjs へ渡す */
function splitArgs(argv) {
  let repo = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") repo = takeValue(argv, i++, "--repo");
    else rest.push(argv[i]);
  }
  return { repo, rest };
}

function prepareRepo(repo, work) {
  const dest = path.join(work, "repo");
  if (repo) {
    const abs = path.resolve(repo);
    if (!fs.existsSync(path.join(abs, "tools", "create-project.mjs"))) {
      fail(`--repo に指定されたパスが claude-dev-harness のクローンではありません: ${abs}`);
    }
    git(["clone", "--quiet", abs, dest], work);
    return dest;
  }
  try {
    git(["clone", "--quiet", "--depth", "1", REPO_URL, dest], work);
  } catch (e) {
    fail(
      `ハーネスの取得に失敗しました（ネットワーク不通の可能性）。\n${e.message}\n` +
        `対処: オフラインの場合は --repo <ローカルクローンのパス> を指定してください。`
    );
  }
  return dest;
}

function describe(repoDir, env) {
  const templatesDir = path.join(repoDir, "templates");
  const envs = fs
    .readdirSync(templatesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(templatesDir, d.name, "template.json")))
    .map((d) => d.name);
  if (env && !envs.includes(env)) fail(`未知の環境: ${env}（利用可能: ${envs.join(", ")}）`);
  const out = {};
  for (const e of env ? [env] : envs) {
    const t = JSON.parse(fs.readFileSync(path.join(templatesDir, e, "template.json"), "utf-8"));
    out[e] = { description: t.description, plugin: t.plugin, placeholders: t.placeholders || [] };
  }
  console.log(JSON.stringify(out, null, 2));
}

function main() {
  const [mode, ...argv] = process.argv.slice(2);
  if (mode !== "describe" && mode !== "run") {
    fail("使い方: node create.mjs <describe|run> [引数...]（詳細はスクリプト冒頭のコメント）");
  }
  const { repo, rest } = splitArgs(argv);
  const envIndex = rest.indexOf("--env");
  const env = envIndex >= 0 ? takeValue(rest, envIndex, "--env") : null;

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "harness-create-"));
  let status = 0;
  try {
    const repoDir = prepareRepo(repo, work);
    if (mode === "describe") {
      describe(repoDir, env);
    } else {
      // Bash ツールは TTY を持たないので create-project.mjs は対話しない。
      // 値が足りなければ create-project.mjs 自身が「--set で指定せよ」と言って止まる。
      const r = spawnSync(process.execPath, [path.join(repoDir, "tools", "create-project.mjs"), ...rest], {
        stdio: "inherit",
      });
      status = r.status ?? 1;
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return status;
}

try {
  process.exitCode = main();
} catch (e) {
  if (!(e instanceof CreateError)) throw e;
  console.error(`エラー: ${e.message}`);
  process.exitCode = 1;
}
