/**
 * PreCompact フック: コンパクト前に進行中の文脈を退避する
 *
 * プロジェクト側の `.claude/rules/` の paths ルールはコンパクト後に自動再注入されない。
 * また、会話中にのみ存在した情報（進行中の設計書、規模判定の結果）も失われる。
 * そこで退避ファイルに書き出し、SessionStart(source=compact) で読み戻す。
 *
 * PreCompact は additionalContext に非対応のため、この「ファイル経由の受け渡し」が必要になる。
 *
 * 失敗しても落とさない（コンパクト自体は止めない）。
 */
const fs = require("fs");
const path = require("path");
const lib = require("./harness-lib");

const SAVE_FILE = path.join(lib.projectDir(), ".claude", ".session-context.json");

const input = lib.readPayload() || {};

function activeFeatureDocs() {
  const dir = path.join(lib.projectDir(), "docs", "features");
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "TEMPLATE.md")
      .map((e) => lib.toPosix(path.join("docs", "features", e.name)));
  } catch {
    return [];
  }
}

try {
  const payload = {
    trigger: input.trigger || "unknown",
    branch: lib.git("branch --show-current", 3000),
    uncommittedFiles: (lib.git("status --porcelain", 3000) || "").split("\n").filter(Boolean).length,
    activeFeatureDocs: activeFeatureDocs(),
    note:
      "コンパクト前に退避。paths ルール（.claude/rules/）はコンパクト後に自動再注入されないため、" +
      "該当ファイルを次に読むまで有効にならない点に注意。",
  };

  fs.writeFileSync(SAVE_FILE, JSON.stringify(payload, null, 2));
  lib.emit({
    systemMessage: `[precompact] 進行中の文脈を .claude/.session-context.json に退避しました。`,
  });
} catch {
  process.exit(0);
}
