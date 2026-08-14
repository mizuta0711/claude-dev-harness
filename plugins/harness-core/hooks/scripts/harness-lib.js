/**
 * harness-core 共通ライブラリ
 *
 * 各 hook スクリプトが共通で必要とする処理をここに集約する:
 *   - stdin JSON の読取（fail-open）
 *   - .claude/harness.config.json の読込 + schemaVersion 検証
 *   - コマンド実行（タイムアウト・エラー抜粋つき）
 *   - パス正規化（Windows の `\` を `/` へ）
 *   - hook 出力の JSON 整形
 *
 * 設計原則（04_harness設定契約_仕様 §4）:
 *   - config 不在・パース失敗・ツール不在は「素通り」。作業を止めない
 *   - schemaVersion が core の想定より新しい場合も素通り（古い core が新しい config を壊さない）
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/** core が理解できる契約バージョン */
const SCHEMA_VERSION = 1;

const CONFIG_RELATIVE_PATH = path.join(".claude", "harness.config.json");

/**
 * プロジェクトルート。Claude Code は CLAUDE_PROJECT_DIR を渡すが、
 * 単体テストや手動実行では未設定なので cwd にフォールバックする。
 */
function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/** stdin の JSON を読む。読めない・壊れている場合は null（呼び出し側は素通りする） */
function readPayload() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf-8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

/** PreToolUse / PostToolUse の payload から実行コマンド文字列を取り出す */
function toolCommand(payload) {
  return payload?.tool_input?.command || "";
}

/** `git commit` を含むコマンドか（matcher が Bash|PowerShell 全体に効くため各スクリプトで判定する） */
function isGitCommit(command) {
  return /\bgit\s+commit\b/.test(command || "");
}

/** Windows のパス区切りを `/` に正規化する（docTriggers の正規表現は `/` 前提） */
function toPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

/**
 * harness.config.json を読む。
 *
 * @returns {{status: "ok"|"missing"|"invalid"|"newer", config: object|null, file: string, message: string}}
 */
function loadConfig() {
  const file = path.join(projectDir(), CONFIG_RELATIVE_PATH);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return {
      status: "missing",
      config: null,
      file,
      message: `${toPosix(CONFIG_RELATIVE_PATH)} が見つかりません。harness-core の hooks / skills は設定不在として素通りします。`,
    };
  }

  let config;
  try {
    config = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (e) {
    return {
      status: "invalid",
      config: null,
      file,
      message: `${toPosix(CONFIG_RELATIVE_PATH)} の JSON が壊れています（${e.message}）。`,
    };
  }

  const version = config?.schemaVersion;
  if (typeof version !== "number") {
    return {
      status: "invalid",
      config,
      file,
      message: `${toPosix(CONFIG_RELATIVE_PATH)} に schemaVersion がありません。`,
    };
  }
  if (version > SCHEMA_VERSION) {
    return {
      status: "newer",
      config,
      file,
      message: `${toPosix(CONFIG_RELATIVE_PATH)} の schemaVersion=${version} は harness-core の対応版 ${SCHEMA_VERSION} より新しいため、この hook は素通りします。harness-core を更新してください。`,
    };
  }

  return { status: "ok", config, file, message: "" };
}

/** config から commands.<key> を取り出す。未定義・null・空文字は null を返す */
function commandFor(config, key) {
  const value = config?.commands?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** git コマンドを実行し、失敗しても例外にしない（情報取得目的のみに使う） */
function git(args, timeout = 5000) {
  try {
    return execSync(`git ${args}`, {
      cwd: projectDir(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * 任意のコマンドを実行する。
 * @returns {{ok: boolean, output: string}} output は stdout+stderr の結合
 */
function run(command, timeout = 170000) {
  try {
    const stdout = execSync(command, {
      cwd: projectDir(),
      encoding: "utf-8",
      timeout,
      stdio: "pipe",
    });
    return { ok: true, output: (stdout || "").trim() };
  } catch (e) {
    const output = ((e.stdout || "") + "\n" + (e.stderr || "") + "\n" + (e.message || "")).trim();
    return { ok: false, output };
  }
}

/**
 * 失敗出力から人間が読むべき行を抜粋する。
 * エラー行を優先し、無ければ末尾（多くのツールは末尾に要約を出す）から取る。
 */
function errorExcerpt(output, maxLines = 20) {
  // stdout / stderr / e.message には同じ行が重複して現れることが多いので一意化する
  const lines = [
    ...new Set(
      String(output || "")
        .split(/\r?\n/)
        .map((l) => l.trimEnd())
        .filter((l) => l.trim())
    ),
  ];
  if (!lines.length) return "(出力なし)";
  const errorLines = lines.filter((l) => /error|failed|失敗|エラー|✖|✗/i.test(l));
  const picked = errorLines.length ? errorLines : lines.slice(-maxLines);
  return picked.slice(0, maxLines).join("\n");
}

/** hook の JSON 出力（1回だけ呼ぶ） */
function emit(payload) {
  console.log(JSON.stringify(payload));
}

/** 素通り（何も出力しない） */
function passThrough() {
  process.exit(0);
}

module.exports = {
  SCHEMA_VERSION,
  CONFIG_RELATIVE_PATH,
  projectDir,
  readPayload,
  toolCommand,
  isGitCommit,
  toPosix,
  loadConfig,
  commandFor,
  git,
  run,
  errorExcerpt,
  emit,
  passThrough,
};
