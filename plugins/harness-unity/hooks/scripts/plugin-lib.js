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
/** `<<` の手前にあるコマンド名（パスと拡張子を落とす）。分からなければ null */
/**
 * **本文を潰してよい形**を、許可リストで決める。
 *
 * ## なぜ禁止リストをやめたか
 *
 * 0.34.0〜0.34.2 は「実行系を見つけたら潰さない」という**禁止リスト**だった。
 * **3回続けて前提が崩れ、そのたびに見逃しを作った。**
 *
 * | 版 | 前提 | 崩れた形 |
 * |---|---|---|
 * | 0.34.0 | 本文は実行されない | `bash <<EOF`（シェルが本文を実行する） |
 * | 0.34.1 | 受け取るのが `cat` ならデータ | `cat <<EOF \| bash`（`cat` は流すだけ） |
 * | 0.34.2 | 導入部の行に実行系の名前が無ければデータ | `cat <<EOF \| $SHELL` / `\| . /dev/stdin` / 関数 / 別の行で定義 |
 *
 * **禁止リストは収束しない。** 名前を足すたびに、別名・変数・関数・別の行で抜ける
 * （査読が13形を実測し、**うち5形は実際に本文が実行されることまで確かめた**）。
 *
 * ## 許可リストに反転した
 *
 * **「確実に安全な形のときだけ潰す」。** 安全な形は**有限**である。
 *
 *   ① 本文を受け取るのが `cat` / `tee` / `git` で、
 *   ② 導入部に**コマンドの区切りも置換も無く**（`|` `;` `&` `` ` `` `$(` `>(` `>&`）、
 *   ③ `<<DELIM` の**後ろもリダイレクトかコメントだけ**
 *
 * **どれか外れたら潰さない＝許容されている誤検知**に倒れる。
 * 不確かなものは全部そちらへ落ちるので、**見逃しを新しく作らない**。
 *
 * **`git` を許すのは** `git commit -F - -- a.md <<EOF` と
 * Claude Code 標準の `git commit -m "$(cat <<'EOF' … )"` のため
 * （git は本文をコマンドとして実行しない）。
 */
const HEREDOC_DATA_SINKS = new Set(["cat", "tee", "git"]);

/**
 * 前置き。**飛ばしても安全である** —— 飛ばした先が `cat` なら潰し（正しい）、
 * `bash` なら許可リストから外れて潰さない（正しい）。
 */
const SINK_PREFIXES = new Set(["sudo", "env", "command", "nohup", "time", "xargs"]);

/** コマンドの区切りと置換。**導入部にこれがあれば潰さない** */
const UNSAFE_IN_INTRODUCER = /[|;&`]|\$\(|>\(|>&/;

/**
 * `<<` の導入部が「安全な形」かを判定する。
 *
 * @param s コマンド全体
 * @param at `<<` の位置
 * @param afterDelim `<<DELIM` トークンの直後の位置
 */
function isSafeHeredocIntroducer(s, at, afterDelim) {
  // 手前: 直近の区切り（改行・`;`・`|`・`&`・`(`・バッククォート）から `<<` まで
  let start = 0;
  for (let k = at - 1; k >= 0; k--) {
    const c = s[k];
    if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === "`") {
      // **プロセス置換（`<(` / `>(`）はコマンド置換（`$(`）と違う。**
      // `source <(cat <<EOF … )` は**本文を `source` が実行する**ので潰してはいけない
      // （`$(cat <<EOF … )` は値になるだけなので潰してよい）。
      if (c === "(" && (s[k - 1] === "<" || s[k - 1] === ">")) return false;
      start = k + 1;
      break;
    }
  }
  const before = s.slice(start, at);
  if (UNSAFE_IN_INTRODUCER.test(before)) return false;

  // 後ろ: `<<DELIM` から行末まで。リダイレクトとコメントだけなら安全
  let to = s.indexOf("\n", afterDelim);
  if (to < 0) to = s.length;
  const after = s.slice(afterDelim, to);
  if (!/^\s*(?:>>?\s*[^\s|;&`$(>]+\s*)*(?:#.*)?$/.test(after)) return false;

  // 手前の語を順に見て、前置きを飛ばし、最初の実コマンドが許可リストにあるか
  for (const raw of before.split(/\s+/)) {
    const token = raw.replace(/^[\s(]+/, "");
    if (!token) continue;
    if (/^[A-Za-z_][\w]*=/.test(token)) continue; // 環境変数の代入
    const base = token.split("/").pop().split(String.fromCharCode(92)).pop();
    const name = base.replace(/\.(exe|cmd|bat)$/i, "");
    if (!name) continue;
    if (SINK_PREFIXES.has(name)) continue;
    return HEREDOC_DATA_SINKS.has(name);
  }
  return false;
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
    // **安全な形のときだけ潰す**（許可リスト。理由は `isSafeHeredocIntroducer`）
    if (!isSafeHeredocIntroducer(s, i, i + m[0].length)) continue;

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
