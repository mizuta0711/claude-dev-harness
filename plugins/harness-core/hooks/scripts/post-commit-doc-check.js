/**
 * PostToolUse フック: コミット後に設計書同期の必要性を知らせる
 *
 * 3テンプレートで「トリガーパスの表」だけが違う同一スクリプトだったものを、
 * `.claude/harness.config.json` の `paths.docTriggers` 駆動に置き換えた唯一実装。
 *
 * 動作:
 *   - `git commit` を含むコマンド以外は即素通り
 *   - **コミットが実際に成立したかを HEAD 比較 + reflog の2段構えで確認**する（R-2）。
 *     非ゼロ終了の Bash では PostToolUse は発火しない（実測、契約文書 §6-2）が、
 *     `git commit --dry-run` や `... || true` のように**成功終了しつつコミットを作らない**
 *     ケースでは発火するため、確認しないと「直前の別コミット」の差分で誤通知してしまう
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

// --- コミットが実際に成立したかの確認（2段構え） ---
//
// (1) HEAD 比較: pre-commit-check（PreToolUse）が同じ git commit 呼び出しの直前に記録した HEAD と
//     現在の HEAD を比べる。変化していなければコミットは作られていない。最も確実な判定
// (2) reflog: 記録が無い場合（PreToolUse が動いていない構成など）のフォールバック。
//     直前の git 操作が commit 以外なら素通りする
//
// どちらも判断材料が無い場合は従来どおり判定に進む（fail-open。
// 通知が誤る可能性より、通知が完全に死ぬことを避ける）
const previousHead = lib.consumeHeadMarker();
if (previousHead) {
  const currentHead = lib.headCommit() || "(none)";
  if (previousHead === currentHead) lib.passThrough();
} else {
  const lastReflog = lib.git("reflog -1 --format=%gs", 3000);
  if (lastReflog && !/^commit(\s+\([^)]*\))?:/.test(lastReflog)) lib.passThrough();
}

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
