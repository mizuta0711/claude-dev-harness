/**
 * SubagentStop フック: サブエージェント終了時に差分確認を促す
 *
 * 「サブエージェントの結果は必ずメインで差分確認・フロー検証してからコミットする」という
 * 運用ルールを文言で重ねるだけでは既読スルーされるため、
 * **変更ファイル数と実行できるコマンドをその場に出す**ことで
 * 「読む」から「実行する」までの距離を縮めることを狙う。
 *
 * 非ブロッキング。変更が無ければ何も出さない。
 */
const lib = require("./harness-lib");

const payload = lib.readPayload();
if (!payload) lib.passThrough();

const agent = payload?.agent_type || payload?.subagent_type || "サブエージェント";

const files = lib.git("status --porcelain", 3000).split("\n").filter(Boolean);
if (!files.length) lib.passThrough();

const preview = files
  .slice(0, 5)
  .map((l) => `  ${l.trim()}`)
  .join("\n");
const more = files.length > 5 ? `\n  ...ほか ${files.length - 5} 件` : "";

lib.emit({
  systemMessage:
    `[subagent] ${agent} の終了時点で ${files.length} ファイルに変更があります。\n` +
    `${preview}${more}\n` +
    "コミット前に `git diff` で内容を確認すること（ビルド成功 ≠ 正しい実装）。",
});
