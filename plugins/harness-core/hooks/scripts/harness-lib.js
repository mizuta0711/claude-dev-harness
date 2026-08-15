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

/**
 * PreToolUse hook 全体の時間予算（ミリ秒）。
 *
 * タイムアウトした PreToolUse hook は「ブロックせず続行」する仕様のため、
 * hook 自体がタイムアウトするとゲートが静かに無効化される。
 * hooks.json の timeout（600 秒）から起動・出力のマージンを引いた値を予算とし、
 * 複数コマンドを実行する場合はこの予算内に収める。
 */
const TOTAL_BUDGET_MS = 570000;

/** 1コマンドあたりの上限（予算が潤沢でも1コマンドで使い切らせない） */
const MAX_COMMAND_MS = 170000;

const CONFIG_RELATIVE_PATH = path.join(".claude", "harness.config.json");

/**
 * コミット直前の HEAD を記録する場所。
 *
 * PreToolUse（pre-commit-check）が書き、PostToolUse（post-commit-doc-check）が読んで消す。
 * 「この `git commit` で実際にコミットが作られたか」を HEAD の変化で判定するために使う。
 * プロジェクト側では `.claude/.pre-commit-head` を .gitignore 対象にしてよい（無くても動く）。
 */
const HEAD_MARKER_RELATIVE_PATH = path.join(".claude", ".pre-commit-head");

/**
 * サブエージェントが動いたことを記録する場所。
 *
 * SubagentStop（`subagent-stop-diff`）が書き、PreToolUse（`pre-commit-check`）が
 * コミット時に読んで消す。
 *
 * **なぜファイル経由なのか**: SubagentStop には通知経路が無いことが実測で分かったため
 * （`systemMessage` は画面に出ず、`additionalContext` は親に届かないうえサブエージェントを
 * ループさせる）。**届くイベントまで情報を持ち越す**しかない。
 * コミットは `pre-commit-check` が確実に捕まえるので、そこで合流させる。
 */
const SUBAGENT_MARKER_RELATIVE_PATH = path.join(".claude", ".subagent-touch.json");

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

/**
 * `git commit` を含むコマンドか（matcher が Bash|PowerShell 全体に効くため各スクリプトで判定する）。
 *
 * `git` と `commit` の間にはグローバルオプションが挟まりうる（`git -C dir commit`、
 * `git -c user.name=x commit`、`git --no-pager commit`）。
 * **見逃し（ゲート素通り）は不可・誤検知（余計にチェックが走るだけ）は許容**の方針で広めに取る。
 */
function isGitCommit(command) {
  return /\bgit\b(?:\s+(?:-[cC]\s*\S+|--\S+))*\s+commit\b/.test(command || "");
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

/**
 * commands.<key> を「キー不在」と「値が null」を区別して解決する。
 *
 * - `missing`: commands にキー自体が無い → config の書き間違い（typo）の可能性が高い。警告する
 * - `null`   : キーはあるが値が null → この環境には無い（意図的）。黙ってスキップする
 * - `ok`     : 実行可能なコマンド文字列
 *
 * @returns {{status: "ok"|"null"|"missing", key: string, command: string|null}}
 */
function resolveCommand(config, key) {
  const commands = config?.commands;
  const exists = commands && Object.prototype.hasOwnProperty.call(commands, key);
  if (!exists) return { status: "missing", key, command: null };
  const command = commandFor(config, key);
  return command ? { status: "ok", key, command } : { status: "null", key, command: null };
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
 *
 * @param {string} command
 * @param {number} timeout ミリ秒
 * @returns {{ok: boolean, output: string, timedOut: boolean, elapsedMs: number, timeout: number}}
 *   output は stdout+stderr+例外メッセージの結合。timedOut は timeout 超過で殺された場合に true
 */
function run(command, timeout = MAX_COMMAND_MS) {
  const startedAt = Date.now();
  try {
    const stdout = execSync(command, {
      cwd: projectDir(),
      encoding: "utf-8",
      timeout,
      stdio: "pipe",
    });
    return {
      ok: true,
      output: (stdout || "").trim(),
      timedOut: false,
      elapsedMs: Date.now() - startedAt,
      timeout,
    };
  } catch (e) {
    const output = ((e.stdout || "") + "\n" + (e.stderr || "") + "\n" + (e.message || "")).trim();
    // execSync は timeout 超過時にシグナルでプロセスを殺す
    const timedOut = Boolean(e.killed) || e.code === "ETIMEDOUT" || Boolean(e.signal);
    return { ok: false, output, timedOut, elapsedMs: Date.now() - startedAt, timeout };
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

/** 現在の HEAD（コミットが1つも無ければ空文字） */
function headCommit() {
  return git("rev-parse HEAD", 3000);
}

/** コミット直前の HEAD を記録する（失敗しても無視する — 記録が無ければ後段は fail-open で動く） */
function writeHeadMarker() {
  try {
    fs.writeFileSync(
      path.join(projectDir(), HEAD_MARKER_RELATIVE_PATH),
      headCommit() || "(none)"
    );
  } catch {
    /* .claude/ が無い等。判定は reflog にフォールバックする */
  }
}

/**
 * 記録した HEAD を読んで消す。
 * @returns {string|null} 記録が無ければ null
 */
function consumeHeadMarker() {
  const file = path.join(projectDir(), HEAD_MARKER_RELATIVE_PATH);
  let value = null;
  try {
    value = fs.readFileSync(file, "utf-8").trim();
  } catch {
    return null;
  }
  try {
    fs.unlinkSync(file);
  } catch {
    /* 消せなくても判定には影響しない */
  }
  return value || null;
}

/**
 * サブエージェントが動いたことを記録する（追記式）。
 *
 * 同じコミットまでに複数のサブエージェントが動くのが普通なので、**上書きせず足す**。
 * 記録は「どのエージェントが」「何ファイル触った時点で終わったか」だけ。
 * 差分そのものは記録しない（コミット時点で `git status` を見れば足りる）。
 */
function writeSubagentMarker(entry) {
  const file = path.join(projectDir(), SUBAGENT_MARKER_RELATIVE_PATH);
  let list = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    /* 無い・壊れている → 新規で作る */
  }
  list.push(entry);
  // 際限なく増やさない（同一コミット内で何十回も回ることは想定しない）
  if (list.length > 20) list = list.slice(-20);
  try {
    fs.writeFileSync(file, JSON.stringify(list));
  } catch {
    /* .claude/ が無い等。記録できなくても作業は止めない（fail-open） */
  }
}

/**
 * サブエージェントの記録を読んで消す。
 * @returns {Array<{agent: string, files: number}>} 記録が無ければ空配列
 */
function consumeSubagentMarker() {
  const file = path.join(projectDir(), SUBAGENT_MARKER_RELATIVE_PATH);
  let list = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    return [];
  }
  try {
    fs.unlinkSync(file);
  } catch {
    /* 消せなくても判定には影響しない */
  }
  return list;
}

/** hook の JSON 出力（1回だけ呼ぶ） */
function emit(payload) {
  console.log(JSON.stringify(payload));
}

/**
 * 通知を**2経路とも**出す（#23 / 2026-08-15 の実測に基づく）。
 *
 * | 経路 | 届く先 |
 * |------|--------|
 * | `systemMessage` | **ユーザーの画面** |
 * | `hookSpecificOutput.additionalContext` | **Claude の文脈** |
 *
 * 片方だけでは必ず片側に届かない。**同時に出せば両方に届く**ことを実測で確認した
 * （SessionStart / PreToolUse / PostToolUse の Bash・Write・Task で確認）。
 *
 * > 経緯: D5（`b22c887`）は「`systemMessage` は PostToolUse では画面に出ない」と判断して
 * > `additionalContext` へ**移した**が、これは誤りだった（同じ Claude Code v2.1.232 で出る）。
 * > 移したことで今度はユーザーの画面から消えていた（#23）。**どちらか一方に賭けない。**
 *
 * ⚠️ **SubagentStop では使わないこと。** `additionalContext` を返すと
 * サブエージェントの停止がキャンセルされ、ループする（実測: 8回・42秒・23.7k トークン）。
 * しかも親の文脈には届かない。SubagentStop に通知経路は無い（`subagent-stop-diff.js` を参照）。
 *
 * @param {string} hookEventName 実在するイベント名（"PreToolUse" / "PostToolUse" 等）
 * @param {string} message 本文
 * @param {object} [extra] 併せて出す追加フィールド（`continue` 等）
 */
function notify(hookEventName, message, extra = {}) {
  emit({
    ...extra,
    systemMessage: message,
    hookSpecificOutput: {
      ...(extra.hookSpecificOutput || {}),
      hookEventName,
      additionalContext: message,
    },
  });
}

/** 素通り（何も出力しない） */
function passThrough() {
  process.exit(0);
}

module.exports = {
  SCHEMA_VERSION,
  TOTAL_BUDGET_MS,
  MAX_COMMAND_MS,
  CONFIG_RELATIVE_PATH,
  HEAD_MARKER_RELATIVE_PATH,
  SUBAGENT_MARKER_RELATIVE_PATH,
  headCommit,
  writeHeadMarker,
  consumeHeadMarker,
  writeSubagentMarker,
  consumeSubagentMarker,
  projectDir,
  readPayload,
  toolCommand,
  isGitCommit,
  toPosix,
  loadConfig,
  commandFor,
  resolveCommand,
  git,
  run,
  errorExcerpt,
  emit,
  notify,
  passThrough,
};
