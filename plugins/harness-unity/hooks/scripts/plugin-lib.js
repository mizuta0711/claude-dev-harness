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
 * ヒアドキュメントの**本文だけ**を空白へ潰す（長さは保つ）。
 *
 * **なぜ必要か**（H65）。`isGitCommit` は素朴な文字列一致で、
 * **本文に書かれた `git commit` を実際のコミットと取り違える**。
 * 方針は「**見逃しは不可・誤検知は許容**」だが、
 * **「誤検知は余計にチェックが走るだけ」という前提が成り立っていなかった** ——
 *
 * > 実測: `commands.typecheck` が失敗する状態で、本文に `git commit` を含む文書を
 * > `cat > docs/x.md <<'EOF' … EOF` で書くと、**文書を書くだけの操作が deny され**、
 * > 「修正してから再度**コミット**してください」と出た。
 *
 * **引用符は潰さない。** `bash -c "git commit -- a.md"` のように
 * **引用符の中に本物のコミットが来る形がある**（潰すと見逃す）。
 *
 * ## 潰す条件を厳しくしてある（**初版は見逃しを6件作った**）
 *
 * **初版は「ヒアドキュメントの本文は実行されない」という前提で潰した。その前提が誤りだった。**
 *
 * | 初版で見逃した形 | なぜ |
 * |---|---|
 * | `cat <<EOF | git commit -F -` | **導入部の行ごと潰していた**ので `| git commit` が消えた |
 * | `bash <<EOF` / `ssh h <<EOF` | **シェルへ渡す本文は実行される** |
 * | `echo $((1 << N))` | **シフト演算**をヒアドキュメントと誤認した |
 * | `grep x <<<abc` | **ヒアストリング**を `<<abc` と読み、終端が無いので後続を全部潰した |
 *
 * そこで次の3つにした。
 *
 * 1. **潰すのは本文の行だけ**（導入部の行は残す）
 * 2. **`<<<`（ヒアストリング）は対象外**
 * 3. **本文を受け取るコマンドが `cat` / `tee` のときだけ潰す。**
 *    **許可リストにしてあるのは、知らないコマンドを「潰さない」側へ倒すため** ——
 *    潰さない側の失敗は**許容されている誤検知**で、潰す側の失敗は**禁じられている見逃し**である。
 *    `bash` / `sh` / `ssh` / 算術 / ヒアストリングは、これで自動的に外れる
 *
 * `git-scope.js` の `maskHereBodies` と役目は近いが、**あちらはコマンドの走査用で
 * 導入部も潰し、配布単位も別**（unity の `plugin-lib.js` からは参照できない）。
 */
// **`git` も入れる** —— `git commit -F - <<EOF` は本文を**コミットメッセージとして読む**。
// git は本文をコマンドとして実行しないので、潰しても見逃しにならない。
const HEREDOC_DATA_SINKS = new Set(["cat", "tee", "git"]);

/** `<<` の手前にあるコマンド名（パスと拡張子を落とす）。分からなければ null */
function heredocSink(s, at) {
  let start = 0;
  for (let k = at - 1; k >= 0; k--) {
    const c = s[k];
    // **`(` も境界にする。** `$(cat <<EOF` で手前まで遡ると最初の語が
    // `git` になり、**本文を受け取るのが `cat` だと分からない**（実測で H50 の回帰を招いた）。
    if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(") {
      start = k + 1;
      break;
    }
  }
  const head = s.slice(start, at);
  const m = /^[\s(]*([A-Za-z0-9_./\\-]+)/.exec(head);
  if (!m) return null;
  const name = m[1].split(/[/\\]/).pop().replace(/\.(exe|cmd|bat)$/i, "");
  return name || null;
}

function stripHeredocBodies(command) {
  const s = String(command || "");
  const out = s.split("");
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "<" || s[i + 1] !== "<") continue;
    // ヒアストリング（`<<<`）は本文を持たない
    if (s[i + 2] === "<") {
      i += 2;
      continue;
    }
    const m = /^<<(-?)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w]*))/.exec(s.slice(i));
    if (!m) continue;
    // **本文を受け取るコマンドを見る。** 知らないコマンドは潰さない（見逃しを作らないため）
    const sink = heredocSink(s, i);
    if (!sink || !HEREDOC_DATA_SINKS.has(sink)) continue;

    const delim = m[2] || m[3] || m[4];
    const stripTabs = m[1] === "-";
    const bodyStart = s.indexOf("\n", i + m[0].length);
    if (bodyStart < 0) break;

    let pos = bodyStart + 1;
    let bodyEnd = s.length;
    while (pos <= s.length) {
      let nl = s.indexOf("\n", pos);
      const last = nl < 0;
      if (last) nl = s.length;
      let line = s.slice(pos, nl).replace(/\r$/, "");
      if (stripTabs) line = line.replace(/^\t+/, "");
      if (line === delim) {
        bodyEnd = last ? s.length : nl + 1;
        break;
      }
      if (last) break;
      pos = nl + 1;
    }

    // **導入部の行は潰さない**（`cat <<EOF | git commit -F -` の後半が消える）
    for (let k = bodyStart + 1; k < bodyEnd && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
    i = bodyEnd - 1;
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
