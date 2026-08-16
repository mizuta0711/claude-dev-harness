/**
 * SessionStart フック: セッション開始時に現在の状況と config の健全性を注入する
 *
 * matcher: startup|resume|clear|compact（`hooks.json` と一致させること）
 *
 * 毎回ユーザーが「今どこまで進んでいるか」を説明しなくて済むように、
 * ブランチ・未プッシュ数・未コミット数・進行中の機能設計書を additionalContext に載せる。
 *
 * harness-core は .claude/harness.config.json を契約として動くため、
 * **このフックだけは config 不在・不正を警告する**（他の hook は黙って素通りする / 04仕様 §4-1）。
 *
 * source === "compact" の場合は pre-compact-save.js が退避した
 * .claude/.session-context.json を読み戻し、コンパクトで失われた文脈を復元する。
 *
 * すべての取得は失敗しても落とさない（情報提示が目的であり、作業を止めてはいけない）。
 */
const fs = require("fs");
const path = require("path");
const lib = require("./harness-lib");

const SAVE_FILE = path.join(lib.projectDir(), ".claude", ".session-context.json");

/** docs/features/ 直下の進行中設計書を、メタ情報の全体ステータス付きで列挙する */
function activeFeatureDocs() {
  const dir = path.join(lib.projectDir(), "docs", "features");
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "TEMPLATE.md")
    .map((e) => {
      const file = path.join("docs", "features", e.name);
      let status = "";
      try {
        // メタ情報テーブルの「全体ステータス」行だけを見る（全文読みは不要）
        const head = fs
          .readFileSync(path.join(lib.projectDir(), file), "utf-8")
          .split("\n")
          .slice(0, 40)
          .join("\n");
        const m = head.match(/\|\s*全体ステータス\s*\|\s*([^|]+?)\s*\|/);
        if (m) status = m[1];
      } catch {
        /* 読めなければステータスなしで列挙する */
      }
      return { file: lib.toPosix(file), status };
    })
    .filter((d) => !/🟢|完了/.test(d.status));
}

const input = lib.readPayload() || {};
const lines = [];

// --- config の健全性チェック（harness-core の前提） ---
const cfg = lib.loadConfig();
if (cfg.status === "ok") {
  const env = cfg.config?.environment || "(environment 未設定)";
  lines.push(`[harness] environment: ${env} / schemaVersion: ${cfg.config.schemaVersion}`);
} else {
  lines.push(`[harness] ⚠️ ${cfg.message}`);
  if (cfg.status === "missing") {
    lines.push(
      "  → build-check / update-docs / pre-commit ゲート等は設定不在として動作します。" +
        "テンプレートから harness.config.json を配置してください。"
    );
  }
}

// --- git の状況 ---
//
// ⚠️ **upstream が無いブランチで黙らないこと。**
// かつては `@{upstream}..HEAD` だけを見ていたが、これは upstream が設定されている
// ブランチでしか値を返さない。**エージェントが自動で切ったブランチには upstream が無い**ため、
// 「ユーザーが知らないブランチに未プッシュのコミットが積み上がっている」という
// **最も知らせるべき状況でだけ、未プッシュ数の行ごと消えていた**（2026-08-16 実測。
// skillup_mock で 4 コミットが約 20 時間気づかれずに残った）。
// upstream が無い場合はリモートの既定ブランチを基準にして数え、**その旨を明示する**。
const branch = lib.git("branch --show-current", 3000);
const dirty = lib.git("status --porcelain", 3000);

const upstream = lib.git("rev-parse --abbrev-ref @{upstream}", 3000);
const defaultRef = lib.git("symbolic-ref --short refs/remotes/origin/HEAD", 3000);

let ahead = "";
let aheadLabel = "未プッシュ";
let orphanBranch = false;

if (upstream) {
  ahead = lib.git("rev-list --count @{upstream}..HEAD", 3000);
} else if (defaultRef) {
  // upstream 未設定。既定ブランチに無いコミットを数える
  ahead = lib.git(`rev-list --count ${defaultRef}..HEAD`, 3000);
  aheadLabel = `${defaultRef} に無い`;
  orphanBranch = Boolean(ahead && ahead !== "0");
}

const head = [];
if (branch) head.push(`branch: ${branch}${upstream ? "" : "（upstream 無し）"}`);
if (ahead && ahead !== "0") head.push(`${aheadLabel}: ${ahead} commits`);
if (dirty) head.push(`未コミット: ${dirty.split("\n").length} ファイル`);
if (head.length) lines.push(`[状況] ${head.join(" / ")}`);

if (orphanBranch) {
  lines.push(
    `  → **このブランチは push されていない。** ${defaultRef} に無いコミットが ${ahead} 件ある。` +
      `ユーザーが把握していない可能性があるため、作業を始める前に扱い` +
      `（push / 既定ブランチへマージ / ローカル維持）を確認すること。`
  );
}

const docs = activeFeatureDocs();
if (docs.length) {
  lines.push("[進行中の機能設計書]");
  for (const d of docs) {
    lines.push(`  - ${d.file}${d.status ? ` (${d.status})` : ""}`);
  }
}

// コンパクト直後は、退避しておいた文脈を復元する
if (input.source === "compact") {
  try {
    const saved = JSON.parse(fs.readFileSync(SAVE_FILE, "utf-8"));
    if (saved?.note) lines.push(`[コンパクト前の作業] ${saved.note}`);
    if (Array.isArray(saved?.activeFeatureDocs) && saved.activeFeatureDocs.length) {
      lines.push(`[コンパクト前の設計書] ${saved.activeFeatureDocs.join(", ")}`);
    }
    fs.unlinkSync(SAVE_FILE);
  } catch {
    /* 退避ファイルが無い・壊れている場合は無視する */
  }
}

if (!lines.length) process.exit(0);

/**
 * 画面には**1行だけ**出す（#23）。
 *
 * SessionStart の `systemMessage` は画面に出ることが実測で分かったが、
 * 状況の詳細（未プッシュ数・進行中の設計書・コンパクト前の文脈）は
 * **Claude が使うための情報**であって、毎回の起動で人に読ませるものではない。
 * 人が知りたいのは **「ハーネスが載っているか」**の一点なので、そこだけを出す。
 *
 * これで「導入できたのか分からない」（C1 のつまずき）が起動時に解消する。
 * 設定不在の警告は**見逃されると全機能が黙って素通りする**ため、画面にも出す。
 */
// **例外がひとつある。** 「push されていないブランチの上にいる」ことだけは画面にも出す。
// 気づかないまま作業を重ねると、コミットが増えるほど始末が難しくなる種類の問題であり、
// Claude の文脈にだけ入れても人には届かない。
const screen =
  cfg.status === "ok"
    ? `[harness] ${cfg.config?.environment || "environment 未設定"} / config OK` +
      (orphanBranch ? ` ⚠️ ブランチ \`${branch}\` は未 push（${defaultRef} に無いコミット ${ahead} 件）` : "")
    : `[harness] ⚠️ ${cfg.message}`;

lib.emit({
  systemMessage: screen,
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: lines.join("\n"),
  },
});
