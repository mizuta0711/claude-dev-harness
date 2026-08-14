/**
 * PreToolUse フック: git commit 前の C# スクリプト検証（Unity）
 *
 * 対象は **ステージングされた `Assets/Scripts/` 以下の `.cs`**（`Assets/` 全体ではない）。
 * 検査内容:
 *   1. ファイル名とクラス名の一致 → **不一致は errors（コミットをブロックする）**
 *   2. root namespace の宣言有無 → **未宣言は warnings（ブロックしない）**
 *
 * ## 移植元からの変更点
 *
 * - **namespace のハードコード（`YourApp`）を廃止**し、`.claude/harness.config.json` の
 *   `envOptions.rootNamespace` から読むようにした（Phase 2 指示書 §0-9 = 発見事項 F5 の解消）。
 *   **設定が無ければ namespace 検査だけをスキップ**する（fail-open）。
 *   クラス名一致の検査は namespace 設定に依存しないので続行する。
 * - `git commit` の判定を広めの正規表現へ（`git -C dir commit` 等のグローバルオプション付きを取りこぼさない）
 * - stdin・config 読取を自前で行う standalone 実装（§0-8。core の harness-lib は require しない）
 * - ヘッダコメントと実装の齟齬（`Assets/` と書きつつ実装は `Assets/Scripts/` 限定）を修正
 * - ステージ済みファイルの中身は作業ツリーではなく **`git show :<path>`（インデックス）** から読む。
 *   作業ツリーを読むと「ステージ後にさらに編集した内容」を検査してしまい、
 *   実際にコミットされる内容と食い違うため
 */
const path = require("path");
const lib = require("./plugin-lib.js");

const payload = lib.readPayload();
if (!payload) process.exit(0);

const command = payload?.tool_input?.command || "";
if (!lib.isGitCommit(command)) process.exit(0);

// config は namespace 検査にのみ使う。読めなくてもクラス名検査は続行する
const { status, config } = lib.loadConfig();
const rootNamespace =
  status === "ok" && typeof config?.envOptions?.rootNamespace === "string"
    ? config.envOptions.rootNamespace.trim()
    : "";

const staged = lib
  .git("diff --cached --name-only --diff-filter=ACM")
  .split("\n")
  .map((f) => lib.toPosix(f.trim()))
  .filter((f) => f.endsWith(".cs") && f.startsWith("Assets/Scripts/"));

if (staged.length === 0) process.exit(0);

const errors = [];
const warnings = [];

for (const file of staged) {
  // インデックスの内容（＝実際にコミットされる内容）を読む
  const content = lib.git(`show ":${file}"`);
  if (!content) continue;

  const baseName = path.basename(file, ".cs");

  // 1. ファイル名とクラス名の一致
  const classMatch = content.match(/\bpublic\s+(?:partial\s+)?(?:class|struct|enum|interface|record)\s+(\w+)/);
  if (classMatch && classMatch[1] !== baseName) {
    errors.push(`${file}: クラス名 "${classMatch[1]}" がファイル名 "${baseName}" と一致しません`);
  }

  // 2. root namespace の宣言（設定が無ければスキップ = fail-open）
  if (rootNamespace) {
    // `namespace Foo` / `namespace Foo.Bar` / `namespace Foo;`（file-scoped）のいずれも許容する
    const nsPattern = new RegExp(
      `\\bnamespace\\s+${rootNamespace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`
    );
    if (!nsPattern.test(content)) {
      warnings.push(`${file}: namespace ${rootNamespace} が宣言されていません`);
    }
  }
}

if (errors.length > 0) {
  lib.emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "C# スクリプトにエラーがあります。コミット前に修正してください:\n" + errors.join("\n"),
    },
  });
  process.exit(0);
}

const notes = [];
if (warnings.length > 0) {
  notes.push(`C# check: 警告 ${warnings.length} 件`, ...warnings);
} else {
  notes.push(`C# check passed. (${staged.length} file(s))`);
}
if (!rootNamespace) {
  notes.push(
    "（.claude/harness.config.json の envOptions.rootNamespace が未設定のため namespace 検査はスキップしました）"
  );
}
lib.emit({ systemMessage: notes.join("\n") });
