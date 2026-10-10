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
 * 0.34.0〜0.34.2 は「実行系を見つけたら潰さない」という**禁止リスト**で、
 * **3回続けて前提が崩れた**（`bash <<EOF` → `cat <<EOF | bash` →
 * `| $SHELL` / `| . /dev/stdin` / 関数 / 別の行で定義）。
 * **名前を並べる方式は収束しない** —— 別名・変数・関数・別の行で抜ける。
 *
 * ## 許可リストは2つの軸で閉じる
 *
 * **0.35.0 は「導入部の行」だけを見ており、その行を包む外側を見ていなかった**
 * （査読で2形の見逃しを実測された）。
 *
 *   ① **導入部の行の中**: sink が `cat` / `tee` / `git` / `gh` で、区切りも置換も無く、
 *      後ろもリダイレクトかコメントだけ
 *   ② **行を包む外側**: サブシェル `(…)` の中ではなく、`$(…)` の中なら
 *      **外側が `git` のメッセージ引数**のときだけ
 *
 * **どちらかでも外れたら潰さない＝許容されている誤検知**に倒れる。
 * **不確かなものは全部そちらへ落ちるので、見逃しを新しく作らない。**
 */
const HEREDOC_DATA_SINKS = new Set(["cat", "tee", "git", "gh"]);

/**
 * 前置き。**飛ばしても安全である** —— 飛ばした先が `cat` なら潰し（正しい）、
 * `bash` なら許可リストから外れて潰さない（正しい）。
 */
const SINK_PREFIXES = new Set(["sudo", "env", "command", "nohup", "time", "xargs"]);

/**
 * `git` で本文を潰してよいサブコマンド。**本文をメッセージとして読むものだけ。**
 *
 * **`git` を丸ごと許すと広すぎた**（査読の中1。実行確認つき）——
 * `git -c alias.x='!bash' x <<EOF` は**本文を bash が実行する**。
 * `git bisect run sh <<EOF` / `git submodule foreach bash <<EOF` も同型。
 */
/**
 * `git` のグローバルオプションのうち、**次のトークンを値として取る**もの。
 * `parseGit` の `GIT_GLOBAL_VALUE_OPTS` と同じ役目だが、**あちらはこの位置より後ろで定義される**
 * ため別に持つ（内容が食い違ったら `tests/git-scope.test.mjs` が落ちる）。
 */
const GIT_VALUE_OPTS = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]);

/**
 * `gh` で本文を潰してよいサブコマンド。**`git` と同じく絞る。**
 *
 * **`gh` だけ制限が無いのは非対称だった**（査読の低5）——
 * `gh alias set x '!bash'; gh x <<EOF` のように**別名を定義してから実行する形**がある。
 */
const GH_DATA_SUBCOMMANDS = new Set(["pr", "issue", "release", "gist", "api"]);

/** `gh …` が本文をデータとして読む形か */
function isGhDataForm(text) {
  const tokens = String(text)
    .split(/\s+/)
    .map((t) => t.replace(/^[\s(]+/, ""))
    .filter(Boolean)
    .filter((t) => !/^[A-Za-z_][\w]*=/.test(t));
  if (firstCommandName(text) !== "gh") return false;
  const gi = tokens.findIndex((t) => t.split("/").pop().replace(/\.(exe|cmd|bat)$/i, "") === "gh");
  if (gi < 0) return false;
  for (let k = gi + 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.startsWith("-")) continue;
    return GH_DATA_SUBCOMMANDS.has(t);
  }
  return false;
}

const GIT_MESSAGE_SUBCOMMANDS = new Set(["commit", "tag", "notes", "merge", "revert", "cherry-pick"]);

/** コマンドの区切りと置換。**導入部にこれがあれば潰さない** */
const UNSAFE_IN_INTRODUCER = /[|;&`]|\$\(|>\(|>&/;

/** 文字列の先頭から、前置きを飛ばした最初の実コマンド名。無ければ null */
function firstCommandName(text) {
  for (const raw of String(text).split(/\s+/)) {
    const token = raw.replace(/^[\s(]+/, "");
    if (!token) continue;
    if (/^[A-Za-z_][\w]*=/.test(token)) continue; // 環境変数の代入
    const base = token.split("/").pop().split(String.fromCharCode(92)).pop();
    const name = base.replace(/\.(exe|cmd|bat)$/i, "");
    if (!name) continue;
    if (SINK_PREFIXES.has(name)) continue;
    return name;
  }
  return null;
}

/** `git …` が本文をメッセージとして読む形か（`-c` は認めない） */
function isGitMessageForm(text) {
  const tokens = String(text)
    .split(/\s+/)
    .map((t) => t.replace(/^[\s(]+/, ""))
    .filter(Boolean)
    .filter((t) => !/^[A-Za-z_][\w]*=/.test(t));
  // **`git` は前置きを飛ばした「最初の」コマンドでなければならない。**
  // どこかに `git` があれば通していたため、`eval git commit -m "$(cat <<EOF … )"` と
  // `echo git commit -m "$(…)" | bash` が素通りした（査読の高2・実行確認つき）。
  if (firstCommandName(text) !== "git") return false;
  const gi = tokens.findIndex((t) => {
    const base = t.split("/").pop().split(String.fromCharCode(92)).pop();
    return base.replace(/\.(exe|cmd|bat)$/i, "") === "git";
  });
  if (gi < 0) return false;
  for (let k = gi + 1; k < tokens.length; k++) {
    const t = tokens[k];
    // **`-c` を認めない。** `git -c alias.x='!bash' x <<EOF` は本文が実行される
    if (t === "-c" || t.startsWith("-c") || t === "--exec-path" || t.startsWith("--exec-path")) return false;
    // **グローバルオプションの「値」をサブコマンドと取り違えない。**
    // `git -C commit bisect run sh <<EOF` の `commit` は `-C` の値である（査読の中3）。
    if (GIT_VALUE_OPTS.has(t)) {
      k++;
      continue;
    }
    if (t.startsWith("-")) continue;
    return GIT_MESSAGE_SUBCOMMANDS.has(t);
  }
  return false;
}

/**
 * `at` の位置が、閉じていない**素のグループ**（`(` / `{`）の中にあるか。
 *
 * **1行だけ遡る方式では足りなかった**（査読の高1の残り）——
 * `{` が**別の行**にあると境界が改行になり、グループの中だと分からない。
 *
 * ```
 * {
 * cat <<EOF
 * git add -A
 * EOF
 * }|bash        ← **閉じ括弧の後ろで実行される**
 * ```
 *
 * **`$(` と `${` は数えない。** あれは値になるだけで、
 * 外側が `git` のメッセージ引数なら潰してよい（標準のコミット形）。
 * 値が実行される形は `isSafeHeredocIntroducer` の `$(` の分岐で別に見る。
 */
function inOpenGroup(s, at) {
  let depth = 0;
  let sq = false;
  for (let i = 0; i < at; i++) {
    const c = s[i];
    if (c === "'") {
      sq = !sq;
      continue;
    }
    if (sq) continue;
    if (c === "(" || c === "{") {
      if (s[i - 1] === "$") continue; // `$(` / `${` は値
      depth++;
    } else if (c === ")" || c === "}") {
      if (depth > 0) depth--;
    }
  }
  return depth > 0;
}

/**
 * `<<` の導入部が「安全な形」かを判定する。
 *
 * @param s コマンド全体
 * @param at `<<` の位置
 * @param afterDelim `<<DELIM` トークンの直後の位置
 */
function isSafeHeredocIntroducer(s, at, afterDelim) {
  // **閉じていない素のグループの中なら潰さない**（`{ … } | bash` / `( … ) | bash`）
  if (inOpenGroup(s, at)) return false;
  // 手前: 直近の区切りから `<<` まで。**どの区切りで切れたかで外側の扱いが変わる**
  let start = 0;
  let boundary = null;
  let boundaryAt = -1;
  for (let k = at - 1; k >= 0; k--) {
    const c = s[k];
    if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === "`" || c === "{") {
      boundary = c;
      boundaryAt = k;
      start = k + 1;
      break;
    }
  }

  // バッククォートの中は値が実行されうる
  if (boundary === "`") return false;
  // **ブレースグループ。** `{ cat <<EOF … EOF` の次に `} | bash` が来る形は
  // **閉じ括弧の後ろで実行される**（素のサブシェルと同型。`(` は塞いだのに
  // `{` を忘れていた。査読の高1・実行確認つき）。
  if (boundary === "{") return false;

  if (boundary === "(") {
    const prev = s[boundaryAt - 1];
    // **プロセス置換（`<(` / `>(`）は本文が実行される**
    if (prev === "<" || prev === ">") return false;
    if (prev === "$") {
      // **コマンド置換。** 値が `bash -c` / `eval` の引数になれば実行される。
      // **外側が `git` のメッセージ引数のときだけ潰す**（Claude Code 標準のコミット形）。
      let outerStart = 0;
      for (let k = boundaryAt - 2; k >= 0; k--) {
        const c = s[k];
        if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === "`" || c === "{") {
          outerStart = k + 1;
          break;
        }
      }
      if (!isGitMessageForm(s.slice(outerStart, boundaryAt - 1))) return false;
    } else {
      // **素のサブシェル。** `(cat <<EOF … EOF\n) | bash` のように、
      // **閉じ括弧の後ろで実行される**（終端より後ろなのでどの判定にも入らない）。
      return false;
    }
  }

  const before = s.slice(start, at);
  if (UNSAFE_IN_INTRODUCER.test(before)) return false;

  // 後ろ: `<<DELIM` から行末まで。リダイレクトとコメントだけなら安全
  let to = s.indexOf("\n", afterDelim);
  if (to < 0) to = s.length;
  const after = s.slice(afterDelim, to);
  if (!/^\s*(?:>>?\s*[^\s|;&`$(>]+\s*)*(?:#.*)?$/.test(after)) return false;

  const name = firstCommandName(before);
  if (!name) return false;
  if (!HEREDOC_DATA_SINKS.has(name)) return false;
  // **`git` / `gh` はサブコマンドを限る**（`-c` / `bisect` / `submodule` / `alias` は本文が実行されうる）
  if (name === "git") return isGitMessageForm(before);
  if (name === "gh") return isGhDataForm(before);
  return true;
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
