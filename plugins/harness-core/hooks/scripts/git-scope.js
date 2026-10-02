/**
 * git コマンドの走査と、範囲まるごとの操作の判定（core hooks 共有）
 *
 * **副作用を持たない純関数だけを置く。** フックから require して使う。
 *
 * ## なぜコマンド位置に限るのか
 *
 * 素の正規表現で文字列を探すと、**引用符・コメント・ヒアドキュメントの中に
 * コマンド名があるだけで発火する**。規約や CHANGELOG を書くリポジトリでは
 * 禁止コマンド名は**頻出する説明対象**であり、実際に `claude-dev-harness` 自身の
 * ガードが正常な操作を4回ブロックした（2026-08-16）。
 *
 * `pre-commit-check.js` が書いているとおり
 * **「安全弁は正常な操作で鳴らないことが要件」**であり、
 * **鳴りすぎる安全弁はいずれ外される**。
 *
 * ## ⚠️ 同じ実装が2箇所にある
 *
 * `claude-dev-harness/.claude/hooks/repo-guard.js` にも同じ判定がある
 * （あちらはリポジトリ固有で、**配布物のプラグインに自分の規律を依存させない**方針のため）。
 * **片方だけ直さないこと。** `tests/git-scope.test.mjs` が両者の乖離を検出する。
 */
// ---------------------------------------------------------------------------
// コマンド位置の走査（R3 の中核）
// ---------------------------------------------------------------------------

/** コマンドが始まりうる位置を作る文字。`(` と `` ` `` はコマンド置換の内側を拾うため */
const SEPARATORS = new Set([";", "&", "|", "\n", "(", ")", "`", "{", "}"]);

/** PowerShell の区切り文字。`` ` `` は**エスケープ文字**であって区切りではない */
const SEPARATORS_PS = new Set([";", "&", "|", "\n", "(", ")", "{", "}"]);

/**
 * シェルの方言差（H47 ②）。
 *
 * Claude Code は `Bash` と `PowerShell` の2つのツールから同じフックを呼ぶ。
 * **エスケープ文字が違う**ので、片方の規則で読むと文字列の終わりを見失う。
 *
 * > 実測（2026-10-02・H46 の査読 M3）。PowerShell の `cd "D:\work\"; git push` を
 * > bash の規則で読むと `\"` を「エスケープされた引用符」と解釈して閉じ引用符を見失い、
 * > **後続の `git push` が引用符の内側扱いになる**。ガードが素通りした。
 *
 * 呼び出し側は payload の `tool_name` から `{ shell: "powershell" }` を渡す。
 * **既定は bash**（情報が無ければ従来どおりに読む）。
 */
function dialect(opts) {
  const ps = (opts && opts.shell) === "powershell";
  return { escape: ps ? "`" : "\\", separators: ps ? SEPARATORS_PS : SEPARATORS };
}

/**
 * 引用符・エスケープを解釈しながら、**コマンド位置から始まる断片**を列挙する。
 *
 * 引用符の内側は**1つの断片にもならない**ので、`echo 'git add -A'` は拾われない。
 *
 * @param {string} cmd
 * @param {{shell?: "bash"|"powershell"}} [opts]
 * @returns {{index: number, text: string}[]} index はコマンド語の開始位置
 */
function scanCommands(cmd, opts) {
  const { escape, separators } = dialect(opts);
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
      if (c === escape && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === escape) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    // ヒアドキュメントの本文は**データであってコマンドではない**。
    // このリポジトリでは CLAUDE.md / CHANGELOG / コミットメッセージを
    // ヒアドキュメントで書くのが常態で、そこには禁止コマンド名が頻出する。
    // （実際、本ガードの導入コミット自身がこれで止まった）
    if (c === "<" && s[i + 1] === "<") {
      const m = /^<<-?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w]*))/.exec(s.slice(i));
      if (m) {
        const delim = m[1] || m[2] || m[3];
        const bodyStart = s.indexOf("\n", i + m[0].length);
        if (bodyStart < 0) {
          flush(s.length);
          return out;
        }
        // 終端行（前後の空白を除いて区切り語と一致する行）まで飛ばす
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
    if (separators.has(c)) {
      flush(i);
      start = i + 1;
    }
  }
  flush(s.length);
  return out;
}

/**
 * 引用符を解釈してトークンへ分ける（引用符そのものは外す）。
 *
 * `parseGit` が**値つきのグローバルオプション**を飛ばすのに要る。
 * 位置を返すので、呼び出し側は元の文字列から残りを切り出せる。
 *
 * @param {string} text
 * @param {{shell?: "bash"|"powershell"}} [opts]
 * @returns {{value: string, start: number, end: number}[]}
 */
function tokenize(text, opts) {
  const { escape } = dialect(opts);
  const s = String(text || "");
  const out = [];
  let value = "";
  let start = -1;
  let quote = null;

  const flush = (end) => {
    if (start >= 0) out.push({ value, start, end });
    value = "";
    start = -1;
  };

  // **エスケープ文字をむやみに落とさない。** Windows のパスは `D:\work\x` のように
  // バックスラッシュを含み、bash の規則どおりに落とすと `D:workx` になる
  // （実測: `git -C D:\...\plugins push` の対象ディレクトリを取り違えた）。
  // 引用符・空白・エスケープ文字自身を逃がすときだけ落とす。
  const unescape = (ch) => (/['"\s]/.test(ch) || ch === escape ? ch : escape + ch);

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === escape && quote === '"' && i + 1 < s.length) value += unescape(s[++i]);
      else if (c === quote) quote = null;
      else value += c;
      continue;
    }
    if (c === "'" || c === '"') {
      if (start < 0) start = i;
      quote = c;
      continue;
    }
    if (c === escape && i + 1 < s.length) {
      if (start < 0) start = i;
      value += unescape(s[++i]);
      continue;
    }
    if (/\s/.test(c)) {
      flush(i);
      continue;
    }
    if (start < 0) start = i;
    value += c;
  }
  flush(s.length);
  return out;
}

/**
 * `git` のグローバルオプションのうち、**値を別のトークンで取る**もの。
 *
 * 飛ばし損ねると値をサブコマンドと取り違える。
 * 実測では `git --git-dir x push` の `sub` が `x` になり、push のガードが全部外れていた。
 */
const GIT_GLOBAL_VALUE_OPTS = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--super-prefix",
  "--attr-source",
]);

/**
 * 断片が `git` の呼び出しなら `{ index, sub, args }` を返す（違えば null）。
 *
 * 先頭の環境変数代入（`FOO=bar git ...`）と、
 * サブコマンドより前のグローバルオプション（`-c x=y` / `-C dir` / `--no-pager`）を飛ばす。
 *
 * **オプションはトークン単位で飛ばす**（H47 ①③）。初版は正規表現の選択肢を順に当てていたため、
 * 次の3つを取りこぼした（いずれも 2026-10-02 に再現）。
 *
 * | 形 | 初版の結果 |
 * |----|-----------|
 * | `git -C "D:/my proj" push` | 空白で切れて `sub` が `proj` |
 * | `git --git-dir x push` | 値を飛ばせず `sub` が `x` |
 * | `git -P push` | 1文字フラグに当たる選択肢が無く null |
 */
function parseGit(seg, opts) {
  const text = String(seg.text || "").replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/,
    ""
  );
  const tokens = tokenize(text, opts);
  if (!tokens.length || tokens[0].value !== "git") return null;

  let i = 1;
  while (i < tokens.length && tokens[i].value.startsWith("-")) {
    // 値が同じトークンに付いている形（`-cuser.name=x` / `--git-dir=x`）は1つだけ飛ばす
    i += GIT_GLOBAL_VALUE_OPTS.has(tokens[i].value) ? 2 : 1;
  }

  const sub = tokens[i];
  if (!sub || !/^[a-zA-Z][\w-]*$/.test(sub.value)) return null;
  return { index: seg.index, sub: sub.value, args: text.slice(sub.end).trim() };
}

/** コマンド位置に現れた git 呼び出しをすべて返す */
function gitInvocations(cmd, opts) {
  return scanCommands(cmd, opts)
    .map((seg) => parseGit(seg, opts))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// 個々の判定
// ---------------------------------------------------------------------------

const hasFlag = (args, re) => re.test(args);
/** 短縮オプションの束（`-am` など）に指定の文字が含まれるか。`--amend` には当たらない */
const inBundle = (args, ch) =>
  new RegExp(`(^|\\s)-[A-Za-z]*${ch}[A-Za-z]*(\\s|$)`).test(args);
/** オプションを除いた最初の引数（パス指定の有無を見る） */
const firstOperand = (args) =>
  args
    .split(/\s+/)
    .filter(Boolean)
    .find((a) => a !== "--" && !a.startsWith("-")) || "";

/** `git add` に「範囲まるごと」の指定が付いているか（`--dry-run` は対象外） */
function isBlockedAdd(command, opts) {
  return gitInvocations(command, opts).some(
    (g) =>
      g.sub === "add" &&
      !hasFlag(g.args, /(^|\s)(--dry-run|-n)(\s|$)/) &&
      hasFlag(g.args, /(^|\s)(-A|--all|\.|:\/)(\s|$)/)
  );
}

/** `git commit -a` / `-am` / `--all`（追跡済みを全部巻き込む） */
function isBlockedCommitAll(command, opts) {
  return gitInvocations(command, opts).some(
    (g) => g.sub === "commit" && (inBundle(g.args, "a") || hasFlag(g.args, /(^|\s)--all(\s|$)/))
  );
}

/** 退避する形の `git stash`（`list` / `show` / `pop` / `apply` / `drop` は読み出し・復元なので通す） */
const STASH_SAFE = new Set(["list", "show", "pop", "apply", "drop", "branch", "clear"]);
function isBlockedStash(command, opts) {
  return gitInvocations(command, opts).some(
    (g) => g.sub === "stash" && !STASH_SAFE.has(firstOperand(g.args))
  );
}

/** 範囲指定なしの破棄（`checkout -- .` / `restore .` / パス指定なしの `clean`） */
function isBlockedDiscard(command, opts) {
  return gitInvocations(command, opts).some((g) => {
    if (g.sub === "checkout" || g.sub === "restore") {
      const op = firstOperand(g.args);
      return op === "." || op === ":/" || op === "./";
    }
    if (g.sub === "clean") {
      if (hasFlag(g.args, /(^|\s)(-n|--dry-run)(\s|$)/)) return false; // 確認だけなら通す
      return firstOperand(g.args) === "" || firstOperand(g.args) === "." || firstOperand(g.args) === ":/";
    }
    return false;
  });
}

/**
 * パス指定なしの `git commit`。**deny しない**（`git add <path>` の直後など正当な使い方がある）。
 * 警告に留めるのは R4 の明示的な指示。
 */
function isUnscopedCommit(command, opts) {
  return gitInvocations(command, opts).some(
    (g) =>
      g.sub === "commit" &&
      !g.args.includes("--") &&
      !inBundle(g.args, "a") &&
      !hasFlag(g.args, /(^|\s)--all(\s|$)/) &&
      !hasFlag(g.args, /(^|\s)(--amend|--dry-run)(\s|$)/)
  );
}

// ---------------------------------------------------------------------------
// コミット前ゲートが見られない変更（H48）
// ---------------------------------------------------------------------------

/** `git commit` より前に置いても作業ツリーを変えない git サブコマンド（`add` はステージするだけ） */
const TREE_SAFE_GIT = new Set([
  "add", "status", "diff", "log", "show", "rev-parse", "ls-files", "branch", "remote", "config", "fetch", "tag",
]);

/** 引数しだいで index だけを触る git サブコマンド（`git mv` は旧・新パスの両方を指定するコミットの前置きとして常用される） */
function gitTreeSafe(g) {
  if (TREE_SAFE_GIT.has(g.sub) || g.sub === "mv") return true;
  const flag = (re) => re.test(g.args);
  if (g.sub === "rm") return flag(/(^|\s)--cached(\s|$)/);
  if (g.sub === "reset") return !flag(/(^|\s)--(hard|merge|keep)(\s|$)/);
  if (g.sub === "restore") return flag(/(^|\s)(--staged|-S)(\s|$)/) && !flag(/(^|\s)(--worktree|-W)(\s|$)/);
  return false;
}

/**
 * 作業ツリーを変えないコマンド（Bash / PowerShell）。**ここに無いものは「変えうる」と見なす**。
 * 後半はパイプの受け手としてよく付くもの（`ls | wc -l` / `git add a | Out-Null`）
 */
const TREE_SAFE_COMMANDS = new Set([
  "cd", "pushd", "popd", "chdir", "pwd", "ls", "dir", "echo", "printf", "cat", "true", "test", "[", ":",
  "set-location", "sl", "get-location", "get-childitem", "gci", "write-host", "write-output", "start-sleep", "sleep",
  "wc", "head", "tail", "grep", "sort", "uniq", "type", "findstr", "get-content", "gc",
  "out-null", "out-string", "select-object", "select", "where-object", "where", "measure-object",
  "select-string", "sls", "format-table", "ft",
]);

/** ファイルへのリダイレクト（`/dev/null` / `$null` / `NUL` は除く） */
const FILE_REDIRECT = />>?\s*(?!\/dev\/null\b)(?!\$null\b)(?!nul\b)[^\s&|;<>]/i;

/** 断片の先頭にあるシェルの予約語（`if ...; then git commit` の `then` など）を剥がす */
const stripKeyword = (seg) => ({ ...seg, text: seg.text.replace(/^(?:then|do|else|elif|time|!)\s+/, "") });

function changesTree(seg, opts) {
  const unquoted = seg.text.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""');
  if (FILE_REDIRECT.test(unquoted)) return true;
  const g = parseGit(seg, opts);
  if (g) return !gitTreeSafe(g);
  // PowerShell の変数代入（`$x = 1`）
  if (/^\$[\w:]+\s*=/.test(seg.text)) return false;
  const t = seg.text.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
  const name = (t.split(/\s+/)[0] || "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
  return !TREE_SAFE_COMMANDS.has(name);
}

/** `bash -c "..."` / `pwsh -Command "..."` / `eval "..."` の中身（引用符の内側）を取り出す */
function wrappedCommand(text) {
  const m =
    /^(?:(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?\s+(?:-\S+\s+)*?(?:-c|-command)|eval)\s+(["'])([\s\S]*)\1\s*$/i.exec(text);
  return m ? m[2] : null;
}

/**
 * **同じコマンドの中で `git commit` より前にファイルを変えうる操作**があれば、その断片を返す（無ければ null）。
 *
 * `pre-commit-check` は PreToolUse で、**コマンドの実行前**の作業ツリーにゲートを当てる。
 * `printf ... > x.ts && git commit` の `x.ts` は検査の時点では存在しないので、
 * 型エラーがあっても「✅ 成功」のままコミットされる（pocket-drop で実測）。
 *
 * 判定は「安全と分かっているもの以外は変えうる」の側に倒す（**見逃しは不可・誤検知は許容**。
 * 誤検知しても、コミットを別の呼び出しに分ければ済む）。
 *
 * repo-guard には複製しない（ゲートを持つのは配布物の `pre-commit-check` だけ）。
 */
function changesBeforeCommit(command, opts) {
  // `2>&1` / `>&2` のような fd の複製は、`&` が区切り文字なので走査の前に消す（ファイルを書かない）。
  // `&> file`（stdout と stderr の両方をファイルへ）はリダイレクトとして残す
  const text = String(command || "").replace(/\d*>&(?:\d+|-)/g, " ").replace(/&>/g, ">");
  const segs = scanCommands(text, opts).map(stripKeyword);
  const ci = segs.findIndex((seg) => parseGit(seg, opts)?.sub === "commit");
  if (ci < 0) {
    // コミットが `bash -c "..."` 等の内側にある。中身を同じ規則で見る
    for (let i = 0; i < segs.length; i++) {
      const inner = wrappedCommand(segs[i].text);
      if (inner === null) continue;
      const before = segs.slice(0, i).find((seg) => changesTree(seg, opts));
      if (before && /\bgit\b[\s\S]*\bcommit\b/.test(inner)) return before.text;
      const hit = changesBeforeCommit(inner, opts);
      if (hit) return hit;
    }
    return null;
  }
  const hit = segs.slice(0, ci).find((seg) => changesTree(seg, opts));
  return hit ? hit.text : null;
}

module.exports = {
  changesBeforeCommit,
  scanCommands,
  tokenize,
  parseGit,
  gitInvocations,
  isBlockedAdd,
  isBlockedCommitAll,
  isBlockedStash,
  isBlockedDiscard,
  isUnscopedCommit,
};
