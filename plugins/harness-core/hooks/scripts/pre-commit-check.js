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
 *
 * 時間予算（R-1）:
 *   タイムアウトした PreToolUse hook は「ブロックせず続行」する仕様のため、
 *   hook 自体がタイムアウトするとゲートが静かに無効化される。
 *   そこで全体予算 TOTAL_BUDGET_MS を残りコマンド数で配分し、hook のタイムアウトより先に
 *   個々のコマンドを打ち切って **失敗として deny する**（素通りさせない）。
 */
const lib = require("./harness-lib");

const payload = lib.readPayload();
if (!payload) lib.passThrough();

if (!lib.isGitCommit(lib.toolCommand(payload))) lib.passThrough();

// コミット直前の HEAD を記録する（post-commit-doc-check が「本当にコミットされたか」を判定するため）。
// config の有無に関わらず必ず記録したいので、loadConfig より前に行う
lib.writeHeadMarker();

const { status, config, message } = lib.loadConfig();
if (status === "missing" || status === "invalid") lib.passThrough();
if (status === "newer") {
  lib.emit({ systemMessage: `[pre-commit-check] ${message}` });
  process.exit(0);
}

const gates = Array.isArray(config?.gates?.preCommit) ? config.gates.preCommit : [];
if (!gates.length) lib.passThrough();

// gates を先に解決し、「実行するもの」「意図的にスキップ（null）」「typo 疑い（キー不在）」を分ける
const runnable = [];
const skipped = [];
const warnings = [];

for (const key of gates) {
  const resolved = lib.resolveCommand(config, key);
  if (resolved.status === "ok") runnable.push(resolved);
  else if (resolved.status === "null") skipped.push(key);
  else warnings.push(`gates.preCommit の "${key}" は commands に存在しません（typo?）`);
}

const results = [];
let remainingBudget = lib.TOTAL_BUDGET_MS;

for (let i = 0; i < runnable.length; i++) {
  const { key, command } = runnable[i];
  // 残り予算を残りコマンド数で等分し、1コマンドの上限も超えないようにする
  const budgetForThis = Math.max(1000, Math.floor(remainingBudget / (runnable.length - i)));
  const timeout = Math.min(lib.MAX_COMMAND_MS, budgetForThis);

  const { ok, output, timedOut, elapsedMs } = lib.run(command, timeout);
  remainingBudget -= elapsedMs;

  if (!ok) {
    const head = timedOut
      ? `コマンドがタイムアウトしました（${Math.round(timeout / 1000)}秒を超過）。\n`
      : "";
    lib.emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `コミット前チェック「${key}」が失敗しました（${command}）。修正してから再度コミットしてください。\n` +
          head +
          lib.errorExcerpt(output, 20) +
          (warnings.length ? `\n⚠️ ${warnings.join(" / ")}` : ""),
      },
    });
    process.exit(0);
  }
  results.push(key);
}

if (!results.length) {
  // 実行対象が無い場合。typo 疑いがあるときだけは黙らず知らせる
  if (warnings.length) {
    lib.emit({ systemMessage: `[pre-commit-check] ⚠️ ${warnings.join(" / ")}` });
    process.exit(0);
  }
  // 全て null（＝チェック無し環境）または gates 空 → 静かに通す
  lib.passThrough();
}

lib.emit({
  systemMessage:
    `[pre-commit-check] ✅ ${results.join(" / ")} 成功` +
    (skipped.length ? `（スキップ: ${skipped.join(" / ")} = この環境では未設定）` : "") +
    (warnings.length ? `\n⚠️ ${warnings.join(" / ")}` : ""),
});
