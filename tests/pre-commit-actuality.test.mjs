import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "plugins", "harness-core", "hooks", "scripts");
const HOOK = path.join(SCRIPTS, "pre-commit-actuality.js");
const { resolveTarget } = require(path.join(SCRIPTS, "pre-push-backlog-check.js"));

// **フック本体を通す。** 判定（actuality-scan.js）の単体テストだけでは
// ①`git commit` の判定 ②`gates.docActuality` ③対象リポジトリの解決
// ④非 ASCII のパス ⑤警告が deny に化けないこと —— が1つも守られない。
// 再査読で「上記の修正は実機では動いたが、自動では守られていない」と指摘された。

const posix = (p) => p.split(path.sep).join("/");

/** git リポジトリを作り、HEAD に空のコミットを置く */
function mkRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actuality-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude", "harness.config.json"),
    JSON.stringify({ schemaVersion: 1, environment: "nextjs", commands: {}, gates: {} }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# 方針\n\n- 方針だけを書く\n", "utf-8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  // HEAD のあとで変更を置く（これが検査対象の「追加行」になる）
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, "utf-8");
  }
  return dir;
}

function run(cwd, command, { projectDir } = {}) {
  const payload = JSON.stringify({
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
  const out = execFileSync(process.execPath, [HOOK], {
    input: payload,
    encoding: "utf-8",
    cwd,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir || cwd },
  });
  return out.trim() ? JSON.parse(out) : {};
}

const warned = (o) => (o.systemMessage || "").includes("[actuality]");

test("`git commit` 以外では何もしない", () => {
  const dir = mkRepo({ "CLAUDE.md": "# 方針\n\n- 現在 14 件ある\n" });
  for (const cmd of ["git status", "git push"]) {
    assert.equal(warned(run(dir, cmd)), false, cmd);
  }
  // 比較: 本物のコミットなら鳴る
  assert.equal(warned(run(dir, "git commit -- CLAUDE.md")), true);
});

test("⚠️ `echo 'git commit'` でも鳴る（`lib.isGitCommit` が引用符を見ない）", () => {
  // **これはこのフックの欠陥ではなく、共有の `harness-lib.isGitCommit` の挙動である。**
  // `pre-commit-check` / `post-commit-doc-check` も同じ判定を使う。
  //
  // **引用符は意図的に潰していない**（H65）—— `bash -c "git commit -- a.md"` のように
  // **引用符の中に本物のコミットが来る形があり、潰すと見逃す**。
  // 方針は「**見逃しは不可・誤検知は許容**」（`tests/is-git-commit.test.mjs`）。
  // **ヒアドキュメントの本文だけは H65 で潰した**（本文は実行されないので見逃しが生じない）。
  const dir = mkRepo({ "CLAUDE.md": "# 方針\n\n- 現在 14 件ある\n" });
  assert.equal(warned(run(dir, "echo 'git commit'")), true);
});

test("未追跡のファイルも検査する（`git diff HEAD` に出ない）", () => {
  // **新しく足した指示文書が、丸ごと検査されずに通っていた。**
  const dir = mkRepo({ ".claude/rules/new.md": "# 規約\n\n- 現在 14 件ある\n" });
  const out = run(dir, "git commit -- .claude/rules/new.md");
  assert.equal(warned(out), true, JSON.stringify(out));
  assert.match(out.systemMessage, /new\.md/);
});

test("**警告であって deny ではない**（止めてはいけない）", () => {
  const dir = mkRepo({ "CLAUDE.md": "# 方針\n\n- 現在 14 件ある\n" });
  const out = run(dir, "git commit -- CLAUDE.md");
  assert.equal(warned(out), true);
  assert.equal(out.hookSpecificOutput?.permissionDecision, undefined);
});

test("方針だけなら鳴らない（正常な操作で鳴らないことが要件）", () => {
  const dir = mkRepo({ "CLAUDE.md": "# 方針\n\n- 方針だけを書く\n- 1箇所に集約する\n" });
  assert.equal(warned(run(dir, "git commit -- CLAUDE.md")), false);
});

test("`gates.docActuality: \"off\"` なら検査しない", () => {
  const dir = mkRepo({ "CLAUDE.md": "# 方針\n\n- 現在 14 件ある\n" });
  fs.writeFileSync(
    path.join(dir, ".claude", "harness.config.json"),
    JSON.stringify({ schemaVersion: 1, environment: "nextjs", commands: {}, gates: { docActuality: "off" } }),
    "utf-8",
  );
  assert.equal(warned(run(dir, "git commit -- CLAUDE.md")), false);
});

test("`docs/` は対象外（実測記録は件数を書くのが正しい）", () => {
  const dir = mkRepo({ "docs/reviews/r.md": "# 記録\n\n- 現在 14 件ある\n" });
  assert.equal(warned(run(dir, "git commit -- docs/reviews/r.md")), false);
});

test("複数行の HTML コメントの中は鳴らない（ファイルを読んで状態を追う）", () => {
  const dir = mkRepo({
    "CLAUDE.md": ["# 方針", "", "<!--", "- 現在 14 件ある", "-->", ""].join("\n"),
  });
  assert.equal(warned(run(dir, "git commit -- CLAUDE.md")), false);
});

test("非 ASCII のファイル名でも検査する（`core.quotepath` の既定で素通りしていた）", () => {
  const dir = mkRepo({ ".claude/rules/日本語.md": "# 規約\n\n- 現在 14 件ある\n" });
  const out = run(dir, "git commit -- .claude/rules/日本語.md");
  assert.equal(warned(out), true, JSON.stringify(out));
  assert.match(out.systemMessage, /日本語\.md/);
});

test("`cd <別リポジトリ> && git commit` は、そちらの差分を見る", () => {
  // **セッションのディレクトリで差分を見ると、別リポジトリのコミットで鳴らず、
  // 自分側の未コミット差分に鳴る**（再査読の中4）。
  const clean = mkRepo({ "CLAUDE.md": "# 方針\n\n- 方針だけを書く\n" });
  const dirty = mkRepo({ "CLAUDE.md": "# 方針\n\n- 現在 14 件ある\n" });
  // 自分は綺麗で、コミットするのは汚れている方 → 鳴るべき
  assert.equal(warned(run(clean, `cd ${posix(dirty)} && git commit -- CLAUDE.md`)), true);
  // 逆向き: 自分が汚れていて、コミットするのは綺麗な方 → 鳴ってはいけない
  assert.equal(warned(run(dirty, `cd ${posix(clean)} && git commit -- CLAUDE.md`)), false);
});

test("resolveTarget は `sub` で探すサブコマンドを変えられる（二重実装を避けるため共用）", () => {
  const opts = { shell: "bash" };
  const base = os.tmpdir();
  assert.equal(resolveTarget("git commit -- a.md", opts, base, "commit")?.dir, base);
  assert.equal(resolveTarget("git commit -- a.md", opts, base, "push"), null);
  assert.equal(resolveTarget("git push", opts, base, "commit"), null);
  assert.equal(resolveTarget("git push", opts, base, "push")?.dir, base);
});
