/**
 * harness-android プラグイン内共通ヘルパ
 *
 * **core の harness-lib.js を require しない**（Phase 2 指示書 §0-8）。
 * `${CLAUDE_PLUGIN_ROOT}` はプラグインごとに異なり、プラグイン間のファイル参照は
 * 保証されないため、必要な最小ヘルパを各プラグインが自前で持つ。
 * 規約（fail-open・stdin 自前判定・CommonJS）は core と同一に揃えてある。
 *
 * core / harness-unity の同名ファイルと重複するのは意図的。
 * ただし**ここには使うものだけを置く**（このプラグインは git 操作を見ないので
 * `git()` と `isGitCommit()` は持たない）。
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
 * ⚠️ **SubagentStop では使わないこと**（停止がキャンセルされてループする）。
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

/** PreToolUse をブロックする（理由は画面と Claude の文脈の両方へ出す） */
function deny(label, reason) {
  emit({
    systemMessage: `[android-guard] ❌ ${label}`,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

/**
 * SEPARATORS: コマンドの切れ目になる文字。
 * `&` `|` は `&&` `||` の片割れとしても現れるが、いずれにせよ切れ目なので1文字で扱う。
 */
const SEPARATORS = new Set([";", "&", "|", "\n", "(", "`"]);

/**
 * コマンド文字列を走査し、**コマンドが始まる位置の断片**だけを返す（R3 の教訓）。
 *
 * 素の正規表現で判定すると、**引用符やコメントの中に文字列があるだけで反応する**。
 * 「アンインストールしてはいけない」と説明する文や、コミットメッセージの本文に
 * `adb uninstall` と書いただけでブロックされると、**安全弁の方が先に外される**。
 *
 * `.claude/hooks/repo-guard.js` の同名関数と同じ考え方で実装している
 * （あちらはハーネス開発用、こちらは配布物。参照関係は持たせない）。
 *
 * @param {string} cmd
 * @returns {{index:number, text:string}[]}
 */
function scanCommands(cmd) {
  const s = String(cmd || "");
  const out = [];
  let start = 0;
  let quote = null;

  const flush = (end) => {
    const raw = s.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) out.push({ index: start + lead, text });
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      // シングルクォートの中ではエスケープは効かない
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    // ヒアドキュメントの本文は**データであってコマンドではない**
    if (c === "<" && s[i + 1] === "<") {
      const m = /^<<-?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w]*))/.exec(s.slice(i));
      if (m) {
        const delim = m[1] || m[2] || m[3];
        const bodyStart = s.indexOf("\n", i + m[0].length);
        if (bodyStart < 0) {
          flush(s.length);
          return out;
        }
        const lines = s.slice(bodyStart + 1).split("\n");
        let consumed = 0;
        let found = false;
        for (const line of lines) {
          consumed += line.length + 1;
          if (line.trim() === delim) {
            found = true;
            break;
          }
        }
        flush(i);
        start = bodyStart + 1 + (found ? consumed : s.length);
        i = start - 1;
        continue;
      }
    }
    if (c === "#") {
      // 行コメント。行末までは読まない
      flush(i);
      const nl = s.indexOf("\n", i);
      if (nl < 0) return out;
      i = nl;
      start = i + 1;
      continue;
    }
    if (SEPARATORS.has(c)) {
      flush(i);
      start = i + 1;
    }
  }
  flush(s.length);
  return out;
}

module.exports = {
  SCHEMA_VERSION,
  CONFIG_RELATIVE_PATH,
  projectDir,
  readPayload,
  loadConfig,
  emit,
  notify,
  deny,
  scanCommands,
};
