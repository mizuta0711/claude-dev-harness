import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "plugins", "harness-core", "hooks", "scripts");
const scope = require(path.join(SCRIPTS, "git-scope.js"));
const lib = require(path.join(SCRIPTS, "harness-lib.js"));

// ---------------------------------------------------------------------------
// H48: 同じコマンドの中で、git commit より前にファイルを変えうる操作
// ---------------------------------------------------------------------------

const CHANGES = [
  // 実プロジェクトで実測した形（型エラーのファイルが「✅ 成功」でコミットされた）
  ["printf 'x' > src/a.ts && git add -- src/a.ts && git commit -m t -- src/a.ts", "printf 'x' > src/a.ts"],
  ["sed -i s/a/b/ x.ts && git commit -- x.ts", "sed -i s/a/b/ x.ts"],
  ["cat > a.ts <<'EOF'\nx\nEOF\ngit commit -- a.ts", "cat > a.ts"],
  ["echo x >> a.ts; git commit -- a.ts", "echo x >> a.ts"],
  ["Set-Content a.ts 'x'; git commit -- a.ts", "Set-Content a.ts 'x'"],
  ["git checkout other -- a.ts && git commit -- a.ts", "git checkout other -- a.ts"],
  ["git apply fix.patch && git commit -- a.ts", "git apply fix.patch"],
  ["cp b.ts a.ts && git commit -- a.ts", "cp b.ts a.ts"],
  // 知らないコマンドは「変えうる」側に倒す（誤検知は許容。分ければ済む）
  ["npx prettier --write a.ts && git commit -- a.ts", "npx prettier --write a.ts"],
  // 査読 2: コミットがラッパーの引用符の内側にある
  ['bash -c "printf x > src/a.ts && git commit -m t -- src/a.ts"', "printf x > src/a.ts"],
  ["pwsh -Command \"Set-Content a.ts 'x'; git commit -- a.ts\"", "Set-Content a.ts 'x'"],
  ["printf x > a.ts; bash -c 'git commit -- a.ts'", "printf x > a.ts"],
  // **0.37.3 で報告する断片が変わった。** `if` を予約語として剥がすようになったため、
  // `if true` を未知のコマンドとして咎めるのをやめ、**実際に書き込む側**を指すようになった。
  // 検出すること自体は変わらない（変わったのは、人が読む1行がどこを指すか）。
  ["if true; then printf x > a.ts; git commit -- a.ts; fi", "printf x > a.ts"],
  ["echo x &> a.ts; git commit -- a.ts", "echo x > a.ts"],
  // index だけでなく作業ツリーを変える形
  ["git reset --hard HEAD && git commit -- a", "git reset --hard HEAD"],
  ["git restore a.ts && git commit -- a.ts", "git restore a.ts"],
  ["git rm a.ts && git commit -- a.ts", "git rm a.ts"],
];

const NO_CHANGES = [
  "git commit -m x -- a.ts",
  "git add -- a.ts && git commit -m x -- a.ts",
  "cd /d/work && git commit -m y -- a",
  "git status --short && git diff --stat && git commit -- a",
  "git status > /dev/null && git commit -- a",
  "git -C ../repo add -- a && git -C ../repo commit -- a",
  // 引用符・ヒアドキュメントの中の `>` や語は操作ではない
  "git commit -m 'a > b' -- a",
  'echo "a > b" && git commit -- a',
  "git commit -F - <<'EOF'\nprintf 'x' > src/a.ts\nEOF",
  // コミットより後ろの操作はゲートと関係ない
  "git commit -m x -- a && echo done > log.txt",
  // 査読 1: fd の複製は書き込みではない
  "git add a 2>&1; git commit -m x -- a",
  "git status 2>&1 | head -5 && git commit -- a",
  // 査読 5: パイプの受け手・index だけを触る git
  "git add a | Out-Null; git commit -- a",
  "ls | wc -l && git commit -- a",
  "git mv a b && git commit -- a b",
  "git rm --cached a && git commit -- a",
  "git reset HEAD a && git commit -- a",
  "git restore --staged a && git commit -- a",
  "$msg = 'x'; git commit -m $msg -- a",
  'bash -c "git commit -m x -- a"',
];

for (const [cmd, seg] of CHANGES) {
  test(`H48 検出する: ${JSON.stringify(cmd)}`, () => assert.equal(scope.changesBeforeCommit(cmd), seg));
}
for (const cmd of NO_CHANGES) {
  test(`H48 検出しない: ${JSON.stringify(cmd)}`, () => assert.equal(scope.changesBeforeCommit(cmd), null));
}

// ---------------------------------------------------------------------------
// 実際のリポジトリで: hasSourceFiles（H45）とフック全体
// ---------------------------------------------------------------------------

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "precommit-gate-"));
  execSync("git init -q", { cwd: dir });
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(
    path.join(dir, ".claude", "harness.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      environment: "nextjs",
      // 常に失敗するゲート（ゲートが走ったかどうかを deny の有無で観測する）
      commands: { typecheck: 'node -e "process.exit(1)"' },
      gates: { preCommit: ["typecheck"] },
      paths: { source: ["src/**"] },
    })
  );
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  return dir;
}

function runHook(dir, command) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, "pre-commit-check.js")], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    env: { ...process.env, ...GIT_ENV, CLAUDE_PROJECT_DIR: dir },
    encoding: "utf-8",
  });
  return r.stdout ? JSON.parse(r.stdout) : null;
}

function withProject(dir, fn) {
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prev;
  }
}

test("hasSourceFiles: 一致するファイルの有無（未追跡も数える）", () => {
  const dir = makeRepo();
  try {
    const config = { paths: { source: ["src/**"] } };
    assert.equal(withProject(dir, () => lib.hasSourceFiles(config)), false);
    fs.mkdirSync(path.join(dir, "src", "app"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "app", "page.tsx"), "x\n");
    assert.equal(withProject(dir, () => lib.hasSourceFiles(config)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hasSourceFiles: .gitignore 対象は数えない", () => {
  const dir = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, ".gitignore"), "src/gen/\n");
    fs.mkdirSync(path.join(dir, "src", "gen"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "gen", "a.ts"), "x\n");
    assert.equal(withProject(dir, () => lib.hasSourceFiles({ paths: { source: ["src/**"] } })), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 査読 4: git の :(glob) はブレースを展開しないので、一致しないまま「未初期化」に見える。判定不能に倒す
test("hasSourceFiles: ブレース・角括弧のグロブは判定不能（null）", () => {
  const dir = makeRepo();
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "x\n");
    assert.equal(withProject(dir, () => lib.hasSourceFiles({ paths: { source: ["src/**/*.{ts,tsx}"] } })), null);
    assert.equal(withProject(dir, () => lib.hasSourceFiles({ paths: { source: ["src/[ab].ts"] } })), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hasSourceFiles: 判定できないときは null（呼び出し側はゲートを飛ばさない）", () => {
  const dir = makeRepo();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "precommit-nogit-"));
  try {
    assert.equal(withProject(dir, () => lib.hasSourceFiles({})), null);
    assert.equal(withProject(dir, () => lib.hasSourceFiles({ paths: { source: [] } })), null);
    assert.equal(withProject(plain, () => lib.hasSourceFiles({ paths: { source: ["src/**"] } })), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test("フック: 未初期化ならゲートを飛ばし、飛ばしたことを知らせる（H45）", () => {
  const dir = makeRepo();
  try {
    const out = runHook(dir, "git commit -m init -- README.md");
    assert.equal(out?.hookSpecificOutput?.permissionDecision, undefined);
    assert.match(out.systemMessage, /未初期化/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("フック: 同じ行でファイルを書いてからのコミットは deny（H48）", () => {
  const dir = makeRepo();
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "x\n");
    const out = runHook(dir, "printf 'y' > src/b.ts && git add -- src/b.ts && git commit -m t -- src/b.ts");
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /別の呼び出し/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 査読 3: 未初期化の判定より H48 を先に見る（同じ1行で最初のソースを作ると「未初期化」に見えるため）
test("フック: 未初期化でも、同じ行で最初のソースを作ってのコミットは deny（H48 が先）", () => {
  const dir = makeRepo();
  try {
    const out = runHook(dir, "mkdir -p src && printf 'y' > src/x.ts && git add -- src/x.ts && git commit -m t -- src/x.ts");
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /別の呼び出し/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("フック: 未初期化で git add と一緒のコミットは通す（create-project 直後の最初のコミット）", () => {
  const dir = makeRepo();
  try {
    const out = runHook(dir, "git add -- README.md && git commit -m init -- README.md");
    assert.equal(out?.hookSpecificOutput?.permissionDecision, undefined);
    assert.match(out.systemMessage, /未初期化/);
    assert.ok(out.systemMessage.includes('["src/**"]'), "使ったグロブをメッセージに載せる");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("フック: 初期化済みで単独のコミットは、従来どおりゲートを走らせる", () => {
  const dir = makeRepo();
  try {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "x\n");
    const out = runHook(dir, "git commit -m t -- src/a.ts");
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /typecheck/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
