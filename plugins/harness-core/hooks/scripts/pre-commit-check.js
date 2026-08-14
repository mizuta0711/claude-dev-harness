/**
 * PreToolUse フック: コミット前ゲート（config 駆動）
 *
 * 3テンプレートの pre-commit-type-check.js / pre-commit-build-check.js /
 * pre-commit-cs-check.js を1本に統合したもの。実行するコマンドは
 * `.claude/harness.config.json` の `gates.preCommit` と `commands.*` が決める。
 *
 * 動作:
 *   - `git commit` を含むコマンド以外は即素通り（matcher は Bash|PowerShell 全体に効くため）
 *   - config 不在・壊れている・schemaVersion が新しすぎる → 素通り（fail-open）
 *   - gates.preCommit が空 / 対応する commands が null → 素通り（Unity のようなCLIチェック無し環境）
 *   - コマンド失敗 → permissionDecision:"deny" でブロック（自己修復可能な失敗のため deny を使う）
 *
 * ブロック強度の使い分け（Phase 1 指示書 §0）:
 *   - 自己修復可能（型エラー・ビルドエラー）: permissionDecision:"deny"
 *   - 人間判断が必要: continue:false ← このフックでは使わない
 */
const lib = require("./harness-lib");

const payload = lib.readPayload();
if (!payload) lib.passThrough();

if (!lib.isGitCommit(lib.toolCommand(payload))) lib.passThrough();

const { status, config, message } = lib.loadConfig();
if (status === "missing" || status === "invalid") lib.passThrough();
if (status === "newer") {
  lib.emit({ systemMessage: `[pre-commit-check] ${message}` });
  process.exit(0);
}

const gates = Array.isArray(config?.gates?.preCommit) ? config.gates.preCommit : [];
if (!gates.length) lib.passThrough();

const results = [];
const skipped = [];

for (const key of gates) {
  const command = lib.commandFor(config, key);
  if (!command) {
    // この環境には該当コマンドが無い（null）。黙ってスキップする
    skipped.push(key);
    continue;
  }

  const { ok, output } = lib.run(command);
  if (!ok) {
    lib.emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `コミット前チェック「${key}」が失敗しました（${command}）。修正してから再度コミットしてください。\n` +
          lib.errorExcerpt(output, 20),
      },
    });
    process.exit(0);
  }
  results.push(key);
}

if (!results.length && skipped.length) {
  // 全て null だった場合は「チェック無し環境」として静かに通す
  lib.passThrough();
}

lib.emit({
  systemMessage:
    `[pre-commit-check] ✅ ${results.join(" / ")} 成功` +
    (skipped.length ? `（スキップ: ${skipped.join(" / ")} = この環境では未設定）` : ""),
});
