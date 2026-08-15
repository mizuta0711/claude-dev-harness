/**
 * harness-nextjs プラグイン内共通ヘルパ
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

/** config から commands.<key> を取り出す。未定義・null・空文字は null */
function commandFor(config, key) {
  const value = config?.commands?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
  toPosix,
  loadConfig,
  commandFor,
  emit,
  notify,
};
