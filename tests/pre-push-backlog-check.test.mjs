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
const HOOK = path.join(SCRIPTS, "pre-push-backlog-check.js");
const hook = require(HOOK);

// **フック本体を通す。** 判定（backlog-sync.js）の単体テストだけでは、
// ①push の判定 ②`--dry-run` ③`gates.backlogSync: "off"` ④素通りの通知
// ⑤deny の出力形式 ⑥対象リポジトリの解決 —— が1つも守られない。
// 0.32.0 の初版はここが無く、**単発の設計書（`#` 空欄）で必ず deny される欠陥**を
// 査読まで持ち越した。

const HEADER = ["| # | やること | 狙い | 設計書 |", "|---|---|---|---|"];

/** 台帳と設計書を持つ使い捨てプロジェクト */
function mkProject({ rows = [], docs = [], gates, heading = "## 計画" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-backlog-"));
  fs.mkdirSync(path.join(dir, "docs", "features"), { recursive: true });
  if (rows !== null) {
    fs.writeFileSync(
      path.join(dir, "docs", "backlog.md"),
      ["# 残作業", "", heading, "", ...HEADER, ...rows, ""].join("\n"),
      "utf-8",
    );
  }
  for (const rel of docs) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "# doc", "utf-8");
  }
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude", "harness.config.json"),
    JSON.stringify({ schemaVersion: 1, environment: "nextjs", commands: {}, gates: gates ?? {} }, null, 2),
    "utf-8",
  );
  return dir;
}

/** フックを実際に起動して、返ってきた JSON を読む */
function run(dir, command, shell = "Bash") {
  const payload = JSON.stringify({
    cwd: dir,
    hook_event_name: "PreToolUse",
    tool_name: shell,
    tool_input: { command },
  });
  const out = execFileSync(process.execPath, [HOOK], {
    input: payload,
    encoding: "utf-8",
    cwd: dir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  return out.trim() ? JSON.parse(out) : {};
}

const posix = (p) => p.split(path.sep).join("/");

const decisionOf = (o) => o?.hookSpecificOutput?.permissionDecision ?? null;

// ---- push の判定 ----

test("push を含まないコマンドは何もしない", () => {
  const dir = mkProject({ rows: ["|  | a | b | `docs/features/x.md` |"] }); // 設計書が無い＝食い違い
  for (const cmd of ["git status", "git commit -- a.md", "echo 'git push'", "git log --grep push"]) {
    assert.equal(decisionOf(run(dir, cmd)), null, cmd);
  }
  // 比較: 本物の push なら止まる（上の形が「食い違いが無いから通った」のではないことを示す）
  assert.equal(decisionOf(run(dir, "git push")), "deny");
});

test("PowerShell でも判定する", () => {
  const dir = mkProject({ rows: ["|  | a | b | `docs/features/x.md` |"] });
  assert.equal(decisionOf(run(dir, "git push", "PowerShell")), "deny");
});

test("`--dry-run` は止めない（何も送らないので害が無い）", () => {
  const dir = mkProject({ rows: ["|  | a | b | `docs/features/x.md` |"] });
  assert.equal(decisionOf(run(dir, "git push --dry-run")), null);
  assert.equal(decisionOf(run(dir, "git push -n")), null);
});

// ---- 正常な操作で鳴らない ----

test("合っていれば通す", () => {
  const dir = mkProject({
    rows: ["|  | a | b | `docs/features/20261010_a.md` |"],
    docs: ["docs/features/20261010_a.md"],
  });
  assert.equal(decisionOf(run(dir, "git push")), null);
});

test("`#` が空欄の行（`new-feature` の既定）で鳴らない", () => {
  // **0.32.0 の初版はここで必ず deny していた。**
  // `new-feature` は「`#` は空欄にする。番号は `plan-milestones` が分けたときだけ」と定めている。
  const dir = mkProject({
    rows: ["|  | 機能A | 狙い | `docs/features/20261010_a.md` |"],
    docs: ["docs/features/20261010_a.md"],
  });
  assert.equal(decisionOf(run(dir, "git push")), null);
});

// ---- 食い違いは止める ----

test("行が指す設計書が無ければ deny し、出口を案内する", () => {
  const dir = mkProject({ rows: ["|  | a | b | `docs/features/20261010_a.md` |"] });
  const out = run(dir, "git push");
  assert.equal(decisionOf(out), "deny");
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /backlog-sync/); // 直すスキルへの案内
  assert.match(reason, /残作業台帳/); // どちらの台帳かを言う
  assert.match(reason, /設計書同期台帳/); // もう一方と区別する
  assert.match(reason, /作業ツリー/); // 何を見ているかを言う（査読 M3）
  assert.ok(reason.includes(dir), "対象リポジトリを明記する"); // 査読 M4
});

// ---- 設定 ----

test("`gates.backlogSync: \"off\"` なら検査しない", () => {
  const dir = mkProject({
    rows: ["|  | a | b | `docs/features/x.md` |"],
    gates: { backlogSync: "off" },
  });
  assert.equal(decisionOf(run(dir, "git push")), null);
});

test("config が無くても検査する（黙らないことが目的）", () => {
  const dir = mkProject({ rows: ["|  | a | b | `docs/features/x.md` |"] });
  fs.rmSync(path.join(dir, ".claude", "harness.config.json"));
  assert.equal(decisionOf(run(dir, "git push")), "deny");
});

// ---- 素通りと、その通知 ----

test("台帳が無ければ素通りし、素通りしたことを知らせる", () => {
  const dir = mkProject({ rows: null });
  const out = run(dir, "git push");
  assert.equal(decisionOf(out), null);
  assert.match(out.systemMessage || "", /検査していません/);
});

test("計画節が無ければ素通りし、素通りしたことを知らせる", () => {
  const dir = mkProject({ rows: [], heading: "## 残作業" });
  const out = run(dir, "git push");
  assert.equal(decisionOf(out), null);
  assert.match(out.systemMessage || "", /検査していません/);
});

test("`## マイルストーン`（網羅を約束していない形）では載っていない設計書で鳴らない", () => {
  const dir = mkProject({
    heading: "## マイルストーン",
    rows: ["|  | a | b | `docs/features/20261010_a.md` |"],
    docs: ["docs/features/20261010_a.md", "docs/features/20261010_b.md"],
  });
  assert.equal(decisionOf(run(dir, "git push")), null);
});

// ---- 対象リポジトリの解決（査読 M4） ----

test("`cd <別リポジトリ> && git push` は、そちらの台帳で判定する", () => {
  // **このセッションのプロジェクトの台帳で別リポジトリの push を止めてはいけない。**
  // ProjectTemplete から claude-dev-harness を push するのは正規の作法である。
  const broken = mkProject({ rows: ["|  | a | b | `docs/features/x.md` |"] }); // 食い違っている
  const clean = mkProject({
    rows: ["|  | a | b | `docs/features/20261010_a.md` |"],
    docs: ["docs/features/20261010_a.md"],
  });
  // 自分のプロジェクトは食い違っているが、push するのは合っている方
  const out = run(broken, `cd ${posix(clean)} && git push`);
  assert.equal(decisionOf(out), null);
  // 逆向き: 自分は合っているが、push する先が食い違っている
  const out2 = run(clean, `cd ${posix(broken)} && git push`);
  assert.equal(decisionOf(out2), "deny");
});

test("`-C <dir>` も解決する", () => {
  const broken = mkProject({ rows: ["|  | a | b | `docs/features/x.md` |"] });
  const clean = mkProject({
    rows: ["|  | a | b | `docs/features/20261010_a.md` |"],
    docs: ["docs/features/20261010_a.md"],
  });
  assert.equal(decisionOf(run(broken, `git -C ${posix(clean)} push`)), null);
});

test("解決先が実在しなければ検査しない（間違った台帳で止めるより見逃す）", () => {
  const dir = mkProject({ rows: ["|  | a | b | `docs/features/x.md` |"] });
  assert.equal(decisionOf(run(dir, "cd /no/such/dir && git push")), null);
});

test("resolveTarget は push でないコマンドに null を返す", () => {
  const opts = { shell: "bash" };
  const base = os.tmpdir(); // プラットフォーム依存の絶対パス解決を避ける
  assert.equal(hook.resolveTarget("echo 'git push'", opts, base), null);
  assert.equal(hook.resolveTarget("git status", opts, base), null);
  assert.equal(hook.resolveTarget("git push", opts, base).dir, base);
});

// ---- 再査読（0.32.1）で出た「間違ったリポジトリを検査する」形の回帰 ----

test("PowerShell の `Set-Location` / `sl` も追う", () => {
  // `cd` / `pushd` しか見ていなかったため、**別リポジトリの push を
  // セッション側の台帳で判定していた**（査読 M2）。
  const broken = mkProject({ rows: ["|  | a | b | `docs/features/x.md` |"] });
  const clean = mkProject({
    rows: ["|  | a | b | `docs/features/20261010_a.md` |"],
    docs: ["docs/features/20261010_a.md"],
  });
  const opts = { shell: "powershell" };
  for (const cmd of [`Set-Location ${posix(clean)}; git push`, `sl ${posix(clean)}; git push`]) {
    assert.equal(hook.resolveTarget(cmd, opts, broken).dir, clean, cmd);
  }
});

test("Git Bash 形式のパス（`/d/...`）を解決する", () => {
  // 直さないと `D:\d\...` になって実在せず、検査が素通りしていた（査読 M2）。
  if (process.platform !== "win32") return;
  assert.equal(hook.fromGitBash("/d/Develop/x"), "D:/Develop/x");
  assert.equal(hook.fromGitBash("/c/Users/x"), "C:/Users/x");
  // それ以外は触らない
  assert.equal(hook.fromGitBash("/no/such/dir"), "/no/such/dir");
  assert.equal(hook.fromGitBash("D:/already"), "D:/already");
});

test("サブディレクトリから push してもリポジトリのルートを検査する", () => {
  // `cd src && git push` で `.../src` を見て素通りしていた（査読 L1）。
  const dir = mkProject({ rows: ["|  | a | b | `docs/features/x.md` |"] });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const out = run(dir, "cd src && git push");
  assert.equal(decisionOf(out), "deny", "ルートまで寄せれば台帳が見つかる");
});

test("起点はフックが受け取った `cwd`（セッションのプロジェクトを当てにしない）", () => {
  // Bash ツールのカレントは呼び出しをまたいで残るので、
  // `CLAUDE_PROJECT_DIR` とは違うことがある（査読 M3）。
  const broken = mkProject({ rows: ["|  | a | b | `docs/features/x.md` |"] });
  const clean = mkProject({
    rows: ["|  | a | b | `docs/features/20261010_a.md` |"],
    docs: ["docs/features/20261010_a.md"],
  });
  // payload の cwd は clean、CLAUDE_PROJECT_DIR は broken
  const payload = JSON.stringify({
    cwd: clean,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git push" },
  });
  const out = execFileSync(process.execPath, [HOOK], {
    input: payload,
    encoding: "utf-8",
    cwd: clean,
    env: { ...process.env, CLAUDE_PROJECT_DIR: broken },
  });
  assert.equal(decisionOf(out.trim() ? JSON.parse(out) : {}), null);
});
