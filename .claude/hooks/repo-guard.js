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
      const m = /^<<(-?)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w]*))/.exec(s.slice(i));
      if (m) {
        const delim = m[2] || m[3] || m[4];
        const bodyStart = s.indexOf("\n", i + m[0].length);
        if (bodyStart < 0) return out.join("");
        // **導入部（`<<'EOF'`）も潰す。** 残すとコマンド文に `<<'EOF'` が居座り、
        // `-- <path>` の後ろに来たときに**パス指定として読まれうる**
        // （`git commit -F - -- CLAUDE.md <<'EOF'` のパス指定が2つに見える）。
        const end = findTerminator(s, bodyStart + 1, delim, m[1] === "-");
        blank(i, end);
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

/**
 * パス指定の区切り `--` があるか。
 *
 * **`args.includes("--")` ではいけない。** `--amend` / `--no-verify` のような
 * **長いオプション名の中の `--` に誤ヒットする**（実測: `git commit --amend` が
 * 「パス指定あり」と判定され、H32 の警告が一度も鳴らなかった）。
 * 区切りは**単独のトークン**なので、前後が空白か端であることまで見る。
 */
const hasPathspecSep = (args) => /(^|\s)--(\s|$)/.test(args);
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
 *
 * `--amend` はここでは扱わない（文面が違うため `isAmendCommit` が別に見る）。
 */
function isUnscopedCommit(command, opts) {
  return gitInvocations(command, opts).some(
    (g) =>
      g.sub === "commit" &&
      !hasPathspecSep(g.args) &&
      !inBundle(g.args, "a") &&
      !hasFlag(g.args, /(^|\s)--all(\s|$)/) &&
      !hasFlag(g.args, /(^|\s)(--amend|--dry-run)(\s|$)/)
  );
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

function isAmendCommit(command, opts) {
  return gitInvocations(command, opts).some(
    (g) =>
      g.sub === "commit" &&
      hasFlag(g.args, /(^|\s)--amend(\s|$)/) &&
      !hasPathspecSep(g.args) &&
      !hasFlag(g.args, /(^|\s)--dry-run(\s|$)/)
  );
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
