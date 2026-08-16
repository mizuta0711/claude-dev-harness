/**
 * claude-dev-harness **リポジトリ固有**の PreToolUse ガード（H19）
 *
 * ## なぜここに置くのか
 *
 * このリポジトリには `.claude/` が無く、規律は `CLAUDE.md` という**読ませる文書だけ**で
 * 担保されていた。結果、2026-08-16 の1日で規約違反が3件（うち1件は2版連続）出た。
 * ハーネス自身が「**仕組みで強制する。記憶に頼らない**」（constitution / 入門ガイド §2-3）と
 * 定めながら、**その仕組みを利用側にだけ配って自分には適用していなかった**のが真因。
 *
 * ## なぜ配布物のプラグインではなくリポジトリ固有なのか
 *
 * **自分が編集中のプラグインに、自分の規律を依存させないため。**
 * `plugins/harness-core/hooks/` に置くと、フックを壊した瞬間に自分のセッションが止まり、
 * 直すために規律を外すことになる。ブートストラップの輪を作らない。
 *
 * また `tools/create-project.mjs` は `templates/` からしか読まないため、
 * **リポジトリ直下の `.claude/` は生成物にも `harness-update` の3点比較にも入らない**
 * （確認済み。追従対象外にする特別な措置は不要）。
 *
 * ## 何を止めるか
 *
 * | # | 対象 | 理由 |
 * |---|------|------|
 * | 1 | `git add -A` / `git add .` | 他セッションがステージ済みの変更を巻き込む。`b22c887` / `6c68d30` で実際に発生 |
 * | 2 | `git push`（validate 不通過時） | 版番号の2ファイル不一致など、**機械で判定できる欠陥を公開前に止める** |
 *
 * ### #2 の実害の正確な範囲（2026-08-16 実測）
 *
 * `marketplace.json` と `plugin.json` の版がずれても**配信は止まらない**。
 * `claude plugin validate --strict` 自身がこう言う:
 *
 * > At install time, plugin.json wins (calculatePluginVersion precedence)
 * > — the entry version is silently ignored.
 *
 * 実際 0.6.4 は marketplace が 0.6.3 のまま3プロジェクトへ配信されている。
 * **止まるのではなく、カタログの表示が黙って嘘になる**のが実害。
 * それでも止める価値があるのは、**判定が機械的で検査コマンドが既にある**（＝最も安い）から。
 */
const { execSync } = require("child_process");

const REPO = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function readPayload() {
  try {
    return JSON.parse(require("fs").readFileSync(0, "utf-8"));
  } catch {
    return null;
  }
}

function deny(label, reason) {
  console.log(
    JSON.stringify({
      systemMessage: `[repo-guard] ❌ ${label}`,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

const payload = readPayload();
if (!payload) process.exit(0);

const command = payload?.tool_input?.command || "";
if (!command) process.exit(0);

// --- 1. git add -A / git add . を止める -------------------------------------
//
// `git add -A` / `--all` / `.` / `:/` を拾う。パス指定の `git add src/` は通す。
if (/\bgit\b(?:\s+(?:-[cC]\s*\S+|--\S+))*\s+add\b(?![^\n;&|]*--dry-run)([^\n;&|]*)/.test(command)) {
  const args = RegExp.$1 || "";
  if (/(^|\s)(-A|--all|\.|:\/)(\s|$)/.test(args)) {
    deny(
      "git add -A / git add . は使えません",
      "このリポジトリでは **コミットは必ずパス指定** です（CLAUDE.md「運用ルール」）。\n" +
        "`git add -A` / `git add .` は、**他のエージェント／セッションが未コミットで置いている変更を巻き込みます**。\n" +
        "実際に `b22c887` と `6c68d30` で発生し、6c68d30 では別セッションの20ファイルを巻き込んだまま push されました。\n\n" +
        "代わりに次のどちらかを使ってください:\n" +
        "  git commit -- <path...>            # ステージせずに直接コミット\n" +
        "  git add <path...> && git commit    # 対象を明示してステージ\n\n" +
        "**まず `git status --short` で、自分が触っていないファイルが無いか確認すること。**"
    );
  }
}

// --- 2. push 前に marketplace の整合を検査する -------------------------------
if (/\bgit\b(?:\s+(?:-[cC]\s*\S+|--\S+))*\s+push\b/.test(command)) {
  let output = "";
  let ok = true;
  try {
    output = execSync("claude plugin validate . --strict", {
      cwd: REPO,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });
  } catch (e) {
    ok = false;
    output = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
  }

  if (!ok) {
    deny(
      "claude plugin validate --strict が通っていません",
      "push 前の検査に失敗しました。**公開前に直してください。**\n\n" +
        "```\n" +
        String(output).trim().split("\n").slice(0, 25).join("\n") +
        "\n```\n\n" +
        "よくある原因は **版番号の上げ忘れ**です。版を上げるときは\n" +
        "`plugins/<name>/.claude-plugin/plugin.json` と `.claude-plugin/marketplace.json` の**両方**を\n" +
        "上げること（CLAUDE.md §2 / 関門1）。`076d5dd` と `6c68d30` で2版連続で漏れました。\n\n" +
        "> 版がずれても配信自体は止まりません（install 時は plugin.json が勝つ）。\n" +
        "> **カタログの表示が黙って嘘になる**のが実害です。"
    );
  }
}

process.exit(0);
