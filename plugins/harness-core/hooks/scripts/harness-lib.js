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
 * コマンドを解釈するときのシェルの方言（`git-scope` の `opts.shell` に渡す）。
 *
 * `Bash` と `PowerShell` は**エスケープ文字が違う**ため、片方の規則で読むと
 * 文字列の終わりを見失い、後続のコマンドを見落とす（H47 ②）。
 * ツール名が分からないときは bash として読む（従来の挙動）。
 */
function toolShell(payload) {
  return /powershell|pwsh/i.test(payload?.tool_name || "") ? "powershell" : "bash";
}

/**
 * `git commit` を含むコマンドか（matcher が Bash|PowerShell 全体に効くため各スクリプトで判定する）。
 *
 * `git` と `commit` の間にはグローバルオプションが挟まりうる（`git -C dir commit`、
 * `git -c user.name=x commit`、`git --no-pager commit`）。
 * **見逃し（ゲート素通り）は不可・誤検知（余計にチェックが走るだけ）は許容**の方針で広めに取る。
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
 * `paths.source` に一致するファイルが作業ツリーに1つでもあるか（H45）。
 *
 * `new-feature` の Step 0 と同じ「未初期化」の判定を、フックでも使う。
 * 追跡済みと未追跡（`.gitignore` 対象外）の両方を見る。初期化直後はまだ何もコミットされていないため。
 *
 * グロブは git の `:(glob)` パススペックに渡す（`**` は `/` を跨ぐ・`*` は跨がない ＝ 設定契約と同じ意味）。
 * 一致したものだけを出させるので、大きなリポジトリでも出力が膨らまない。
 *
 * @returns {boolean|null} 判定できないとき（git が使えない・`paths.source` が無い）は null。
 *   **呼び出し側は null を「初期化済み」として扱うこと**（分からないときにゲートを飛ばさない）
 */
function hasSourceFiles(config) {
  const globs = config?.paths?.source;
  if (!Array.isArray(globs) || !globs.length) return null;
  // git の `:(glob)` はブレース展開（`*.{ts,tsx}`）を持たないので、一致しないまま「未初期化」と誤判定する。
  // 判定できないものとして扱い、ゲートを飛ばさない
  if (globs.some((g) => /[{}[\]]/.test(String(g)))) return null;
  if (git("rev-parse --is-inside-work-tree") !== "true") return null;
  const specs = globs.map((g) => `":(glob)${String(g).replace(/"/g, "")}"`).join(" ");
  try {
    const out = execSync(`git ls-files -co --exclude-standard -- ${specs}`, {
      cwd: projectDir(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.trim().length > 0;
  } catch {
    return null;
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
  toolShell,
  stripHeredocBodies,
  isGitCommit,
  toPosix,
  loadConfig,
  commandFor,
  resolveCommand,
  git,
  hasSourceFiles,
  run,
  errorExcerpt,
  emit,
  notify,
  passThrough,
};
