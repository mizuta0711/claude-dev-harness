/**
 * claude-dev-harness の規律を強制する PreToolUse ガード（H19）
 *
 * ## なぜ必要か
 *
 * このリポジトリには `.claude/` が無く、規律は `CLAUDE.md` という**読ませる文書だけ**で
 * 担保されていた。結果、2026-08-16 の1日で規約違反が3件（うち1件は2版連続）出た。
 * ハーネス自身が「**仕組みで強制する。記憶に頼らない**」（constitution / 入門ガイド §2-3）と
 * 定めながら、**その仕組みを利用側にだけ配って自分には適用していなかった**のが真因。
 *
 * ## なぜ配布物のプラグインではないのか
 *
 * **自分が編集中のプラグインに、自分の規律を依存させないため。**
 * `plugins/harness-core/hooks/` に置くと、フックを壊した瞬間に自分のセッションが止まり、
 * 直すために規律を外すことになる。ブートストラップの輪を作らない。
 *
 * `tools/create-project.mjs` は `templates/` からしか読まないため、
 * **リポジトリ直下の `.claude/` は生成物にも `harness-update` の3点比較にも入らない**（確認済み）。
 *
 * ## ⚠️ 置き場所は1箇所では足りない
 *
 * フックは**セッションのプロジェクトディレクトリの `.claude/settings.json`** だけが読まれる。
 * ハーネスは **ProjectTemplete のセッションから `cd` して編集される**ことが常態であり、
 * 事故（`6c68d30`）もそちらで起きた。**ハーネス側に置いただけでは、事故った経路を覆えない。**
 *
 * そのため本スクリプトは**どちらに置いても正しく動く**ように、
 * **コマンドから対象ディレクトリを解決する**（`cd X && ...` / `git -C X`）。
 * 同じものを ProjectTemplete の `.claude/hooks/` にも置く。
 *
 * ## 何を止めるか
 *
 * | # | 対象 | 適用範囲 | 理由 |
 * |---|------|---------|------|
 * | 1 | `git add -A` / `git add .` | **どのリポジトリでも** | 他セッションがステージ済みの変更を巻き込む。`6c68d30` で実際に発生 |
 * | 2 | `git push`（validate 不通過時） | **marketplace を持つリポジトリのみ** | 版番号の2ファイル不一致など、機械で判定できる欠陥を公開前に止める |
 *
 * ### #2 の実害の正確な範囲（2026-08-16 実測）
 *
 * `marketplace.json` と `plugin.json` の版がずれても**配信は止まらない**。
 * `claude plugin validate --strict` 自身がこう言う:
 *
 * > At install time, plugin.json wins (calculatePluginVersion precedence)
 * > — the entry version is silently ignored.
 *
 * 実際 0.6.4 は marketplace が 0.6.3 のまま3プロジェクトへ配信された。
 * **止まるのではなく、カタログの表示が黙って嘘になる**のが実害。
 * それでも止める価値があるのは、**判定が機械的で検査コマンドが既にある**（＝最も安い）から。
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function readPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf-8"));
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

/** MSYS/Git Bash の `/d/foo` を Windows の `d:/foo` に直す（Node の fs はこれを解釈しない） */
function toNativePath(p) {
  const s = String(p || "").replace(/^["']|["']$/g, "");
  const m = s.match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1]}:/${m[2]}` : s;
}

/**
 * コマンドが実際に作用するディレクトリを解く。
 *
 * `cd X && git push` のように**セッションのプロジェクト外**を操作する形が常態なので、
 * `CLAUDE_PROJECT_DIR` だけを見ると**対象を取り違える**。
 */
function resolveTargetDir(cmd) {
  const viaC = cmd.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/);
  if (viaC) {
    const d = toNativePath(viaC[1]);
    if (fs.existsSync(d)) return d;
  }
  const viaCd = cmd.match(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|\S+)/);
  if (viaCd) {
    const d = toNativePath(viaCd[1]);
    if (fs.existsSync(d)) return d;
  }
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

const payload = readPayload();
if (!payload) process.exit(0);

const command = payload?.tool_input?.command || "";
if (!command) process.exit(0);

// --- 1. git add -A / git add . を止める（どのリポジトリでも） -----------------
if (/\bgit\b(?:\s+(?:-[cC]\s*\S+|--\S+))*\s+add\b(?![^\n;&|]*--dry-run)([^\n;&|]*)/.test(command)) {
  const args = RegExp.$1 || "";
  if (/(^|\s)(-A|--all|\.|:\/)(\s|$)/.test(args)) {
    deny(
      "git add -A / git add . は使えません",
      "**コミットは必ずパス指定**です（`claude-dev-harness/CLAUDE.md` §1）。\n" +
        "`git add -A` / `git add .` は、**他のエージェント／セッションが未コミットで置いている変更を巻き込みます**。\n" +
        "`6c68d30` では別セッションの20ファイルを巻き込んだまま push まで到達しました。\n\n" +
        "代わりに次のどちらかを使ってください:\n" +
        "  git commit -- <path...>            # ステージせずに直接コミット\n" +
        "  git add <path...> && git commit    # 対象を明示してステージ\n\n" +
        "**まず `git status --short` で、自分が触っていないファイルが無いか確認すること。**"
    );
  }
}

// --- 2. push 前に marketplace の整合を検査する -------------------------------
//
// 対象ディレクトリが marketplace を持つリポジトリのときだけ走る。
// ProjectTemplete など普通のリポジトリへの push は素通りする。
if (/\bgit\b(?:\s+(?:-[cC]\s*\S+|--\S+))*\s+push\b/.test(command)) {
  const dir = resolveTargetDir(command);
  if (!fs.existsSync(path.join(dir, ".claude-plugin", "marketplace.json"))) process.exit(0);

  let output = "";
  let ok = true;
  try {
    output = execSync("claude plugin validate . --strict", {
      cwd: dir,
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
      `claude plugin validate --strict が通っていません（${dir}）`,
      "push 前の検査に失敗しました。**公開前に直してください。**\n\n" +
        "```\n" +
        String(output).trim().split("\n").slice(0, 25).join("\n") +
        "\n```\n\n" +
        "よくある原因は **版番号の上げ忘れ**です。版を上げるときは\n" +
        "`plugins/<name>/.claude-plugin/plugin.json` と `.claude-plugin/marketplace.json` の**両方**を\n" +
        "上げること（`CLAUDE.md` §2 / 関門1）。`076d5dd` と `6c68d30` で2版連続で漏れました。\n\n" +
        "> 版がずれても配信自体は止まりません（install 時は plugin.json が勝つ）。\n" +
        "> **カタログの表示が黙って嘘になる**のが実害です。"
    );
  }
}

process.exit(0);
