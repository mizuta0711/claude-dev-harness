/**
 * PostToolUse フック: ソース配下のファイルを編集した直後に lint を自動修正する
 *
 * hooks.json の matcher は `Edit|Write` のみで絞り、**対象かどうかの最終判定は本スクリプトが持つ**
 * （Phase 2 指示書 §0-8 の standalone 規約。`if` 条件は使わない）。
 *
 * config 駆動の範囲:
 *   - `commands.lint` が null / 未定義 → **この環境には lint が無い**とみなして素通りする
 *   - `paths.source` の glob に一致するファイルだけを対象にする（未定義なら `src/**` を既定とする）
 *
 * `commands.lint`（例: `npm run lint`）はプロジェクト全体を対象とする形式でファイル引数を取れないため、
 * 1ファイルの自動修正には eslint を**直接**起動する（`node_modules/.bin/eslint --fix <file>`）。
 * **`npx` 経由にしない** —— 解決処理のぶん毎編集に約 0.9 秒が上乗せされる（実測・下の `eslintBin` を見ること）。
 * config が決めるのは「lint があるか」、修正の実行方法はこのプラグインが持つ、という分担にしている。
 *
 * 型チェックは意図的に含めていない。毎編集で tsc を回すと実装のテンポを崩すため、
 * 型チェックはコミット前ゲート（core の pre-commit-check）に任せる。
 *
 * 非ブロッキング。lint 未導入・エラーいずれの場合も作業は止めない（fail-open）。
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const lib = require("./plugin-lib.js");

/** このプラグインが lint 対象とする拡張子（Next.js 環境の知識） */
const LINT_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** `src/**` のような単純な glob を正規表現へ変換する（`**` = 任意、`*` = `/` を跨がない任意） */
function globToRegExp(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp("^" + escaped + "$");
}

function main() {
  const payload = lib.readPayload();
  if (!payload) process.exit(0);

  const filePath = payload?.tool_input?.file_path || "";
  if (!filePath) process.exit(0);

  const { status, config } = lib.loadConfig();
  if (status !== "ok") process.exit(0);

  // commands.lint が無い環境では何もしない
  if (!lib.commandFor(config, "lint")) process.exit(0);

  const root = lib.projectDir();
  const rel = lib.toPosix(path.relative(root, filePath));
  // プロジェクト外のファイル（`..` で始まる）は対象外
  if (!rel || rel.startsWith("..")) process.exit(0);
  if (!LINT_EXTENSIONS.test(rel)) process.exit(0);

  const sources = Array.isArray(config?.paths?.source) && config.paths.source.length
    ? config.paths.source
    : ["src/**"];
  if (!sources.some((glob) => globToRegExp(glob).test(rel))) process.exit(0);

  // ローカルの eslint を**直接**起動する。`npx` 経由だと解決処理のぶん毎編集に
  // 約 0.9 秒（実測・全体の約 24%）が上乗せされる。パスは下で確定させているので npx は不要。
  const eslintBin = path.join(root, "node_modules", ".bin", "eslint");
  const eslintCmd = fs.existsSync(eslintBin + ".cmd")
    ? eslintBin + ".cmd" // Windows のラッパー
    : fs.existsSync(eslintBin)
      ? eslintBin
      : null;
  if (!eslintCmd) {
    // テンプレート利用開始直後など、まだ依存が入っていない場合は黙ってスキップ
    process.exit(0);
  }

  try {
    execSync(`"${eslintCmd}" --fix "${rel}"`, {
      cwd: root,
      encoding: "utf-8",
      timeout: 25000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // 修正のみで完了、または元から問題なし。ノイズを増やさないため無出力
    process.exit(0);
  } catch (e) {
    // --fix で解決できない指摘が残った場合のみ知らせる
    const out = ((e.stdout || "") + (e.stderr || "")).split("\n").slice(0, 12).join("\n").trim();
    if (!out) process.exit(0);
    // **2経路とも出す**（#23 / 2026-08-15 の実測）。
    // C1 2周目は「PostToolUse では systemMessage が画面に出ない」と判断して
    // additionalContext へ**移した**が、これは誤りだった
    // （同じ Claude Code v2.1.232 で、Edit / Write の PostToolUse でも画面に出る）。
    // 移した結果、今度はユーザーの画面から消えていた。**片方に賭けない。**
    lib.notify(
      "PostToolUse",
      `[lint] ${rel} に自動修正できない指摘が残っています:\n${out}`
    );
  }

}

// フックとして起動されたときだけ実行する。
// `require` されたとき（テスト）は判定関数だけを取り出せるようにしておく。
if (require.main === module) main();

module.exports = { globToRegExp, LINT_EXTENSIONS };
