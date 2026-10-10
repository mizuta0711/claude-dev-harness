/**
 * claude-dev-harness の規律を強制する PreToolUse ガード（H19 / R3・R4・R5）
 *
 * ## なぜ必要か
 *
 * このリポジトリには `.claude/` が無く、規律は `CLAUDE.md` という**読ませる文書だけ**で
 * 担保されていた。結果、2026-08-16 の1日で規約違反が3件（うち1件は2版連続）出た。
 * ハーネス自身が「**仕組みで強制する。記憶に頼らない**」（constitution / 入門ガイド §2-3）と
 * 定めながら、**その仕組みを利用側にだけ配って自分には適用していなかった**のが真因。
 *
 * ## なぜ配布物のプラグインではないのか
 *
 * **自分が編集中のプラグインに、自分の規律を依存させないため。**
 * `plugins/harness-core/hooks/` に置くと、フックを壊した瞬間に自分のセッションが止まり、
 * 直すために規律を外すことになる。ブートストラップの輪を作らない。
 *
 * `tools/create-project.mjs` は `templates/` からしか読まないため、
 * **リポジトリ直下の `.claude/` は生成物にも `harness-update` の3点比較にも入らない**（確認済み）。
 *
 * ## ⚠️ 置き場所は1箇所では足りない
 *
 * フックは**セッションのプロジェクトディレクトリの `.claude/settings.json`** だけが読まれる。
 * ハーネスは **ProjectTemplete のセッションから `cd` して編集される**ことが常態であり、
 * 事故（`6c68d30`）もそちらで起きた。**ハーネス側に置いただけでは、事故った経路を覆えない。**
 *
 * そのため本スクリプトは**どちらに置いても正しく動く**ように、
 * **コマンドから対象ディレクトリを解決する**（`cd X && ...` / `git -C X`）。
 * 同じものを ProjectTemplete の `.claude/hooks/` にも置く。**片方だけ直さないこと。**
 *
 * ## 判定は「コマンド位置」に限定する（R3）
 *
 * 初版はコマンド文字列に対する**素の正規表現**だったため、
 * **引用符やコメントの中に文字列があるだけで deny した**。
 * このリポジトリでは禁止コマンド名は**頻出する説明対象**であり、
 * 実際にレビュー中と本作業中の2回、正常な操作がブロックされた。
 *
 * `pre-commit-check.js:62` は「**安全弁は正常な操作で鳴らないことが要件**」と書いている。
 * **鳴りすぎる安全弁はいずれ外される。**
 *
 * そこで `scanCommands()` が引用符・エスケープを解釈しながら
 * **コマンドが始まる位置**（文字列の先頭、`;` `&&` `||` `|` 改行 `(` `` ` `` の直後）だけを拾い、
 * そこに現れた `git` だけを判定対象にする。
 *
 * ## 何を止めるか
 *
 * | 対象 | 扱い | 根拠 |
 * |------|------|------|
 * | `git add -A` / `.` / `--all` / `:/` | **deny** | 他セッションの変更を巻き込む |
 * | `git commit -a` / `-am` / `--all` | **deny** | 追跡済みを全部巻き込む。**実害は `add -A` とほぼ同じ** |
 * | `git stash`（退避する形） | **deny** | 他セッションの変更ごと退避する |
 * | `git checkout -- .` / `git restore .` | **deny** | 範囲指定なしの破棄 |
 * | `git clean`（パス指定なし） | **deny** | 同上 |
 * | パス指定なしの `git commit -m` | **警告のみ** | `git add <path>` の直後など**正当な使い方がある** |
 * | パス指定なしの `git commit --amend` | **警告のみ** | **インデックス全体を取り込む**（H32・実測で事故）。自分の直前のコミットを直すのは正当 |
 * | `git push`（validate 不通過時） | **deny** | 版番号の不一致など機械で判定できる欠陥を公開前に止める |
 *
 * ### push ゲートの実害の正確な範囲（2026-08-16 実測）
 *
 * `marketplace.json` と `plugin.json` の版がずれても**配信は止まらない**。
 * `claude plugin validate --strict` 自身がこう言う:
 *
 * > At install time, plugin.json wins (calculatePluginVersion precedence)
 * > — the entry version is silently ignored.
 *
 * **止まるのではなく、カタログの表示が黙って嘘になる**のが実害。
 * それでも止める価値があるのは、**判定が機械的で検査コマンドが既にある**（＝最も安い）から。
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function readPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf-8"));
  } catch {
    return null;
  }
}

function deny(label, reason) {
  console.log(
    JSON.stringify({
      systemMessage: `[repo-guard] ❌ ${label}`,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

/**
 * 止めずに知らせる。**2経路とも出す**（画面と Claude の文脈）。
 * 片方だけでは必ず片側に届かない（`harness-lib.notify` と同じ理由）。
 */
function warn(message) {
  console.log(
    JSON.stringify({
      systemMessage: `[repo-guard] ⚠️ ${message}`,
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: message },
    })
  );
}

/**
 * 実行ファイルが PATH 上にあるか。**ロケールに依存しない**方法で調べる。
 *
 * ⚠️ `execSync` の失敗メッセージで判定してはいけない。シェル経由なので
 * `e.code` は `ENOENT` にならず（`status` は 1 で通常の失敗と区別できない）、
 * メッセージは**OS の言語で変わる**。日本語 Windows では
 * 「'claude' は、内部コマンドまたは外部コマンド…」となり、英語の文字列照合は当たらない
 * （2026-08-16 実測。最初の実装はこれで判定に失敗した）。
 */
function hasCommand(name) {
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const d of dirs) {
    for (const e of exts) {
      try {
        if (fs.existsSync(path.join(d, name + e))) return true;
      } catch {
        /* 読めないディレクトリは飛ばす */
      }
    }
  }
  return false;
}

/** MSYS/Git Bash の `/d/foo` を Windows の `d:/foo` に直す（Node の fs はこれを解釈しない） */
function toNativePath(p) {
  const s = String(p || "").replace(/^["']|["']$/g, "");
  const m = s.match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? `${m[1]}:/${m[2]}` : s;
}

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

/** `gh` のうち**次のトークンを値として取る**オプション */
const GH_VALUE_OPTS = new Set(["-R", "--repo", "-H", "--hostname"]);

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
    // **値を取るオプションの「値」をサブコマンドと取り違えない。**
    // `gh --repo a/b pr create` の `a/b` を読んで `pr` に届いていなかった（査読の低4・0.35.1 からの回帰）
    if (GH_VALUE_OPTS.has(t)) {
      k++;
      continue;
    }
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
 * **1行だけ遡る方式では足りなかった** —— `{` が**別の行**にあると境界が改行になり、
 * グループの中だと分からない（`{ cat <<EOF … EOF` の次に `} | bash` が来る形）。
 *
 * ## 数えるときに読み飛ばすもの
 *
 * **生の文字列をそのまま数えると、誤警報が増える**（6回目の査読の中1と、自分の実測）。
 * **文書を書く本文にはコード例が入る**ので、`function f() {` や `if (x) {` が当たり前に出てくる。
 *
 * | 読み飛ばすもの | 飛ばさないと起きること |
 * |---|---|
 * | **ヒアドキュメントの本文** | 本文の `{` を数え、**次の文書書き込みが鳴る**（`function f() {` を書くだけで） |
 * | **引用符の中**（`'…'` / `"…"`） | `echo "fix (wip"` の後ろが鳴る。奇数個の `'` で状態が反転して**逆に見逃す** |
 * | **`#` コメント** | `# {` の行の後ろが鳴る |
 * | **`\` のエスケープ** | `echo \{` の後ろが鳴る |
 *
 * **`$(` と `${` は数えない。** あれは値になるだけで、
 * 外側が `git` のメッセージ引数なら潰してよい（標準のコミット形）。
 * 値が実行される形は `isSafeHeredocIntroducer` の `$(` の分岐で別に見る。
 */
function inOpenGroup(s, at) {
  let depth = 0;
  for (let i = 0; i < at; i++) {
    const c = s[i];

    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      // 引用符の中は数えない。**閉じが無ければそこで打ち切る**
      let j = i + 1;
      while (j < s.length && s[j] !== c) {
        if (c === '"' && s[j] === "\\") j++;
        j++;
      }
      i = j;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      const nl = s.indexOf("\n", i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    // **ヒアドキュメントの本文は数えない**（`<<<` は本文を持たない）
    if (c === "<" && s[i + 1] === "<" && s[i + 2] !== "<") {
      const m = /^<<(-?)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w]*))/.exec(s.slice(i));
      if (m) {
        const bodyStart = s.indexOf("\n", i + m[0].length);
        if (bodyStart < 0) break;
        const delim = m[2] || m[3] || m[4];
        i = findTerminator(s, bodyStart + 1, delim, m[1] === "-") - 1;
        continue;
      }
    }

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
 * コマンドを包むだけのコマンド。**この後ろの `git` を見落としてはいけない**（H70）。
 *
 * > 実測: **`sudo git add -A` / `env` / `time` / `eval` / `command` / `nohup` /
 * > `nice` / `xargs` / `/usr/bin/git` が、すべて deny を素通りしていた。**
 * > `parseGit` が `tokens[0].value !== "git"` で弾いていたため。
 *
 * **`sudo` の付け忘れ・付け足しは実際に起こる**ので、
 * **ヒアドキュメント由来の見逃し（H65）より事故の形に近い**。
 *
 * **`echo` / `cp` / `ls` / `docker` は入れない。** あれは `git` を**実行しない**ので、
 * 入れると `echo git add -A` で鳴る（誤検知）。
 */
const COMMAND_WRAPPERS = new Set([
  "sudo", "doas", "env", "command", "nohup", "setsid", "time", "timeout",
  "nice", "ionice", "stdbuf", "xargs", "eval", "exec",
]);

/**
 * 包むコマンドごとの、**次のトークンを値として取る**オプション。
 *
 * **一律の表にしてはいけない。** `env -i`（環境を捨てる・値なし）と
 * `xargs -i`（置換文字列・値あり）のように、**同じ綴りで意味が違う**
 * （一律に値ありとすると `env -i git add -A` の `git` を飛ばして**見逃す**）。
 */
const WRAPPER_VALUE_FLAGS = {
  sudo: new Set(["-u", "-g", "-U", "-C", "-p", "-r", "-t", "--user", "--group", "--prompt"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "--unset"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p", "--class", "--classdata", "--pid"]),
  stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
  xargs: new Set(["-I", "-i", "-n", "-L", "-P", "-s", "-d", "-E", "--replace", "--max-args"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
  exec: new Set(["-a"]),
};

const NO_VALUE_FLAGS = new Set();

/** トークンから実行ファイル名を取る（ディレクトリと拡張子を落とす） */
function commandBaseName(value) {
  const base = String(value).split("/").pop().split(String.fromCharCode(92)).pop();
  return base.replace(/\.(exe|cmd|bat|com)$/i, "");
}

/**
 * 包むコマンドのオプション・環境変数代入・秒数を飛ばし、次に見るべき添字を返す。
 *
 * `gitTokenIndex` と `wrappedCommand` の両方が同じ飛ばし方を要る（切り出さないと片方だけ古くなる）。
 */
function skipWrapperFlags(tokens, at, name) {
  const flags = WRAPPER_VALUE_FLAGS[name] || NO_VALUE_FLAGS;
  let k = at + 1;
  while (k < tokens.length) {
    const t = tokens[k].value;
    if (/^[A-Za-z_][\w]*=/.test(t)) {
      k++; // 環境変数の代入（`env FOO=1 git …`）
      continue;
    }
    if (t.startsWith("-")) {
      // **値が別トークンのものだけ2つ飛ばす**（`-I{}` のように値が付いている形は1つ）
      k += flags.has(t) ? 2 : 1;
      continue;
    }
    if (/^\d+(?:\.\d+)?[smhd]?$/.test(t)) {
      k++; // `timeout 5` の秒数
      continue;
    }
    break;
  }
  return k;
}

/**
 * **最初の実コマンド**の位置を返す（包むコマンドを越えて探す）。
 *
 * **「後ろのどこかに `git` があれば」ではいけない**（H70 の査読の中1・中2）——
 * ラッパーの後ろで**別のコマンドが動く**形や、**オプションの値が `git`** の形で誤る。
 *
 * | 形 | 「どこかに」方式の誤り |
 * |---|---|
 * | `sudo echo git add -A` | **`echo` は `git` を実行しない**のに鳴った（誤検知） |
 * | `sudo ls git status` / `sudo man git commit -a` | 同じ（誤検知） |
 * | `sudo docker run --rm alpine/git add -A` | 同じ（誤検知。コンテナ内の git） |
 * | `sudo -u git git push` | **`-u` の値 `git`** を先に見つけ、サブコマンドが `git` になって**見逃した** |
 *
 * @returns トークンの添字。ラッパーだけで終わっていれば -1
 */
function firstCommandIndex(tokens) {
  let k = 0;
  while (k < tokens.length) {
    const name = commandBaseName(tokens[k].value);
    if (!COMMAND_WRAPPERS.has(name)) return k;
    k = skipWrapperFlags(tokens, k, name);
  }
  return -1;
}

/**
 * `git` の呼び出しの位置を返す。**包むコマンドとパス付きの形を越えて探す**（H70）。
 *
 * @returns `git` のトークンの添字。無ければ -1
 */
function gitTokenIndex(tokens) {
  const k = firstCommandIndex(tokens);
  return k >= 0 && commandBaseName(tokens[k].value) === "git" ? k : -1;
}

/** 先頭の環境変数代入（`FOO=bar git ...`） */
const ENV_ASSIGN_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;

/** `-c` / `-Command`（`-lc` のような束も含む） */
const isDashC = (v) =>
  /^--?command$/i.test(v) || (/^-[A-Za-z]+$/.test(v) && v.includes("c"));

/** `-c` / `-Command` の後ろを「シェルへ渡す文字列」として読むコマンド */
const SHELL_DASH_C = /^(?:bash|sh|zsh|dash|ksh|ash|busybox|pwsh|powershell)$/i;

/**
 * **引用符の内側に隠れた、もう一段のコマンド**を取り出す（H69）。
 *
 * `bash -c "git add -A"` / `sh -c 'git add -A'` / `eval "git add -A"` は、
 * `scanCommands` が引用符の中を走査しないため **deny を素通りしていた**（実測）。
 * ヒアドキュメント（H65）とは無関係で、無しでも素通りする。
 *
 * **ラッパーを挟んだ形も剥がす**（`sudo bash -c "..."`）。H70 と同じ理由。
 *
 * ⚠️ **スクリプトファイルを渡す形（`bash script.sh`）は null を返す。**
 * 中身はファイルの側にあり、このフックからは読めない（**見逃しになるが、
 * 読みに行くとフックがファイルシステムに依存する**）。
 * `powershell -EncodedCommand`（base64）も同じ理由で扱わない。
 *
 * @returns 内側のコマンド文字列。包む形でなければ null
 */
function wrappedCommand(text, opts) {
  const tokens = tokenize(String(text || "").replace(ENV_ASSIGN_PREFIX, ""), opts);
  const join = (from) => tokens.slice(from).map((t) => t.value).join(" ") || null;
  let k = 0;
  while (k < tokens.length) {
    const name = commandBaseName(tokens[k].value);
    // `eval` は後ろ全部を1つのコマンドとして読む（`eval git add -A` も `eval "git add -A"` も）
    if (name === "eval") return join(k + 1);
    if (SHELL_DASH_C.test(name)) {
      for (let j = k + 1; j < tokens.length; j++) {
        // **束も見る**（実測: `bash -lc "git stash"` が素通りしていた）。
        // 束のどこに `c` があっても次を本体と読む —— 誤検知側に倒す
        if (isDashC(tokens[j].value)) return join(j + 1);
        if (!tokens[j].value.startsWith("-")) return null; // スクリプト名
      }
      return null;
    }
    if (!COMMAND_WRAPPERS.has(name)) return null;
    k = skipWrapperFlags(tokens, k, name);
  }
  return null;
}

/**
 * **二重引用符の中のコマンド置換**を取り出す（H71 ①）。
 *
 * 引用符の外の `$( … )` は `(` `)` が区切り文字なので `scanCommands` が既に割る。
 * 割れないのは**引用符の中**で、`echo "$(git add -A)"` が素通りしていた（実測）。
 *
 * ヒアドキュメントの本文は `maskHereBodies` が先に潰しているので、
 * `git commit -m "$(cat <<'EOF' … EOF)"` の本文は走査に入らない。
 */
function quotedSubstitutions(text, opts) {
  const { escape } = dialect(opts);
  const s = String(text || "");
  const out = [];
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === escape) {
        i++;
        continue;
      }
      if (c === '"') {
        quote = null;
        continue;
      }
      if (c === "$" && s[i + 1] === "(") {
        let depth = 0;
        let j = i + 1;
        for (; j < s.length; j++) {
          if (s[j] === "(") depth++;
          else if (s[j] === ")" && --depth === 0) break;
        }
        if (j < s.length) {
          out.push(s.slice(i + 2, j));
          i = j;
        }
        continue;
      }
      if (c === "`" && escape !== "`") {
        const end = s.indexOf("`", i + 1);
        if (end > 0) {
          out.push(s.slice(i + 1, end));
          i = end;
        }
        continue;
      }
      continue;
    }
    if (c === "'" || c === '"') quote = c;
  }
  return out;
}

/**
 * `git` のサブコマンドより前のグローバルオプション（`-c x=y` / `-C dir` / `--no-pager`）を飛ばす。
 *
 * **オプションはトークン単位で飛ばす**（H47 ①③）。初版は正規表現の選択肢を順に当てていたため、
 * `git -C "D:/my proj" push` が空白で切れて `sub` が `proj` になるなどの取りこぼしがあった。
 *
 * `argv` は**引用符を外したトークン列**で、`args` は生の文字列（文面に使う）。
 * **判定は `argv` を見る**（H72。生の文字列を見ると引用符の中の `--` や `--all` に誤ヒットする）。
 */
function parseGit(seg, opts) {
  const text = String(seg.text || "").replace(ENV_ASSIGN_PREFIX, "");
  const tokens = tokenize(text, opts);
  // **包むコマンドとパス付きの形を越えて `git` を探す**（H70）
  const gi = gitTokenIndex(tokens);
  if (gi < 0) return null;

  let i = gi + 1;
  while (i < tokens.length && tokens[i].value.startsWith("-")) {
    // 値が同じトークンに付いている形（`-cuser.name=x` / `--git-dir=x`）は1つだけ飛ばす
    i += GIT_GLOBAL_VALUE_OPTS.has(tokens[i].value) ? 2 : 1;
  }

  const sub = tokens[i];
  if (!sub || !/^[a-zA-Z][\w-]*$/.test(sub.value)) return null;
  return {
    index: seg.index,
    sub: sub.value,
    args: text.slice(sub.end).trim(),
    argv: tokens.slice(i + 1).map((t) => t.value),
  };
}

/** 入れ子を追う深さの上限（`bash -c "bash -c \"…\""` のような形で止まらなくなるのを防ぐ） */
const MAX_NEST_DEPTH = 4;

/**
 * コマンド位置に現れた git 呼び出しをすべて返す。
 *
 * **引用符の内側にも一段入る**（H69 / H71 ①）。`bash -c "…"` / `eval "…"` の本体と、
 * 二重引用符の中のコマンド置換を、同じ規則で読み直す。
 * 入れ子から拾ったものは `nested: true` を持ち、`index` は外側の断片の位置になる。
 */
function gitInvocations(cmd, opts, depth) {
  const d = depth || 0;
  const out = [];
  for (const seg of scanCommands(cmd, opts)) {
    const g = parseGit(seg, opts);
    if (g) out.push(g);
    if (d >= MAX_NEST_DEPTH) continue;
    const inner = wrappedCommand(seg.text, opts);
    const nested = inner === null ? [] : [inner];
    nested.push(...quotedSubstitutions(seg.text, opts));
    for (const n of nested) {
      for (const h of gitInvocations(n, opts, d + 1)) {
        out.push({ ...h, index: seg.index, nested: true });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 個々の判定
// ---------------------------------------------------------------------------

const hasFlag = (args, re) => re.test(args);

/**
 * サブコマンドごとの、**次のトークンを値として取る**オプション。
 *
 * ⚠️ **全サブコマンド共通の表にしてはいけない。** 同じ綴りで意味が違う ——
 * `-e` は `clean` では除外パターンの値を取るが、`add` では `--edit` で値を取らない。
 * 一律に値ありとすると **`git add -e .` の `.` を値として飲み、見逃す**
 * （H70 の `WRAPPER_VALUE_FLAGS` と同じ理由）。
 *
 * **宣言しなかったオプションの値は被演算子として読まれる** ——
 * つまり**誤検知側に倒れる**ので、迷ったら足さない。
 * ただし `stash` の `-m` は逆で、**宣言しないと値が `show` のとき通してしまう**
 * （実測: `git stash -m show` が deny を素通りしていた）。
 */
const GIT_VALUE_ARGS = {
  add: new Set(["--chmod", "--pathspec-from-file"]),
  commit: new Set([
    "-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message",
    "--author", "--date", "--cleanup", "-t", "--template", "--fixup", "--squash",
    "--trailer", "--pathspec-from-file",
  ]),
  stash: new Set(["-m", "--message", "--pathspec-from-file"]),
  clean: new Set(["-e", "--exclude"]),
  checkout: new Set([
    "-s", "--source", "--conflict", "-b", "-B", "--orphan", "-t", "--track", "--pathspec-from-file",
  ]),
  restore: new Set(["-s", "--source", "--conflict", "--pathspec-from-file"]),
};

const NO_VALUE_ARGS = new Set();

/**
 * 引数のトークンを**オプション・被演算子・`--` 以降のパス指定**に分ける（H72）。
 *
 * 生の文字列を正規表現で見ていたため、次が割れていた（いずれも実測）。
 *
 * | 形 | 生の文字列での結果 |
 * |---|---|
 * | `git commit -m "a -- b"` | メッセージ中の `--` を区切りと読み、**警告が出なかった** |
 * | `git commit --` | 区切りだけでパス指定が無いのに「指定あり」。**警告が出なかった** |
 * | `git commit -m "docs: --all を禁じる"` | メッセージ中の `--all` で **deny された**（誤検知） |
 * | `git add -- "a -A b.txt"` | ファイル名の中の `-A` で **deny された**（誤検知） |
 */
function splitArgs(g) {
  const value = GIT_VALUE_ARGS[g.sub] || NO_VALUE_ARGS;
  const opts = [];
  const operands = [];
  const pathspecs = [];
  let sep = false;
  const argv = g.argv || [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (sep) {
      pathspecs.push(a);
      continue;
    }
    if (a === "--") {
      sep = true;
      continue;
    }
    if (a.length > 1 && a.startsWith("-")) {
      opts.push(a);
      if (value.has(a)) i++; // 値は被演算子に数えない
      continue;
    }
    operands.push(a);
  }
  return { opts, operands, pathspecs, sep };
}

/** 長いオプションがあるか。`=` 付き（`--all=x`）は別物として扱う（git 自身がエラーにする） */
const hasOpt = (opts, name) => opts.includes(name);

/** 短縮オプションの束に文字が含まれるか（`-am` の `a`）。**長いオプションには当たらない** */
const inShortBundle = (opts, ch) =>
  opts.some((o) => /^-[A-Za-z]+$/.test(o) && o.slice(1).includes(ch));

/** 「範囲まるごと」を指すパス指定 */
const WHOLE_SCOPE = new Set([".", "./", ":/", ":/.", "*", ":/*"]);
const isWholeScope = (p) => WHOLE_SCOPE.has(p);

/** 確認だけの形（`--dry-run` / `-n`）。**実行しないので通す** */
const isDryRun = (a) => hasOpt(a.opts, "--dry-run") || inShortBundle(a.opts, "n");

/** `git add` に「範囲まるごと」の指定が付いているか */
function isBlockedAdd(command, opts) {
  return gitInvocations(command, opts).some((g) => {
    if (g.sub !== "add") return false;
    const a = splitArgs(g);
    if (isDryRun(a)) return false;
    // **束も見る**（実測: `git add -Av` が素通りしていた）
    if (hasOpt(a.opts, "--all") || inShortBundle(a.opts, "A")) return true;
    return a.operands.some(isWholeScope) || a.pathspecs.some(isWholeScope);
  });
}

/** `git commit -a` / `-am` / `--all`（追跡済みを全部巻き込む） */
function isBlockedCommitAll(command, opts) {
  return gitInvocations(command, opts).some((g) => {
    if (g.sub !== "commit") return false;
    const a = splitArgs(g);
    return inShortBundle(a.opts, "a") || hasOpt(a.opts, "--all");
  });
}

/** 退避する形の `git stash`（`list` / `show` / `pop` / `apply` / `drop` は読み出し・復元なので通す） */
const STASH_SAFE = new Set(["list", "show", "pop", "apply", "drop", "branch", "clear"]);
function isBlockedStash(command, opts) {
  return gitInvocations(command, opts).some((g) => {
    if (g.sub !== "stash") return false;
    return !STASH_SAFE.has(splitArgs(g).operands[0] || "");
  });
}

/** 範囲指定なしの破棄（`checkout -- .` / `restore .` / パス指定なしの `clean`） */
function isBlockedDiscard(command, opts) {
  return gitInvocations(command, opts).some((g) => {
    if (g.sub === "checkout" || g.sub === "restore") {
      const a = splitArgs(g);
      // `--` の前は「どこから戻すか」（`git checkout HEAD -- .`）なので、
      // 区切りがあるときは後ろだけを見る
      return a.sep ? a.pathspecs.some(isWholeScope) : a.operands.some(isWholeScope);
    }
    if (g.sub === "clean") {
      const a = splitArgs(g);
      if (isDryRun(a)) return false; // 確認だけなら通す
      const targets = a.sep ? a.pathspecs : a.operands;
      // **パス指定が1つも無ければ作業ツリー全体が対象**
      return targets.length === 0 || targets.some(isWholeScope);
    }
    return false;
  });
}

/**
 * パス指定の区切り（単独の `--`）があり、**その後ろにパス指定が1つ以上ある**か。
 *
 * **`args.includes("--")` ではいけない**（H49）。あれは**長いオプションに当たる** ——
 * `--no-verify` / `--quiet` / `--signoff` があるだけで「パス指定あり」と誤判定する。
 *
 * **生の文字列を見てもいけない**（H72）。`-m "a -- b"` のメッセージ中の `--` に当たる。
 * **後ろが空の `git commit --` も「指定あり」ではない**（インデックス全体が入る）。
 */
const hasPathspecSep = (a) => a.sep && a.pathspecs.length > 0;

/** `--pathspec-from-file` でパスを渡す形（`--` を使わないパス指定） */
const hasPathspecFile = (a) =>
  a.opts.some((o) => o === "--pathspec-from-file" || o.startsWith("--pathspec-from-file="));

/**
 * パス指定なしの `git commit`。**deny しない**（`git add <path>` の直後など正当な使い方がある）。
 * 警告に留めるのは R4 の明示的な指示。
 */
function isUnscopedCommit(command, opts) {
  return gitInvocations(command, opts).some((g) => {
    if (g.sub !== "commit") return false;
    const a = splitArgs(g);
    return (
      !hasPathspecSep(a) &&
      !hasPathspecFile(a) &&
      !inShortBundle(a.opts, "a") &&
      !hasOpt(a.opts, "--all") &&
      !hasOpt(a.opts, "--amend") &&
      !hasOpt(a.opts, "--dry-run")
    );
  });
}

/**
 * パス指定なしの `git commit --amend`（H32）。
 *
 * **`--amend` もインデックス全体を取り込む。** `add -A` / `commit -a` は deny しているのに、
 * `--amend` は素通りしていた。自分の直前のコミットを直すのは正当な操作なので deny はしないが、
 * **`add -A` と同じ実害が出うる**ことは伝える。
 *
 * > **実測（2026-08-20）**: パス指定で正しく2ファイルだけコミットした直後、
 * > メッセージの誤字を直すために `--amend` したところ、**その数秒の間に別セッションが
 * > `git mv` でステージしていたリネーム2件を巻き込んだ**。
 * > 復旧の過程で、`git add` でステージし直すと `.gitattributes` により **CRLF が LF へ正規化され、
 * > 他セッションがステージした blob と変わる**ことも分かった（`git update-index --cacheinfo` が要る）。
 */
/** いまステージされているものの一覧（取れなければ空文字） */
function stagedSummary() {
  try {
    const out = execSync("git diff --cached --name-only", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return out ? `現在ステージされているもの:\n${out}\n` : "";
  } catch {
    return "";
  }
}

/**
 * ⚠️ **この判定は `repo-guard` 側にしか無い**（`git-scope` には複製しない。H73）。
 * `--amend` の警告は**このリポジトリ自身の規律**で、配布物の `pre-commit-scope` は出さない。
 * 共有領域の外にあるので、**ソース突き合わせ検査では守られない** ——
 * 中で使う `splitArgs` / `hasPathspecSep` の形が変わったら、ここも手で直すこと。
 */
function isAmendCommit(command, opts) {
  return gitInvocations(command, opts).some((g) => {
    if (g.sub !== "commit") return false;
    const a = splitArgs(g);
    return (
      hasOpt(a.opts, "--amend") &&
      !hasPathspecSep(a) &&
      !hasPathspecFile(a) &&
      !hasOpt(a.opts, "--dry-run")
    );
  });
}

// ---------------------------------------------------------------------------
// 版番号の上げ忘れ（R16）
// ---------------------------------------------------------------------------

/**
 * 変更されたパスから、触られたプラグイン名を拾う。
 *
 * @param {string[]} changedPaths リポジトリルートからの相対パス（`/` 区切り）
 */
function pluginsTouched(changedPaths) {
  const out = new Set();
  for (const p of changedPaths || []) {
    const m = /^plugins\/([^/]+)\//.exec(String(p).replace(/\\/g, "/"));
    if (m) out.add(m[1]);
  }
  return [...out];
}

/**
 * **中身を変えたのに版を据え置いたプラグイン**を返す（R16）。
 *
 * `claude plugin validate --strict` は `marketplace.json` と `plugin.json` の
 * **一致しか見ない**ため、「触ったのに上げていない」は検出できない。
 * `CLAUDE.md` §2 は「プラグインを触ったら2ファイルとも版を上げる」と定めているのに、
 * **検査の対象が規約を覆っていなかった**（H19 / R4 と同じ形）。
 *
 * > 実測: 第1便（`9e240dc`）は3本のプラグインファイルを変更して版を1つも上げず、
 * > push ゲートを通った。後続の便が上げたため結果的に配信されたが、
 * > **そこで止めていれば誰にも届いていない**。
 *
 * @param {string[]} touched 触られたプラグイン名
 * @param {Record<string,string|null>} before 送信先が持っている版（未知なら null）
 * @param {Record<string,string|null>} after これから送る版
 * @returns {string[]} 版が変わっていないプラグイン名
 */
function pluginsMissingBump(touched, before, after) {
  return (touched || []).filter((name) => {
    const b = before?.[name] ?? null;
    const a = after?.[name] ?? null;
    if (b === null) return false; // 新規プラグインは対象外
    if (a === null) return false; // 削除されたなら版は問わない
    return b === a;
  });
}

/** `git push` の出現位置（無ければ -1）。対象ディレクトリの解決に位置が要る */
function findPush(command, opts) {
  const g = gitInvocations(command, opts).find((x) => x.sub === "push");
  return g ? g.index : -1;
}

/**
 * `git push` が実際に作用するディレクトリを解く。
 *
 * ⚠️ **`cd` は「最初の1つ」ではなく「push より前の最後の1つ」を採る。**
 * `cd A && ... && cd B && git push` で最初の `cd A` を採ると、
 * **A を検査して B へ push する**という最悪の取り違えが起きる（2026-08-16・初版の欠陥）。
 *
 * ⚠️ **残る穴**: Bash ツールの作業ディレクトリは呼び出しをまたいで保持されるが、
 * フックは**そのコマンド文字列しか見えない**。前の呼び出しで `cd` して、
 * 次の呼び出しで裸の `git push` を打つと `CLAUDE_PROJECT_DIR` に落ちて**取り違える**。
 * 対象リポジトリへの操作は **`cd X && git push` を1コマンドにまとめる**こと。
 */
function resolveTargetDir(cmd, at, opts) {
  // `git -C X push` は push 自身に付くので最優先。
  // **トークン単位で読む**（H47 ①）。空白入りのパス（`git -C "D:/my proj" push`）を
  // 正規表現の \S+ で拾うと途中で切れる
  const tokens = tokenize(String(cmd).slice(at), opts);
  if (tokens.length && tokens[0].value === "git") {
    let viaC = null;
    for (let i = 1; i < tokens.length && tokens[i].value.startsWith("-"); ) {
      const v = tokens[i].value;
      if (v === "-C" && tokens[i + 1]) viaC = tokens[i + 1].value;
      else if (v.startsWith("-C") && v.length > 2) viaC = v.slice(2);
      i += GIT_GLOBAL_VALUE_OPTS.has(v) ? 2 : 1;
    }
    if (viaC) {
      const d = toNativePath(viaC);
      if (fs.existsSync(d)) return d;
    }
  }

  // push より前の**コマンド位置**にある `cd` のうち最後のもの
  let last = null;
  for (const seg of scanCommands(cmd, opts)) {
    if (seg.index >= at) break;
    const m = /^cd\s+("[^"]+"|'[^']+'|\S+)/.exec(seg.text);
    if (m) last = m[1];
  }
  if (last) {
    const d = toNativePath(last);
    if (fs.existsSync(d)) return d;
  }

  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

const PATH_RULE =
  "代わりに次のどちらかを使ってください:\n" +
  "  git commit -- <path...>            # ステージせずに直接コミット\n" +
  "  git add <path...> && git commit    # 対象を明示してステージ\n\n" +
  "**まず `git status --short` で、自分が触っていないファイルが無いか確認すること。**";

const WHY =
  "**コミットは必ずパス指定**です（`claude-dev-harness/CLAUDE.md` §1）。\n" +
  "このリポジトリは**複数のセッションが同時に触る**ため、範囲をまるごと指定すると\n" +
  "**他のエージェント／セッションが未コミットで置いている変更を巻き込みます**。\n" +
  "`6c68d30` では別セッションの20ファイルを巻き込んだまま push まで到達しました。\n\n";

/** 対象ディレクトリで git を叩く。失敗は空文字（判定材料が無いことは呼び出し側が扱う） */
function gitIn(dir, args) {
  try {
    return execSync(`git ${args}`, {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    }).trim();
  } catch {
    return "";
  }
}

/** `<ref>:plugins/<name>/.claude-plugin/plugin.json` の版（読めなければ null） */
function versionAt(dir, ref, name) {
  const raw = gitIn(dir, `show ${ref}:plugins/${name}/.claude-plugin/plugin.json`);
  if (!raw) return null;
  try {
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}

/**
 * これから送るコミットに「中身を変えたのに版を上げていないプラグイン」が無いか（R16）。
 *
 * **判定できないときは黙って通さない**（H16 の教訓）。警告を出してから続行する。
 */
function checkVersionBump(dir) {
  const base = gitIn(dir, "rev-parse --abbrev-ref @{upstream}") || gitIn(dir, "symbolic-ref --short refs/remotes/origin/HEAD");
  if (!base) {
    warn(
      "[repo-guard] 送信先が特定できないため、**版番号の上げ忘れを検査していません**。\n" +
        "`plugins/` を触ったなら `plugin.json` と `.claude-plugin/marketplace.json` の**両方**を上げたか自分で確かめてください。"
    );
    return;
  }

  const changed = gitIn(dir, `diff --name-only ${base}..HEAD`)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!changed.length) return;

  const touched = pluginsTouched(changed);
  if (!touched.length) return;

  const before = {};
  const after = {};
  for (const name of touched) {
    before[name] = versionAt(dir, base, name);
    after[name] = versionAt(dir, "HEAD", name);
  }

  const missing = pluginsMissingBump(touched, before, after);
  if (!missing.length) return;

  deny(
    `版番号を上げずにプラグインを変更しています（${missing.join(" / ")}）`,
    "**プラグインを触ったら版を上げる**（`CLAUDE.md` §2）。\n\n" +
      missing.map((n) => `- \`${n}\` — 中身は変わっているのに \`${after[n]}\` のまま`).join("\n") +
      "\n\n**中身だけ変えても利用側には届きません。** 上げるのは2ファイル:\n\n" +
      missing
        .map((n) => `  plugins/${n}/.claude-plugin/plugin.json\n  .claude-plugin/marketplace.json の plugins[].version`)
        .join("\n") +
      "\n\n> `claude plugin validate --strict` は**2ファイルの一致しか見ない**ため、\n" +
      "> 「触ったのに上げていない」は検出できません。**第1便（`9e240dc`）が実際にこれで通りました。**\n" +
      "> 意図的に据え置く場合（テンプレート層だけの変更など）は、その旨を伝えてください。"
  );
}

function main() {
  const payload = readPayload();
  if (!payload) process.exit(0);

  const command = payload?.tool_input?.command || "";
  if (!command) process.exit(0);

  // PowerShell ツールは bash とエスケープ文字が違う（H47 ②）。
  // 読み方を間違えると引用符の終わりを見失い、**後続のコマンドを見落とす**
  const opts = { shell: /powershell|pwsh/i.test(payload?.tool_name || "") ? "powershell" : "bash" };

  // --- 1. 範囲まるごとの操作を止める（どのリポジトリでも） -------------------
  if (isBlockedAdd(command, opts)) {
    deny("git add -A / git add . は使えません", WHY + PATH_RULE);
  }
  if (isBlockedCommitAll(command, opts)) {
    deny(
      "git commit -a / -am は使えません",
      WHY +
        "`-a` は**追跡済みファイルを全部**巻き込むので、`git add -A` と実害がほぼ同じです。\n\n" +
        PATH_RULE
    );
  }
  if (isBlockedStash(command, opts)) {
    deny(
      "git stash は使えません",
      "`git stash` は**他セッションの変更ごと退避**してしまいます（`CLAUDE.md` §1）。\n" +
        "自分の変更だけを退避したいなら、パスを指定してコミットするか、\n" +
        "`git stash push -- <path...>` のように対象を明示してください。\n\n" +
        "読み出し・復元（`list` / `show` / `pop` / `apply` / `drop`）は止めていません。"
    );
  }
  if (isBlockedDiscard(command, opts)) {
    deny(
      "範囲指定なしの破棄は使えません",
      "`git checkout -- .` / `git restore .` / パス指定なしの `git clean` は、\n" +
        "**他セッションの未コミットの変更まで消します**（`CLAUDE.md` §1）。\n\n" +
        "対象を明示してください（例: `git restore -- src/x.ts`）。\n" +
        "何が消えるか確かめるだけなら `git clean -n` は通ります。"
    );
  }

  // 警告のみ（deny しない）。正当な使い方があるため
  if (isUnscopedCommit(command, opts)) {
    const staged = (() => {
      try {
        return execSync("git diff --cached --name-only", {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
        }).trim();
      } catch {
        return "";
      }
    })();
    warn(
      "パス指定なしの `git commit` です。**インデックスにある変更が全部入ります。**\n" +
        (staged
          ? `現在ステージされているもの:\n${staged}\n\n`
          : "（ステージされている変更を取得できませんでした）\n\n") +
        "自分が触った覚えのないファイルが混ざっていないか確認してください（`CLAUDE.md` §1）。"
    );
  }

  // 警告のみ（deny しない）。自分の直前のコミットを直すのは正当な操作
  if (isAmendCommit(command, opts)) {
    warn(
      "パス指定なしの `git commit --amend` です。**インデックスにある変更が全部入ります。**\n" +
        `${stagedSummary()}\n` +
        "**直前のコミットを書き換えるので、巻き込んでも差分に現れず気づきにくい。**\n" +
        "他セッションが `git add` / `git mv` した直後だと、その分まで取り込みます（H32・実測で事故）。\n\n" +
        "メッセージだけ直すなら、先に `git status --short` で確認してください。"
    );
  }

  // --- 2. push 前に marketplace の整合を検査する -----------------------------
  //
  // 対象ディレクトリが marketplace を持つリポジトリのときだけ走る。
  // ProjectTemplete など普通のリポジトリへの push は素通りする。
  const pushAt = findPush(command, opts);
  if (pushAt >= 0) {
    const dir = resolveTargetDir(command, pushAt, opts);
    if (!fs.existsSync(path.join(dir, ".claude-plugin", "marketplace.json"))) process.exit(0);

    // --- 2-1. 版番号の上げ忘れ（R16） ---------------------------------------
    checkVersionBump(dir);

    let output = "";
    let failure = null; // "validate" | "missing-claude"

    // ⚠️ **理由を取り違えない**（R5）。`claude` が無いのを「版番号の上げ忘れ」と
    //    言うと、`CLAUDE.md` §8 が戒めている「想定した原因と実物の食い違い」を
    //    ガード自身が誘発する。**実行する前に、あるかどうかを確かめる。**
    if (!hasCommand("claude")) {
      failure = "missing-claude";
    } else {
      try {
        execSync("claude plugin validate . --strict", {
          cwd: dir,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120000,
        });
      } catch (e) {
        output = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
        failure = "validate";
      }
    }

    if (failure === "missing-claude") {
      deny(
        "検査コマンド（claude）が見つからず、push 前の検証ができませんでした",
        "**版番号の問題ではありません。** `claude` が PATH に無いため\n" +
          "`claude plugin validate . --strict` を実行できませんでした。\n\n" +
          "対処:\n" +
          "  - `claude` を PATH に通してから push し直す\n" +
          "  - どうしても実行できない環境なら、**手元で整合を確認してから**\n" +
          "    `plugin.json` と `.claude-plugin/marketplace.json` の版が一致していることを目視で確かめる"
      );
    }

    if (failure === "validate") {
      deny(
        `claude plugin validate --strict が通っていません（${dir}）`,
        "push 前の検査に失敗しました。**公開前に直してください。**\n\n" +
          "```\n" +
          String(output).trim().split("\n").slice(0, 25).join("\n") +
          "\n```\n\n" +
          "よくある原因は **版番号の上げ忘れ**です。版を上げるときは\n" +
          "`plugins/<name>/.claude-plugin/plugin.json` と `.claude-plugin/marketplace.json` の**両方**を\n" +
          "上げること（`CLAUDE.md` §2 / 関門1）。`076d5dd` と `6c68d30` で2版連続で漏れました。\n\n" +
          "> 版がずれても配信自体は止まりません（install 時は plugin.json が勝つ）。\n" +
          "> **カタログの表示が黙って嘘になる**のが実害です。"
      );
    }
  }

  process.exit(0);
}

// フックとして起動されたときだけ実行する。
// `require` されたとき（テスト）は判定関数だけを取り出せるようにしておく。
if (require.main === module) main();

module.exports = {
  scanCommands,
  tokenize,
  parseGit,
  gitInvocations,
  isBlockedAdd,
  isBlockedCommitAll,
  isBlockedStash,
  isBlockedDiscard,
  isUnscopedCommit,
  isAmendCommit,
  pluginsTouched,
  pluginsMissingBump,
  findPush,
  resolveTargetDir,
  toNativePath,
  hasCommand,
};
