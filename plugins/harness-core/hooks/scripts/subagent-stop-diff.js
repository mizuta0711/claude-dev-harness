/**
 * SubagentStop フック: サブエージェントが動いたことを記録する
 *
 * 「サブエージェントの結果は必ずメインで差分確認・フロー検証してからコミットする」という
 * 運用ルールを、**コミットしようとした瞬間に**思い出させるための記録係。
 *
 * ## なぜ通知しないのか（2026-08-15 の実測・還元 #22）
 *
 * **SubagentStop には通知経路が無い。**
 *
 * | 経路 | 結果 |
 * |------|------|
 * | `systemMessage` | **ユーザーの画面に出ない** |
 * | `hookSpecificOutput.additionalContext` | **親（メイン）の文脈に届かない。** さらにサブエージェント自身へ戻り、**停止がキャンセルされてループする**（実測: 8回・42秒・23.7k トークン） |
 *
 * 移設先として PostToolUse（`Task` / `Agent`）も検証した。画面には出るが、
 * **サブエージェントがバックグラウンドで動く場合、ツールが返った時点＝起動直後に発火する**ため、
 * 「終わった時点の変更ファイル数」を出す用途には使えない。
 *
 * よって**この場では何も出さず、届くイベントまで情報を持ち越す**。
 * 合流先は `pre-commit-check`（PreToolUse・画面に出ることを実測で確認済み）。
 * コミットは必ずそこを通るので、**最も効いてほしい瞬間**に出せる。
 *
 * 非ブロッキング。変更が無ければ何も記録しない。
 */
const lib = require("./harness-lib");

const payload = lib.readPayload();
if (!payload) lib.passThrough();

const agent = payload?.agent_type || payload?.subagent_type || "サブエージェント";

const files = lib.git("status --porcelain", 3000).split("\n").filter(Boolean);
if (!files.length) lib.passThrough();

lib.writeSubagentMarker({ agent, files: files.length });

// 出力しない。この経路では誰にも届かないため（上記）
process.exit(0);
