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



/**
 * ヒアドキュメント（`<<EOF`）と PowerShell のヒアストリング（`@"…"@`）の**本文を空白へ潰す**。
 * **長さは変えない**（インデックスが呼び出し側の契約なので、位置をずらせない）。改行は残す。
 *
 * **なぜ本文を消すのか**（H50）。本文は**データであってコマンドではない**。
 * このリポジトリでは CLAUDE.md / CHANGELOG / コミットメッセージをヒアドキュメントで書くのが
 * 常態で、そこには禁止コマンド名が頻出する。
 *
 * **なぜ走査の途中で飛ばすのではなく、先に潰すのか。**
 * Claude Code 標準のコミットは `git commit -m "$(cat <<'EOF' … EOF\n)" -- <path>` の形で、
 * **`<<` が二重引用符の内側（コマンド置換の中）に現れる**。走査の途中で見ると
 * 「引用符の中なので `<<` を見ない」か「コマンドを途中で切る」の二択になり、
 * 前者は**本文の `"` が奇数個あるだけで引用符の判定が反転して後続を見失い**
 * （実測: `… && git add -A` が deny をすり抜けた）、
 * 後者は `git commit -m "$(cat` だけが1コマンドに見えて**正しい `-- <path>` を見失う**
 * （誤警報。§8「安全弁は正常な操作で鳴らないことが要件」に触れる）。
 * **先に潰せばどちらも起きない** — 引用符の数も区切り記号も本文から消える。
 */
function maskHereBodies(s, ps) {
  const out = s.split("");
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let sq = false; // シングルクォートの中（展開されないので `<<` はヒアドキュメントではない）

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    // PowerShell のヒアストリング。`@"` / `@'` の直後が改行のときだけ。
    if (ps && !sq && c === "@" && (s[i + 1] === '"' || s[i + 1] === "'")) {
      const q = s[i + 1];
      const nl = s.indexOf("\n", i + 2);
      if (nl >= 0 && s.slice(i + 2, nl).trim() === "") {
        // **終端規則はヒアドキュメントと違う。** PowerShell は `"@` が**行頭にあれば終端**で、
        // **後ろに文字が続いてよい**（`"@ -- a.md; git add -A` のように同じ行で式が続く）。
        // 行全体の一致で探すと終端を見失い、**本文が文字列の終わりまで伸びて
        // 後続の `; git add -A` ごと消える**（実測: deny がすり抜けた）。
        //
        // **開き（`@"`）と閉じ（`"@`）は残す。** ヒアドキュメントと違って残す方が正しい ——
        // 引用符が開いたままになるので、**潰した本文の改行がコマンドの区切りとして読まれない**。
        // 両方潰すと改行が区切りになり、`git commit -m` と `-- a.md` が別のコマンドへ割れて
        // **パス指定を見失う**（誤警報）。**片方だけ残すのが最悪**で、引用符の数が合わず
        // **後続の `; git add -A` ごと飲み込む**。どちらも実測で踏んだ。
        const closeAt = findHereStringEnd(s, nl + 1, q + "@");
        blank(nl + 1, closeAt);
        i = closeAt + 1;
        continue;
      }
    }

    if (c === "'" && !ps) {
      sq = !sq;
      continue;
    }
    if (sq) continue;

    if (c === "<" && s[i + 1] === "<") {
      // **ヒアストリング（`<<<`）は本文を持たない。** `<<abc` と読むと
      // 終端が見つからず、**後続すべてを潰して deny をすり抜ける**（実測）。
      if (s[i + 2] === "<") {
        i += 2;
        continue;
      }
      const m = /^<<(-?)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w]*))/.exec(s.slice(i));
      if (m) {
        // **本文を受け取るコマンドを見る。** `bash <<EOF` / `ssh h <<EOF` の本文は
        // **シェルが実行する**ので、潰すと `git add -A` を見逃す（実測）。
        // 算術のシフト（`$((1 << N))`）も、ここで自動的に外れる。
        // **許可リストにしてあるのは、知らないコマンドを「潰さない」側へ倒すため** ——
        // 潰さない側の失敗は誤警報だが、潰す側の失敗は **deny のすり抜け**である。
        // **安全な形のときだけ潰す**（許可リスト。理由は `isSafeHeredocIntroducer`）
        if (!isSafeHeredocIntroducer(s, i, i + m[0].length)) continue;

        const delim = m[2] || m[3] || m[4];
        const bodyStart = s.indexOf("\n", i + m[0].length);
        if (bodyStart < 0) return out.join("");
        // **潰すのは `<<delim` のトークンと、本文の行だけ。**
        // 導入部の行をまるごと潰すと、**同じ行に続く `| git add -A` が消える**（実測）。
        // トークンだけ潰せば、`git commit -F - -- CLAUDE.md <<'EOF'` の
        // `<<'EOF'` がパス指定に見える問題も起きない。
        const end = findTerminator(s, bodyStart + 1, delim, m[1] === "-");
        blank(i, i + m[0].length);
        blank(bodyStart + 1, end);
        i = end - 1;
      }
    }
  }
  return out.join("");
}

/**
 * 区切り語の行の**終わり**（次の行の先頭）を返す。見つからなければ文字列の終わり。
 *
 * **終わりの行は区切り語そのものでなければならない。**
 * 以前は `line.trim() === delim` で前後の空白をすべて許していたが、
 * シェルは**行頭から区切り語だけ**の行しか終端と見ない（`<<-` はタブだけを落とす。
 * 空白は落とさない）。許しすぎると、本文の中の字下げした `EOF` で
 * **本文が早く終わったと誤判定し、そこから先の本文をコマンドとして読んでしまう**。
 */
/**
 * PowerShell のヒアストリングの本文の**終わり**を返す。
 *
 * **行頭の `"@` / `'@` が終端**で、その**2文字の開始位置**を返す
 * （後ろに式が続くため、行末まで飛ばしてはいけない）。見つからなければ文字列の終わり。
 */
function findHereStringEnd(s, from, closer) {
  let pos = from;
  while (pos <= s.length) {
    if (s.startsWith(closer, pos)) return pos;
    const nl = s.indexOf("\n", pos);
    if (nl < 0) break;
    pos = nl + 1;
  }
  return s.length;
}

function findTerminator(s, from, delim, stripTabs) {
  let pos = from;
  while (pos <= s.length) {
    let nl = s.indexOf("\n", pos);
    const last = nl < 0;
    if (last) nl = s.length;
    let line = s.slice(pos, nl).replace(/\r$/, "");
    if (stripTabs) line = line.replace(/^\t+/, "");
    if (line === delim) return last ? s.length : nl + 1;
    if (last) break;
    pos = nl + 1;
  }
  return s.length;
}

function scanCommands(cmd, opts) {
  const { escape, separators } = dialect(opts);
  // **ヒアドキュメント／ヒアストリングの本文は先に空白へ潰す**（H50。長さは変わらない）。
  // 走査の途中で飛ばすと、引用符の中に現れた `<<` を扱えない。理由は `maskHereBodies` を見ること。
  const s = maskHereBodies(String(cmd || ""), (opts && opts.shell) === "powershell");
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
      // 行継続（`git \<改行> add -A`）。トークンの切れ目として扱う
      if (s[i + 1] === "\n") {
        flush(i);
        i++;
        continue;
      }
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
  "--config-env",
]);

// ⚠️ **値を `=` でしか取らないものを入れない。** 入れると次のトークン（サブコマンド）を
// 値として飛ばしてしまい、**ガードが素通りする**。
// `git --exec-path status` は exec path を表示して終わる（値を取らない）、
// `--super-prefix` / `--attr-source` は `=` が無いとエラーになる（いずれも実測）。

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
