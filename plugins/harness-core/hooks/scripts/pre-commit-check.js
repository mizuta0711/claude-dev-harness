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
 *   - paths.source に一致するファイルが無い（未初期化）→ ゲートを飛ばし、飛ばしたことを知らせる（H45）
 *   - 同じコマンドで git commit より前にファイルを変えうる操作がある → deny（H48。その変更はゲートに映らない）
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
const scope = require("./git-scope");

const payload = lib.readPayload();
if (!payload) lib.passThrough();

if (!lib.isGitCommit(lib.toolCommand(payload))) lib.passThrough();

// コミット直前の HEAD を記録する（post-commit-doc-check が「本当にコミットされたか」を判定するため）。
// config の有無に関わらず必ず記録したいので、loadConfig より前に行う
lib.writeHeadMarker();

/**
 * サブエージェントが動いていれば、その事実を通知へ添える文言を作る。
 *
 * SubagentStop には通知経路が無いため（`subagent-stop-diff.js` の冒頭を参照）、
 * **コミットしようとしたこの瞬間**に合流させる。差分確認が最も効くのはここである。
 *
 * 記録は読んだ時点で消える。`gates` が空でも素通りの前に読み消す設計にはせず、
 * **必ず通知を出せる経路に乗せてから**消す（消したのに誰にも届かない、を避ける）。
 */
const subagentMarks = lib.consumeSubagentMarker();

function subagentNote() {
  if (!subagentMarks.length) return "";
  const names = [...new Set(subagentMarks.map((m) => m.agent))].join(" / ");
  const max = Math.max(...subagentMarks.map((m) => Number(m.files) || 0));
  return (
    `\n⚠️ 前回のコミット以降に**サブエージェント（${names}）が ${subagentMarks.length} 回**動いています` +
    `（終了時点で最大 ${max} ファイルに変更）。\n` +
    "   `git diff` で内容を確認してからコミットすること（**ビルド成功 ≠ 正しい実装**）。"
  );
}

/**
 * コミットをブロックした場合は記録を**書き戻す**。
 *
 * ブロックすると Claude は修正して**もう一度コミットしようとする**。
 * そのとき記録が消えていると、**差分未確認のまま2回目が通ってしまう**。
 * 記録が残る条件は「コミットがまだ成立していない」ことなので、
 * 繰り返し出ても誤警報にはならない（§8「安全弁は正常な操作で鳴らないことが要件」）。
 */
function restoreSubagentMarks() {
  for (const mark of subagentMarks) lib.writeSubagentMarker(mark);
}

const { status, config, message } = lib.loadConfig();

// ⚠️ **config が無い／壊れているときも、記録は既に消えている。**
// 記録の読み消しは冒頭（`consumeSubagentMarker`）で起きるため、ここで黙って
// `passThrough` すると**消したのに誰にも届かない**。
// config 不在は契約上サポートされる状態（設定契約 §3）なので、
// 「設定していないプロジェクトでは警告が出ない」は仕様ではなく欠陥だった（R1）。
if (status === "missing" || status === "invalid") {
  const note = subagentNote();
  if (note) {
    lib.notify("PreToolUse", `[pre-commit-check]${note}`);
    process.exit(0);
  }
  lib.passThrough();
}
if (status === "newer") {
  lib.notify("PreToolUse", `[pre-commit-check] ${message}${subagentNote()}`);
  process.exit(0);
}

// 冒頭で読み消した記録の文言。以降のどの分岐でも出力に添える
// （消したのに誰にも届かない、を作らない）
const subagent = subagentNote();

const gates = Array.isArray(config?.gates?.preCommit) ? config.gates.preCommit : [];
if (!gates.length) {
  // ゲートが無い環境でも、サブエージェントが動いていたことだけは伝える
  if (subagent) {
    lib.notify("PreToolUse", `[pre-commit-check]${subagent}`);
    process.exit(0);
  }
  lib.passThrough();
}

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

// 同じコマンドの中で、`git commit` より前にファイルを変えうる操作がある（H48）。
// このフックはコマンドの**実行前**に走るので、その変更はゲートに映らない。
// 素通りさせると「✅ 成功」のまま壊れたコミットができるため deny する（分ければ済むので自己修復できる）。
const unseen = runnable.length
  ? scope.changesBeforeCommit(lib.toolCommand(payload), { shell: lib.toolShell(payload) })
  : null;
if (unseen) {
  const reason =
    "`git commit` は、ファイルを変えうる操作とは**別の呼び出し**で実行してください。\n" +
    `このコマンドでは \`${unseen}\` がコミットより前にあります。コミット前チェック（${runnable.map((r) => r.key).join(" / ")}）は` +
    "コマンドの実行前に走るため、その変更を検査できません（同じ1行のままだと、壊れていても「成功」と表示されてコミットされます）。\n" +
    "先にその操作だけを実行し、`git add` / `git commit` を次の呼び出しで実行してください。" +
    subagent;
  restoreSubagentMarks();
  lib.emit({
    systemMessage: `[pre-commit-check] ❌ ${reason}`,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
  process.exit(0);
}

// 未初期化のプロジェクト（`paths.source` に一致するファイルが1つも無い）ではゲートを飛ばす（H45）。
// create-project 直後は package.json もツールチェーンも無く、ゲートが**必ず**失敗して
// Phase 0 より前のコミットが正規の手段では通らなかった。判定は new-feature の Step 0 と同じ。
// **判定できないとき（null）は飛ばさない。** 飛ばしたことは必ず知らせる。
// H48 の判定より後に置く: 同じ1行で最初のソースを作ってコミットすると、ここでは「未初期化」に見えるため。
if (runnable.length && lib.hasSourceFiles(config) === false) {
  lib.notify(
    "PreToolUse",
    `[pre-commit-check] ⏭️ プロジェクトが未初期化のため、コミット前チェック（${runnable.map((r) => r.key).join(" / ")}）を飛ばしました` +
      `（paths.source = ${JSON.stringify(config.paths.source)} に一致するファイルがありません。ソースが別の場所にあるなら paths.source を直してください）。` +
      (warnings.length ? `\n⚠️ ${warnings.join(" / ")}` : "") +
      subagent
  );
  process.exit(0);
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
    const reason =
      `コミット前チェック「${key}」が失敗しました（${command}）。修正してから再度コミットしてください。\n` +
      head +
      lib.errorExcerpt(output, 20) +
      (warnings.length ? `\n⚠️ ${warnings.join(" / ")}` : "") +
      subagent;
    // ブロックしたということはコミットは成立していない。次の試行でも出せるよう記録を戻す
    restoreSubagentMarks();
    // ブロック時は `permissionDecisionReason` が Claude へ確実に届く経路なのでそれを使い、
    // 同じ内容を `systemMessage` でユーザーの画面にも出す（#23）
    lib.emit({
      systemMessage: `[pre-commit-check] ❌ ${reason}`,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    });
    process.exit(0);
  }
  results.push(key);
}

if (!results.length) {
  // 実行対象が無い場合。typo 疑い、またはサブエージェントの記録があるときだけ知らせる
  if (warnings.length || subagent) {
    lib.notify(
      "PreToolUse",
      `[pre-commit-check]` +
        (warnings.length ? ` ⚠️ ${warnings.join(" / ")}` : "") +
        subagent
    );
    process.exit(0);
  }
  // 全て null（＝チェック無し環境）→ 静かに通す
  lib.passThrough();
}

lib.notify(
  "PreToolUse",
  `[pre-commit-check] ✅ ${results.join(" / ")} 成功` +
    (skipped.length ? `（スキップ: ${skipped.join(" / ")} = この環境では未設定）` : "") +
    (warnings.length ? `\n⚠️ ${warnings.join(" / ")}` : "") +
    subagent
);
