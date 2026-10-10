/**
 * harness-unity プラグイン内共通ヘルパ
 *
 * **core の harness-lib.js を require しない**（Phase 2 指示書 §0-8）。
 * `${CLAUDE_PLUGIN_ROOT}` はプラグインごとに異なり、プラグイン間のファイル参照は
 * 保証されないため、必要な最小ヘルパを各プラグインが自前で持つ。
 * 規約（fail-open・stdin 自前判定・CommonJS）は core と同一に揃えてある。
 *
 * core の harness-lib.js と重複するのは意図的。
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/** このプラグインが理解できる契約バージョン（core と揃える） */
const SCHEMA_VERSION = 1;

const CONFIG_RELATIVE_PATH = path.join(".claude", "harness.config.json");

/** プロジェクトルート。Claude Code は CLAUDE_PROJECT_DIR を渡す。未設定なら cwd */
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

/**
 * `git commit` を含むコマンドか。
 *
 * `git` と `commit` の間にはグローバルオプションが挟まりうる（`git -C dir commit`、
 * `git -c user.name=x commit`、`git --no-pager commit`）。
 * **見逃し（ゲート素通り）は不可・誤検知（余計にチェックが走るだけ）は許容**の方針で広めに取る。
 * core の harness-lib.isGitCommit と同一実装。
 */
/**
 * ヒアドキュメントの**本文**を空白へ潰す（長さは保つ）。
 *
 * **なぜ必要か**（H65）。`isGitCommit` は素朴な文字列一致で、
 * **本文に書かれた `git commit` を実際のコミットと取り違える**。
 * 方針は「**見逃しは不可・誤検知は許容**」だが、
 * **「誤検知は余計にチェックが走るだけ」という前提が成り立っていなかった** ——
 *
 * > 実測: `commands.typecheck` が失敗する状態で
 * > `cat > docs/x.md <<'EOF' … git commit -- path を使う … EOF` を実行すると、
 * > **文書を書くだけの操作が deny され**、「修正してから再度**コミット**してください」と出た。
 *
 * **引用符は潰さない。** `bash -c "git commit -- a.md"` のように
 * **引用符の中に本物のコミットが来る形があり、潰すと見逃す**（実測で確認）。
 * **ヒアドキュメントの本文は実行されないので、潰しても見逃しは生じない。**
 *
 * `git-scope.js` の `maskHereBodies` と同じ役目だが、**あちらはコマンドの走査用で、
 * 本体が大きく、配布単位も別**（unity の `plugin-lib.js` からは参照できない）。
 * ここは**この判定に必要な最小限**にとどめてある。
 */
function stripHeredocBodies(command) {
  const s = String(command || "");
  const out = s.split("");
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "<" || s[i + 1] !== "<") continue;
    const m = /^<<(-?)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w]*))/.exec(s.slice(i));
    if (!m) continue;
    const delim = m[2] || m[3] || m[4];
    const stripTabs = m[1] === "-";
    const bodyStart = s.indexOf("\n", i + m[0].length);
    if (bodyStart < 0) break;
    let pos = bodyStart + 1;
    let end = s.length;
    while (pos <= s.length) {
      let nl = s.indexOf("\n", pos);
      const last = nl < 0;
      if (last) nl = s.length;
      let line = s.slice(pos, nl).replace(/\r$/, "");
      if (stripTabs) line = line.replace(/^\t+/, "");
      if (line === delim) {
        end = last ? s.length : nl + 1;
        break;
      }
      if (last) break;
      pos = nl + 1;
    }
    for (let k = i; k < end && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
    i = end - 1;
  }
  return out.join("");
}

function isGitCommit(command) {
  return /\bgit\b(?:\s+(?:-[cC]\s*\S+|--\S+))*\s+commit\b/.test(
    stripHeredocBodies(command)
  );
}

/** Windows のパス区切りを `/` に正規化する */
function toPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

/**
 * harness.config.json を読む。
 * 不在・壊れている・core より新しい場合は config を返さない（呼び出し側は素通りする）。
 *
 * @returns {{status: "ok"|"missing"|"invalid"|"newer", config: object|null}}
 */
function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(projectDir(), CONFIG_RELATIVE_PATH), "utf-8");
  } catch {
    return { status: "missing", config: null };
  }
  let config;
  try {
    config = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return { status: "invalid", config: null };
  }
  const version = config?.schemaVersion;
  if (typeof version !== "number") return { status: "invalid", config };
  if (version > SCHEMA_VERSION) return { status: "newer", config };
  return { status: "ok", config };
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
 * 片方だけでは必ず片側に届かない。**同時に出せば両方に届く**ことを実測で確認した。
 * core の `harness-lib.js` に同じものがあるが、プラグイン間参照は保証されないため
 * ここにも持つ（重複は意図的）。
 *
 * ⚠️ **SubagentStop では使わないこと。** `additionalContext` を返すと
 * サブエージェントの停止がキャンセルされてループする（実測: 8回・42秒・23.7k トークン）。
 *
 * @param {string} hookEventName 実在するイベント名
 * @param {string} message 本文
 * @param {object} [extra] 併せて出す追加フィールド
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

module.exports = {
  SCHEMA_VERSION,
  CONFIG_RELATIVE_PATH,
  projectDir,
  readPayload,
  stripHeredocBodies,
  isGitCommit,
  toPosix,
  loadConfig,
  git,
  emit,
  notify,
};
