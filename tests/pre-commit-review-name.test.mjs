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
const HOOK = path.join(ROOT, "plugins", "harness-core", "hooks", "scripts", "pre-commit-review-name.js");
const { looksInvented } = require(HOOK);

const REAL = "docs/reviews/20261103_102343_code-review.md";
const ROUND = "docs/reviews/20261103_120000_design-review-feature.md";

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-name-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  const write = (rel, body = "# r\n") => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  write("README.md");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  return { dir, git, write };
}

function run(cwd, command) {
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
    encoding: "utf-8",
    cwd,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
  return out.trim() ? JSON.parse(out) : {};
}

const message = (o) => o.systemMessage || "";

test("秒が 00 の日時つきの名前だけを、作った時刻の形とみなす", () => {
  assert.equal(looksInvented(ROUND), true);
  assert.equal(looksInvented("docs/reviews/20261103_120100_code-review.md"), true);
  assert.equal(looksInvented(REAL), false);
  assert.equal(looksInvented("docs/reviews/20261103_調査メモ.md"), false);
});

test("ステージした新しい記録の秒が 00 なら知らせ、deny にしない", () => {
  const r = mkRepo();
  r.write(ROUND);
  r.git("add", ROUND);
  const out = run(r.dir, `git commit -m x -- ${ROUND}`);
  assert.match(message(out), /\[review-name\]/);
  assert.match(message(out), /120000/);
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(message(run(r.dir, "git status")), "", "git commit 以外では何もしない");
});

test("実際の時刻らしい名前と、既存の記録の修正では鳴らない", () => {
  const r = mkRepo();
  r.write(ROUND);
  r.git("add", ROUND);
  r.git("commit", "-q", "-m", "old");
  r.write(ROUND, "# changed\n");
  r.git("add", ROUND);
  r.write(REAL);
  r.git("add", REAL);
  assert.equal(message(run(r.dir, "git commit -m x")), "");
});

test("同じコマンドで add する未追跡は見て、名前の出ない他セッションの未追跡は見ない", () => {
  const r = mkRepo();
  r.write(ROUND);
  assert.equal(message(run(r.dir, "git commit -m x -- README.md")), "");
  assert.match(message(run(r.dir, `git add ${ROUND} && git commit -m x -- ${ROUND}`)), /120000/);
});

test("upstream に同じ名前があれば、時刻の形によらず衝突を知らせる", () => {
  const r = mkRepo();
  const base = r.git("rev-parse", "--abbrev-ref", "HEAD");
  r.git("checkout", "-q", "-b", "work");
  r.git("checkout", "-q", base);
  r.write(REAL, "# other session\n");
  r.git("add", REAL);
  r.git("commit", "-q", "-m", "other");
  r.git("checkout", "-q", "work");
  r.git("branch", `--set-upstream-to=${base}`);
  r.write(REAL, "# mine\n");
  r.git("add", REAL);
  assert.match(message(run(r.dir, "git commit -m x")), /upstream に同じ名前/);
});

test("`cd X && git commit` は X のリポジトリを見る", () => {
  const r = mkRepo();
  const other = mkRepo();
  r.write(ROUND);
  r.git("add", ROUND);
  assert.match(message(run(other.dir, `cd "${r.dir}" && git commit -m x`)), /120000/);
});

test("hooks.json に登録されている", () => {
  const hooks = fs.readFileSync(path.join(ROOT, "plugins", "harness-core", "hooks", "hooks.json"), "utf-8");
  assert.match(hooks, /pre-commit-review-name\.js/);
});

test("記録を作るスキルは、時刻を date から取ると書き、date を実行できる", () => {
  const core = "plugins/harness-core";
  for (const rel of ["skills/code-review/SKILL.md", "skills/design-review/SKILL.md", "skills/whole-review/SKILL.md"]) {
    const text = fs.readFileSync(path.join(ROOT, core, rel), "utf-8");
    assert.ok(text.includes("date +%Y%m%d_%H%M%S"), `${rel} に時刻の取り方が無い`);
    assert.match(text.match(/^allowed-tools: .*$/m)[0], /Bash\(date:\*\)/, `${rel} が date を許可していない`);
  }
  assert.ok(fs.readFileSync(path.join(ROOT, core, "agents/code-reviewer.md"), "utf-8").includes("date +%Y%m%d_%H%M%S"));
});

test("pre-push-check は桁の伸びる %h で台帳を探さない（H111）", () => {
  const text = fs.readFileSync(path.join(ROOT, "plugins/harness-core/skills/pre-push-check/SKILL.md"), "utf-8");
  assert.doesNotMatch(text, /--format=%h/);
  assert.match(text, /git log --format=%H @\{upstream\}\.\.HEAD/);
  assert.match(text, /先頭 7 文字/);
});
