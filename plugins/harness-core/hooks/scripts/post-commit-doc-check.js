/**
 * PostToolUse フック: コミット後に設計書同期の必要性を知らせる
 *
 * 3テンプレートで「トリガーパスの表」だけが違う同一スクリプトだったものを、
 * `.claude/harness.config.json` の `paths.docTriggers` 駆動に置き換えた唯一実装。
 *
 * 動作:
 *   - `git commit` を含むコマンド以外は即素通り
 *   - config 不在・壊れている → 素通り（fail-open）
 *   - 直近コミットの変更ファイルを docTriggers[].pattern（正規表現）と突き合わせ、
 *     一致した設計書名を挙げて /harness-core:update-docs を促す
 *
 * パスはリポジトリルートからの相対・フォワードスラッシュで評価する（04仕様 §4-3）。
 */
const lib = require("./harness-lib");

const payload = lib.readPayload();
if (!payload) lib.passThrough();

if (!lib.isGitCommit(lib.toolCommand(payload))) lib.passThrough();

const { status, config, message } = lib.loadConfig();
if (status === "missing" || status === "invalid") lib.passThrough();
if (status === "newer") {
  lib.emit({ systemMessage: `[doc-sync] ${message}` });
  process.exit(0);
}

const triggers = Array.isArray(config?.paths?.docTriggers) ? config.paths.docTriggers : [];
if (!triggers.length) lib.passThrough();

// 初回コミット等で HEAD~1 が無い場合は空文字が返る
const changed = lib
  .git("diff --name-only HEAD~1 HEAD")
  .split("\n")
  .map((f) => lib.toPosix(f.trim()))
  .filter(Boolean);

if (!changed.length) lib.passThrough();

const hit = new Set();

for (const trigger of triggers) {
  if (!trigger || typeof trigger.pattern !== "string") continue;
  let re;
  try {
    re = new RegExp(trigger.pattern);
  } catch {
    // 壊れた正規表現でフローを止めない
    continue;
  }
  if (!changed.some((f) => re.test(f))) continue;
  for (const doc of Array.isArray(trigger.docs) ? trigger.docs : []) hit.add(doc);
}

if (!hit.size) lib.passThrough();

lib.emit({
  systemMessage:
    `[doc-sync] このコミットには ${[...hit].join("・")} の更新が必要な変更が含まれています。` +
    `M/L 規模の作業であれば /harness-core:update-docs を実行してください。`,
});
