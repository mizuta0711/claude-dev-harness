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

/**
 * 引用符・エスケープを解釈しながら、**コマンド位置から始まる断片**を列挙する。
 *
 * 引用符の内側は**1つの断片にもならない**ので、`echo 'git add -A'` は拾われない。
 *
 * @returns {{index: number, text: string}[]} index はコマンド語の開始位置
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
    if (SEPARATORS.has(c)) {
      flush(i);
      start = i + 1;
    }
  }
  flush(s.length);
  return out;
}

/**
 * 断片が `git` の呼び出しなら `{ index, sub, args }` を返す（違えば null）。
 *
 * 先頭の環境変数代入（`FOO=bar git ...`）と、
 * サブコマンドより前のグローバルオプション（`-c x=y` / `-C dir` / `--no-pager`）を飛ばす。
 */
function parseGit(seg) {
  let t = seg.text.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
  const head = /^git(?:\s|$)/.exec(t);
  if (!head) return null;
  let rest = t.slice(head[0].length).trim();

  const globalOpt = /^(?:-[cC]\s+\S+|-[cC]\S+|-C\s+(?:"[^"]*"|'[^']*'|\S+)|--[a-z-]+(?:=\S+)?)\s*/;
  for (let g; (g = globalOpt.exec(rest)) !== null; ) rest = rest.slice(g[0].length);

  const m = /^([a-zA-Z][\w-]*)\s*([\s\S]*)$/.exec(rest);
  if (!m) return null;
  return { index: seg.index, sub: m[1], args: m[2].trim() };
}

/** コマンド位置に現れた git 呼び出しをすべて返す */
function gitInvocations(cmd) {
  return scanCommands(cmd)
    .map(parseGit)
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
function isBlockedAdd(command) {
  return gitInvocations(command).some(
    (g) =>
      g.sub === "add" &&
      !hasFlag(g.args, /(^|\s)(--dry-run|-n)(\s|$)/) &&
      hasFlag(g.args, /(^|\s)(-A|--all|\.|:\/)(\s|$)/)
  );
}

/** `git commit -a` / `-am` / `--all`（追跡済みを全部巻き込む） */
function isBlockedCommitAll(command) {
  return gitInvocations(command).some(
    (g) => g.sub === "commit" && (inBundle(g.args, "a") || hasFlag(g.args, /(^|\s)--all(\s|$)/))
  );
}

/** 退避する形の `git stash`（`list` / `show` / `pop` / `apply` / `drop` は読み出し・復元なので通す） */
const STASH_SAFE = new Set(["list", "show", "pop", "apply", "drop", "branch", "clear"]);
function isBlockedStash(command) {
  return gitInvocations(command).some(
    (g) => g.sub === "stash" && !STASH_SAFE.has(firstOperand(g.args))
  );
}

/** 範囲指定なしの破棄（`checkout -- .` / `restore .` / パス指定なしの `clean`） */
function isBlockedDiscard(command) {
  return gitInvocations(command).some((g) => {
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
function isUnscopedCommit(command) {
  return gitInvocations(command).some(
    (g) =>
      g.sub === "commit" &&
      !g.args.includes("--") &&
      !inBundle(g.args, "a") &&
      !hasFlag(g.args, /(^|\s)--all(\s|$)/) &&
      !hasFlag(g.args, /(^|\s)(--amend|--dry-run)(\s|$)/)
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
function findPush(command) {
  const g = gitInvocations(command).find((x) => x.sub === "push");
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
function resolveTargetDir(cmd, at) {
  // `git -C X push` は push 自身に付くので最優先
  const viaC = String(cmd)
    .slice(at)
    .match(/^git\s+(?:-[cC]\s*\S+\s+|--\S+\s+)*-C\s+("[^"]+"|'[^']+'|\S+)/);
  if (viaC) {
    const d = toNativePath(viaC[1]);
    if (fs.existsSync(d)) return d;
  }

  // push より前の**コマンド位置**にある `cd` のうち最後のもの
  let last = null;
  for (const seg of scanCommands(cmd)) {
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

  // --- 1. 範囲まるごとの操作を止める（どのリポジトリでも） -------------------
  if (isBlockedAdd(command)) {
    deny("git add -A / git add . は使えません", WHY + PATH_RULE);
  }
  if (isBlockedCommitAll(command)) {
    deny(
      "git commit -a / -am は使えません",
      WHY +
        "`-a` は**追跡済みファイルを全部**巻き込むので、`git add -A` と実害がほぼ同じです。\n\n" +
        PATH_RULE
    );
  }
  if (isBlockedStash(command)) {
    deny(
      "git stash は使えません",
      "`git stash` は**他セッションの変更ごと退避**してしまいます（`CLAUDE.md` §1）。\n" +
        "自分の変更だけを退避したいなら、パスを指定してコミットするか、\n" +
        "`git stash push -- <path...>` のように対象を明示してください。\n\n" +
        "読み出し・復元（`list` / `show` / `pop` / `apply` / `drop`）は止めていません。"
    );
  }
  if (isBlockedDiscard(command)) {
    deny(
      "範囲指定なしの破棄は使えません",
      "`git checkout -- .` / `git restore .` / パス指定なしの `git clean` は、\n" +
        "**他セッションの未コミットの変更まで消します**（`CLAUDE.md` §1）。\n\n" +
        "対象を明示してください（例: `git restore -- src/x.ts`）。\n" +
        "何が消えるか確かめるだけなら `git clean -n` は通ります。"
    );
  }

  // 警告のみ（deny しない）。正当な使い方があるため
  if (isUnscopedCommit(command)) {
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

  // --- 2. push 前に marketplace の整合を検査する -----------------------------
  //
  // 対象ディレクトリが marketplace を持つリポジトリのときだけ走る。
  // ProjectTemplete など普通のリポジトリへの push は素通りする。
  const pushAt = findPush(command);
  if (pushAt >= 0) {
    const dir = resolveTargetDir(command, pushAt);
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
  parseGit,
  gitInvocations,
  isBlockedAdd,
  isBlockedCommitAll,
  isBlockedStash,
  isBlockedDiscard,
  isUnscopedCommit,
  pluginsTouched,
  pluginsMissingBump,
  findPush,
  resolveTargetDir,
  toNativePath,
  hasCommand,
};
