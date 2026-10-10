import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "plugins", "harness-core", "hooks", "scripts");

// 配布物側（利用側プロジェクトへ配る）
const scope = require(path.join(ROOT, "plugins", "harness-core", "hooks", "scripts", "git-scope.js"));
// リポジトリ固有側（このリポジトリを守る）
const guard = require(path.join(ROOT, ".claude", "hooks", "repo-guard.js"));

// **同じ判定が2箇所にある。** repo-guard は「配布物のプラグインに自分の規律を
// 依存させない」方針のため独立している（H19）。重複は意図的だが、
// **片方だけ直るリスク**が残るので、同じケースを両方に当てて乖離した瞬間に落とす。
//
// `isGitCommit` の core / unity 複製に対して is-git-commit.test.mjs がやっているのと同じ形。

const CASES = [
  // 止める
  "git add -A",
  "git add .",
  "git add --all",
  "git add :/",
  "git status && git add -A",
  "git commit -a",
  'git commit -am "x"',
  "git commit --all -m x",
  "git stash",
  "git stash push",
  "git stash -u",
  "git checkout -- .",
  "git restore .",
  "git clean -fd",
  // 通す
  "git add src/foo.ts",
  "git add -p",
  "git add -A --dry-run",
  "git commit -m x",
  "git commit -- src/a.ts",
  "git commit --amend",
  "git stash list",
  "git stash pop",
  "git checkout -- src/x.ts",
  "git checkout master",
  "git clean -fd tests/",
  "git clean -n",
  "git push origin master",
  "ls -la",
  // 発火してはいけない形（R3）
  `echo 'git add -A'`,
  `node -e "console.log('git commit -a')"`,
  "ls # git stash は使わない",
  ["cat <<'EOF'", "git add -A", "EOF"].join("\n"),
];

const PREDICATES = [
  "isBlockedAdd",
  "isBlockedCommitAll",
  "isBlockedStash",
  "isBlockedDiscard",
  "isUnscopedCommit",
];

test("git-scope と repo-guard の判定が乖離していない", () => {
  for (const fn of PREDICATES) {
    for (const cmd of CASES) {
      assert.equal(
        scope[fn](cmd),
        guard[fn](cmd),
        `乖離: ${fn}(${JSON.stringify(cmd)})`
      );
    }
  }
});

test("git-scope: 配布物側だけでも期待どおりに判定する", () => {
  assert.equal(scope.isBlockedAdd("git add -A"), true);
  assert.equal(scope.isBlockedAdd("git add src/a.ts"), false);
  assert.equal(scope.isBlockedCommitAll("git commit -am x"), true);
  assert.equal(scope.isBlockedStash("git stash"), true);
  assert.equal(scope.isBlockedStash("git stash pop"), false);
  assert.equal(scope.isBlockedDiscard("git clean -fd"), true);
  assert.equal(scope.isBlockedDiscard("git clean -n"), false);
});

test("git-scope: 引用符・コメント・ヒアドキュメントでは発火しない", () => {
  const benign = [
    `echo 'git add -A'`,
    `grep -n "git commit -a" CLAUDE.md`,
    "ls # git stash は使わない",
    ["cat <<'EOF' > note.md", "git add -A を使わないこと", "EOF"].join("\n"),
  ];
  for (const cmd of benign) {
    for (const fn of PREDICATES) {
      assert.equal(scope[fn](cmd), false, `${fn} が発火: ${JSON.stringify(cmd)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// H47: グローバルオプションとシェルの方言の取りこぼし（2026-10-02 の査読 M2 / M3 / L4）
//
// いずれも**ガードが素通りする**側の取りこぼしで、旧 `permissions.ask` でも拾えていなかった。
// 3件とも 2026-10-02 に再現を確認してから直した。**ケースを消さないこと。**
// ---------------------------------------------------------------------------

// ① `-C` の値が引用符つき・空白入りだと、途中で切れて `sub` を取り違えていた
test("H47①: 値つきのグローバルオプションを飛ばす", () => {
  const sub = (cmd) => scope.gitInvocations(cmd).map((g) => g.sub);
  assert.deepEqual(sub('git -C "D:/my proj" push'), ["push"]);
  assert.deepEqual(sub("git -C 'D:/my proj' add -A"), ["add"]);
  assert.deepEqual(sub("git --git-dir x push"), ["push"], "値が別トークンの長いオプション");
  assert.deepEqual(sub("git --work-tree /w --git-dir /g commit -a"), ["commit"]);
  assert.deepEqual(sub("git -c user.name=a push"), ["push"], "連結形は1つだけ飛ばす");
  assert.deepEqual(sub("git --git-dir=x push"), ["push"], "= で繋いだ形も1つだけ");
  for (const cmd of ['git -C "D:/my proj" add -A', "git --git-dir x add -A"]) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, `repo-guard も: ${cmd}`);
  }
});

// ③ `-P` / `-p` は値を取らない1文字フラグ。当たる選択肢が無く null を返していた
test("H47③: 値を取らない1文字のグローバルオプションでも読める", () => {
  assert.deepEqual(scope.gitInvocations("git -P push").map((g) => g.sub), ["push"]);
  assert.equal(scope.isBlockedStash("git -P stash"), true);
  assert.equal(guard.isBlockedStash("git -P stash"), true);
});

// ② PowerShell では `\` はエスケープではない。bash の規則で読むと閉じ引用符を見失う
test("H47②: PowerShell の `\` 終端文字列で後続を見落とさない", () => {
  const cmd = String.raw`cd "D:\work\"; git add -A`;
  assert.equal(scope.isBlockedAdd(cmd, { shell: "powershell" }), true);
  assert.equal(guard.isBlockedAdd(cmd, { shell: "powershell" }), true);
  // 既定（bash）は従来どおりの読み方を保つ。ツール名が分からないときの挙動を変えない
  assert.equal(scope.isBlockedAdd(cmd), false, "既定は bash の規則");
});

test("H47②: PowerShell では `` ` `` は区切りではなくエスケープ", () => {
  const ps = { shell: "powershell" };
  assert.deepEqual(
    scope.scanCommands("echo a`;git add -A", ps).map((s) => s.text),
    ["echo a`;git add -A"],
    "バックティックで逃がした `;` はコマンド位置を作らない"
  );
  assert.deepEqual(
    scope.scanCommands("echo a; git add -A", ps).map((s) => s.text),
    ["echo a", "git add -A"]
  );
});

// Windows のパスはバックスラッシュを含む。bash の規則どおりに落とすと別のパスになる
test("H47: トークン化がバックスラッシュを落とさない", () => {
  const [tok] = scope.tokenize(String.raw`D:\work\x`);
  assert.equal(tok.value, String.raw`D:\work\x`);
  assert.equal(scope.tokenize(String.raw`"a b"`)[0].value, "a b", "引用符は外す");
  assert.equal(scope.tokenize(String.raw`a\ b`)[0].value, "a b", "空白を逃がす形は落とす");
});

// 2026-10-03 の査読（低1 / 低2）。どちらも**ガードが素通りする**側
test("H47: 値を `=` でしか取らないグローバルオプションを飛ばしすぎない", () => {
  // `git --exec-path status` は exec path を表示して終わる（次のトークンは値ではない）
  assert.deepEqual(scope.gitInvocations("git --exec-path push").map((g) => g.sub), ["push"]);
  assert.deepEqual(scope.gitInvocations("git --super-prefix=x push").map((g) => g.sub), ["push"]);
  // 値を別トークンで取るものは従来どおり飛ばす（いずれも git が受け付ける形）
  for (const opt of ["-c k=v", "-C .", "--git-dir .git", "--work-tree .", "--namespace n", "--config-env X=Y"]) {
    assert.deepEqual(scope.gitInvocations(`git ${opt} push`).map((g) => g.sub), ["push"], opt);
  }
});

test("H47: 行継続（`git \<改行> add -A`）を読む", () => {
  const bash = ["git \\", "  add -A"].join("\n");
  assert.equal(scope.isBlockedAdd(bash), true);
  assert.equal(guard.isBlockedAdd(bash), true);
  const ps = ["git `", "  add -A"].join("\n");
  assert.equal(scope.isBlockedAdd(ps, { shell: "powershell" }), true);
});


// ---- H50: ヒアドキュメント／ヒアストリングの本文で走査を誤る ----
// **本文はデータであってコマンドではない。** ところが本文の `"` が奇数個あると
// 引用符の判定が反転し、**後続の `&& git add -A` を見失って deny がすり抜けた**（実測）。
// 逆に本文を飛ばしすぎると `-- <path>` を見失い、**正常なコミットで警告が鳴る**。
// **どちらの方向にも間違う**ので、すり抜けと誤警報を対にして押さえる。

// Claude Code 標準のコミット形。`<<` が**二重引用符の内側**（コマンド置換の中）に現れる。
const HEREDOC_ODD_QUOTES = [
  `git commit -m "$(cat <<'EOF'`,
  `fix: "a" と " を含む本文`,
  "EOF",
  `)" -- docs/x.md && git add -A`,
].join("\n");

test("H50: 本文の奇数個の `\"` で後続の `git add -A` を見失わない（bash）", () => {
  assert.equal(scope.isBlockedAdd(HEREDOC_ODD_QUOTES), true);
  assert.equal(guard.isBlockedAdd(HEREDOC_ODD_QUOTES), true);
});

test("H50: 同じ形で `add` が無ければ鳴らない（誤警報を出さない）", () => {
  const cmd = [`git commit -m "$(cat <<'EOF'`, `本文に " が1つ`, "EOF", `)" -- docs/x.md`].join("\n");
  assert.equal(scope.isBlockedAdd(cmd), false);
  assert.equal(guard.isBlockedAdd(cmd), false);
  // `-- <path>` を見失っていないこと（見失うと「パス指定なし」の警告が鳴る）
  assert.equal(scope.isUnscopedCommit(cmd), false);
  assert.equal(guard.isUnscopedCommit(cmd), false);
});

test("H50: 本文に書かれた禁止コマンドは拾わない（本文はデータ）", () => {
  const cmd = [`git commit -m "$(cat <<'EOF'`, "git add -A は使わない", "EOF", `)" -- a.md`].join("\n");
  assert.equal(scope.isBlockedAdd(cmd), false);
  assert.equal(guard.isBlockedAdd(cmd), false);
});

test("H50: 終わりの行は区切り語そのものでなければならない", () => {
  // 字下げした `EOF` はシェルでも終端ではない。終端と誤判定すると
  // **そこから先の本文をコマンドとして読んでしまう**。
  const cmd = [`git commit -m "$(cat <<'EOF'`, "   EOF", "EOF", `)" -- a.md && git add -A`].join("\n");
  assert.equal(scope.isBlockedAdd(cmd), true);
  assert.equal(guard.isBlockedAdd(cmd), true);
  assert.equal(scope.isUnscopedCommit(cmd), false);
});

test("H50: `<<-` はタブだけを落とす", () => {
  const cmd = [`git commit -m "$(cat <<-'EOF'`, "\tEOF", `)" -- a.md && git add -A`].join("\n");
  assert.equal(scope.isBlockedAdd(cmd), true);
  assert.equal(guard.isBlockedAdd(cmd), true);
});

test("H50: 終端の次の行にある `git add -A` は別のコマンドとして読む", () => {
  // 本文を潰すときに終端行の改行まで消すと、前後のコマンドが1つに融合して見落とす。
  const cmd = [`git commit -F - -- a.md <<'EOF'`, "msg", "EOF", "git add -A"].join("\n");
  assert.equal(scope.isBlockedAdd(cmd), true);
  assert.equal(guard.isBlockedAdd(cmd), true);
});

test("H50: PowerShell のヒアストリングでも同じ（すり抜けと誤警報の両方）", () => {
  const ps = { shell: "powershell" };
  // 本文の `"` が奇数個 ＋ 閉じた後ろに `; git add -A`
  const leak = [`git commit -m @"`, `本文に " が奇数`, `"@ -- a.md; git add -A`].join("\n");
  assert.equal(scope.isBlockedAdd(leak, ps), true);
  assert.equal(guard.isBlockedAdd(leak, ps), true);
  assert.equal(scope.isUnscopedCommit(leak, ps), false);

  // 本文の禁止語は拾わない
  const body = [`git commit -m @'`, "git add -A と書いた", `'@ -- a.md`].join("\n");
  assert.equal(scope.isBlockedAdd(body, ps), false);
  assert.equal(guard.isBlockedAdd(body, ps), false);
  assert.equal(scope.isUnscopedCommit(body, ps), false);

  // 行の**途中**の `"@` では終わらない（行頭だけが終端）
  const mid = [`git commit -m @"`, `あと "@ は本文`, `"@ -- a.md; git add -A`].join("\n");
  assert.equal(scope.isBlockedAdd(mid, ps), true);
  assert.equal(guard.isBlockedAdd(mid, ps), true);

  // パス指定が無ければ、ヒアストリングでも警告は出る（安全弁を殺していない）
  const unscoped = [`git commit -m @'`, "msg", `'@`].join("\n");
  assert.equal(scope.isUnscopedCommit(unscoped, ps), true);
});

// ---- H65 の差し戻しで見つかった、`maskHereBodies` 由来の見逃し ----
//
// **0.31.3（H50）で入れた `maskHereBodies` が、`git add -A` の deny を5形すり抜けていた。**
// H65 の査読で `isGitCommit` の同型の穴を指摘され、**同じ検査を `git-scope` にも当てて発覚した**
// （査読は「`git-scope` は気をつけている」としていたが、**実測では同じ穴があった**）。
//
// **これは `repo-guard` が存在する理由そのものに触る** —— `6c68d30` では
// 別セッションの20ファイルを巻き込んだまま push まで到達した。**見逃しは不可である。**

test("H65: ヒアドキュメント由来の見逃しを作らない", () => {
  const cases = [
    // 導入部の行をまるごと潰すと、同じ行に続くコマンドが消える
    ["cat <<EOF | git add -A", "msg", "EOF"].join("\n"),
    ["cat <<EOF && git add -A", "msg", "EOF"].join("\n"),
    // **シェルへ渡す本文は実行される。** 潰してはいけない
    ["bash <<EOF", "git add -A", "EOF"].join("\n"),
    ["sh <<'EOF'", "git add -A", "EOF"].join("\n"),
    ["ssh host <<'EOF'", "git add -A", "EOF"].join("\n"),
    // `<<` に見えて本文を持たない（終端が無いので後続を全部潰していた）
    ["echo $((1 << N))", "git add -A"].join("\n"),
    ["grep x <<<abc", "git add -A"].join("\n"),
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, cmd);
  }
});

test("H65: 本文がデータのときは、潰す側も保つ（誤警報を増やさない）", () => {
  // `cat` / `tee` / `git`（`-F -`）が受け取る本文は**データ**なので、
  // 本文に書かれた禁止コマンドで鳴ってはいけない。
  const cases = [
    ["cat > d.md <<'EOF'", "git add -A と書く", "EOF"].join("\n"),
    ["tee d.md <<EOF", "git add -A と書く", "EOF"].join("\n"),
    ["git commit -F - -- a.md <<'EOF'", "git add -A も止める", "EOF"].join("\n"),
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), false, cmd);
    assert.equal(guard.isBlockedAdd(cmd), false, cmd);
  }
});

// ---- H65 の再査読: 本文の行き先が実行系なら潰さない ----
//
// **「本文を受け取るのが `cat` ならデータ」は誤りだった。**
// `cat` は本文を**出力へ流すだけ**で、**その先が `bash` / `eval` なら実行される**。
// 査読で9形の見逃しを指摘され、**7形がこの修正で直った**（残る2形は下の限界）。

test("H65: 本文の行き先が実行系なら潰さない", () => {
  const cases = [
    ["cat <<EOF | bash", "git add -A", "EOF"].join("\n"),
    ["cat <<'EOF' | sh", "git add -A", "EOF"].join("\n"),
    ["tee /dev/null <<EOF | sh", "git add -A", "EOF"].join("\n"),
    ["cat <<EOF | xargs -I{} sh -c {}", "git add -A", "EOF"].join("\n"),
    ["source <(cat <<EOF", "git add -A", "EOF", ")"].join("\n"),
    ["git log `bash <<EOF", "git add -A", "EOF", "`"].join("\n"),
    ["cat <<EOF > /tmp/x.sh; bash /tmp/x.sh", "git add -A", "EOF"].join("\n"),
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, cmd);
  }
});

test("H65: 本文がデータのままなら潰す（誤警報を増やさない）", () => {
  const cases = [
    ["cat > d.md <<'EOF'", "git add -A と書く", "EOF"].join("\n"),
    ["tee d.md <<EOF", "git add -A と書く", "EOF"].join("\n"),
    ["git commit -F - -- a.md <<'EOF'", "git add -A も止める", "EOF"].join("\n"),
    // 前置きは飛ばす（飛ばさないと sink が `FOO=1` / `sudo` になって鳴る）
    ["FOO=1 cat <<EOF", "git add -A と書く", "EOF"].join("\n"),
    ["sudo cat <<EOF", "git add -A と書く", "EOF"].join("\n"),
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), false, cmd);
    assert.equal(guard.isBlockedAdd(cmd), false, cmd);
  }
});

// **限界として固定する。** `scanCommands` は**引用符の中を走査しない**ので、
// `bash -c "…"` / `eval "…"` の中は、**H69（0.37.0）で見るようにした**。
//
// **期待値を反転してある**（`CLAUDE.md` の「失敗したケースを消さない。直したら期待値を変える」）。
// 0.36.3 までは `false` が正しい期待値で、**ヒアドキュメントが無くても素通りしていた**。
// 直し方は「引用符の中を走査する」ではなく、**`-c` の後ろを取り出して同じ規則で読み直す**
// （H50 で踏んだ「引用符の中を一緒に走査する」側には寄せていない）。
test("H69: `bash -c` / `eval` の中も見る（0.37.0 で期待値を反転）", () => {
  const cases = [
    'bash -c "git add -A"',
    "sh -c 'git add -A'",
    'eval "git add -A"',
    'sudo bash -c "git add -A"',
    'bash -lc "git add -A"',
    // 本文を `bash -c` へ渡す形。**本文が実際に実行される**ので検出する側が正しい
    ["bash -c \"$(cat <<EOF", "git add -A", "EOF", ")\""].join("\n"),
    ["eval \"$(cat <<'EOF'", "git add -A", "EOF", ")\""].join("\n"),
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, cmd);
  }
});

test("H69: スクリプトファイルを渡す形は見えない（限界として固定する）", () => {
  // 中身はファイルの側にある。**読みに行くとフックがファイルシステムに依存する**ので、
  // 見逃しとして残す。`powershell -EncodedCommand`（base64）も同じ理由で扱わない
  for (const cmd of ["bash script.sh", "bash ./deploy.sh --yes"]) {
    assert.equal(scope.isBlockedAdd(cmd), false, cmd);
    assert.equal(guard.isBlockedAdd(cmd), false, cmd);
  }
});

// ---- H65: 許可リストへ反転した（禁止リストは3回続けて崩れた） ----
//
// | 版 | 前提 | 崩れた形 |
// |---|---|---|
// | 0.34.0 | 本文は実行されない | `bash <<EOF` |
// | 0.34.1 | 受け取るのが `cat` ならデータ | `cat <<EOF \| bash` |
// | 0.34.2 | 導入部の行に実行系の名前が無ければデータ | `\| $SHELL` / `\| . /dev/stdin` / 関数 / 別の行 |
//
// **禁止リストは収束しない。** 名前を足すたびに別名・変数・関数・別の行で抜ける
// （査読が13形を実測し、**うち5形は実際に本文が実行されることまで確かめた**）。
//
// **いまは「確実に安全な形のときだけ潰す」。** 安全な形は有限である。

test("H65: 本文が実行されうる形は、1つも潰さない", () => {
  const cases = [
    // パイプ先が実行系（名前でも、変数でも、関数でも）
    ["cat <<EOF | bash", "git add -A", "EOF"].join("\n"),
    ["cat <<EOF | $SHELL", "git add -A", "EOF"].join("\n"),
    ["cat <<EOF | $0", "git add -A", "EOF"].join("\n"),
    ["SH=bash", "cat <<EOF | $SH", "git add -A", "EOF"].join("\n"),
    ["r() { bash; }", "cat <<EOF | r", "git add -A", "EOF"].join("\n"),
    ["cat <<EOF | . /dev/stdin", "git add -A", "EOF"].join("\n"),
    ["cat <<EOF | while read l; do $l; done", "git add -A", "EOF"].join("\n"),
    ["cat <<EOF | python3.11", "git add -A", "EOF"].join("\n"),
    ["cat <<EOF | busybox ash", "git add -A", "EOF"].join("\n"),
    ["x=ba;y=sh", "cat <<EOF | $x$y", "git add -A", "EOF"].join("\n"),
    // プロセス置換（`$(` と違い、結果が実行される）
    ["source <(cat <<EOF", "git add -A", "EOF", ")"].join("\n"),
    [". <(cat <<EOF", "git add -A", "EOF", ")"].join("\n"),
    ["exec 3> >(bash)", "cat <<EOF >&3", "git add -A", "EOF"].join("\n"),
    // 別ファイルへ書いて実行
    ["cat <<EOF > /tmp/x.sh; bash /tmp/x.sh", "git add -A", "EOF"].join("\n"),
    // 本文の行き先がシェル自身
    ["bash <<EOF", "git add -A", "EOF"].join("\n"),
    // 導入部の行に本物が続く
    ["cat <<EOF | git add -A", "msg", "EOF"].join("\n"),
    // `<<` に見えて本文を持たない
    ["echo $((1 << N))", "git add -A"].join("\n"),
    ["grep x <<<abc", "git add -A"].join("\n"),
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, cmd);
  }
});

test("H65: 安全な形は潰す（文書を書くだけで鳴らせない）", () => {
  // **0.34.2 はここを壊していた** —— 導入部の行に `bash` / `node` / `sh` の語が
  // あるだけで潰さなくなり、**文書を書くだけの操作で鳴った**（H65 が直そうとした問題の再発）。
  const cases = [
    ["cat > docs/x.md <<'EOF'", "git add -A と書く", "EOF"].join("\n"),
    ["cat > docs/node <<'EOF'", "git add -A と書く", "EOF"].join("\n"),
    ["cat > a.md <<'EOF'   # sh 用の手順", "git add -A と書く", "EOF"].join("\n"),
    ["cd node && cat > a.md <<'EOF'", "git add -A と書く", "EOF"].join("\n"),
    ["cat <<EOF > a.md", "git add -A と書く", "EOF"].join("\n"),
    ["tee d.md <<EOF", "git add -A と書く", "EOF"].join("\n"),
    ["FOO=1 cat <<EOF", "git add -A と書く", "EOF"].join("\n"),
    ["sudo cat <<EOF", "git add -A と書く", "EOF"].join("\n"),
    // git は本文をコマンドとして実行しない
    ["git commit -F - -- a.md <<'EOF'", "git add -A も止める", "EOF"].join("\n"),
    ['git commit -m "docs: bash の注意" -F - -- a.md <<EOF', "git add -A", "EOF"].join("\n"),
    // Claude Code 標準のコミット形（`$(cat` は値になるだけ）
    ["git commit -m \"$(cat <<'EOF'", "git add -A は使わない", "EOF", ')" -- a.md'].join("\n"),
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), false, cmd);
    assert.equal(guard.isBlockedAdd(cmd), false, cmd);
  }
});

// ---- H65: 許可リストの2つ目の軸（行を包む外側） ----
//
// **0.35.0 は「導入部の行」だけを見ており、その行を包む外側を見ていなかった**
// （査読が2形の見逃しを実行確認つきで出した）。

test("H65: 行を包む外側が実行経路なら潰さない", () => {
  const cases = [
    // 素のサブシェル。**閉じ括弧の後ろで実行される**（終端より後ろなので行の判定に入らない）
    ["(cat <<EOF", "git add -A", "EOF", ") | bash"].join("\n"),
    // コマンド置換の値が実行される（引用符なしの形）
    ["eval $(cat <<EOF", "git add -A", "EOF", ")"].join("\n"),
    // バッククォート
    ["git log `bash <<EOF", "git add -A", "EOF", "`"].join("\n"),
    // プロセス置換
    ["source <(cat <<EOF", "git add -A", "EOF", ")"].join("\n"),
    [". <(cat <<EOF", "git add -A", "EOF", ")"].join("\n"),
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, cmd);
  }
});

test("H65: `git` の sink はメッセージを読むサブコマンドだけ", () => {
  // **`git` を丸ごと許すと広すぎた**（査読の中1。実行確認つき）——
  // `git -c alias.x='!bash' x <<EOF` は**本文を bash が実行する**。
  const unsafe = [
    ["git -c alias.x=!bash x <<EOF", "git add -A", "EOF"].join("\n"),
    ["git bisect run sh <<EOF", "git add -A", "EOF"].join("\n"),
    ["git submodule foreach bash <<EOF", "git add -A", "EOF"].join("\n"),
    ["git sh <<EOF", "git add -A", "EOF"].join("\n"), // 設定済みの別名
  ];
  for (const cmd of unsafe) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, cmd);
  }
  // メッセージを読む形は潰す
  const safe = [
    ["git commit -F - -- a.md <<'EOF'", "git add -A も止める", "EOF"].join("\n"),
    ["git tag -F - v1 <<EOF", "git add -A", "EOF"].join("\n"),
    ["git notes add -F - <<EOF", "git add -A", "EOF"].join("\n"),
  ];
  for (const cmd of safe) {
    assert.equal(scope.isBlockedAdd(cmd), false, cmd);
    assert.equal(guard.isBlockedAdd(cmd), false, cmd);
  }
});

test("H65: `gh` も本文をデータとして読む（誤警報を減らす）", () => {
  // `gh pr create --body-file - <<'EOF'` は実運用で出る形。
  const cmd = ["gh pr create --body-file - <<'EOF'", "git add -A と書く", "EOF"].join("\n");
  assert.equal(scope.isBlockedAdd(cmd), false, cmd);
  assert.equal(guard.isBlockedAdd(cmd), false, cmd);
});

// **限界として固定する（H69 / H70）。** どちらも**ヒアドキュメントとは無関係**で、
// `scanCommands` / `parseGit` の作りに由来する。**直したら期待値を変える。**
//
// > 実測: `bash -c "git add -A"`（引用符の中）も `eval git add -A`（引用符なし）も
// > `sudo git add -A`（ラッパー1つ）も `false` である。
test("H65: 引用符の中のヒアドキュメントは、コミットメッセージなら見ない（H69 で反転した分を除く）", () => {
  const quoted = [];
  // **`wrapped` は H70（0.36.0）で直した。** 期待値を変えてここから外し、
  // 下の「H70」のテストで**検出すること**を固定した（`CLAUDE.md` の
  // 「失敗したケースを消さない。直したら期待値を変える」）。
  // **査読が「直った」と思った3形は、限界①へ移っただけである**（5回目の査読の中4）。
  // **引用符を外せば検出できる**（上の `$(…)` の外側のテスト）。
  const quotedSubst = [
    ['eval git commit -m "$(cat <<EOF', "msg", "git add -A", "EOF", ')"'].join("\n"),
    ['echo git commit -m "$(cat <<EOF', "git add -A", "EOF", ')" | bash'].join("\n"),
    ["ssh h git commit -m \"$(cat <<EOF", "git add -A", "EOF", ')"'].join("\n"),
  ];
  for (const cmd of [...quoted, ...quotedSubst]) {
    assert.equal(scope.isBlockedAdd(cmd), false, cmd);
    assert.equal(guard.isBlockedAdd(cmd), false, cmd);
  }
});

// ---- H65: 軸②の残り（5回目の査読） ----

test("H65: ブレースグループと関数定義の中は潰さない", () => {
  // **`(` は塞いだのに `{` を忘れていた**（査読の高1・実行確認つき）。
  // **1行だけ遡る方式では足りない** —— `{` が別の行にあると境界が改行になる。
  const cases = [
    ["{ cat <<EOF", "git add -A", "EOF", "} | bash"].join("\n"),
    ["{ tee f <<EOF", "git add -A", "EOF", "} | bash"].join("\n"),
    ["{", "cat <<EOF", "git add -A", "EOF", "}|bash"].join("\n"),
    ["{ git commit -F - <<EOF", "git add -A", "EOF", "} | bash"].join("\n"),
    ["(", "cat <<EOF", "git add -A", "EOF", ") | bash"].join("\n"),
    // 関数定義も「後で実行される」ので潰さない
    ["f() {", "cat <<EOF", "git add -A", "EOF", "}", "f | bash"].join("\n"),
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, cmd);
  }
});

test("H65: `$(…)` の外側は「先頭が git」でなければ潰さない", () => {
  // **どこかに `git` があれば通していた**（査読の高2・実行確認つき）。
  // `eval git commit -m "$(cat <<EOF … )"` は本文の改行以降がコマンドとして走る。
  // **引用符を外した形で検出できることを確かめる**（引用符つきは限界①）。
  const cases = [
    ["eval git commit -m $(cat <<EOF", "git add -A", "EOF", ")"].join("\n"),
    ["echo git commit -m $(cat <<EOF", "git add -A", "EOF", ") | bash"].join("\n"),
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, cmd);
  }
});

test("H65: `git` のグローバルオプションの値をサブコマンドと取り違えない", () => {
  // `git -C commit bisect run sh <<EOF` の `commit` は **`-C` の値**である（査読の中3）。
  const unsafe = [
    ["git -C commit bisect run sh <<EOF", "git add -A", "EOF"].join("\n"),
    ["git --git-dir tag submodule foreach bash <<EOF", "git add -A", "EOF"].join("\n"),
  ];
  for (const cmd of unsafe) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, cmd);
  }
  // 正しい `-C` は潰す
  const safe = ["git -C /d commit -F - <<EOF", "git add -A", "EOF"].join("\n");
  assert.equal(scope.isBlockedAdd(safe), false, safe);
  assert.equal(guard.isBlockedAdd(safe), false, safe);
});

test("H65: `gh` もサブコマンドを限る（`git` と対称にする）", () => {
  // `gh alias set x '!bash'; gh x <<EOF` のように**別名を定義してから実行する形**がある（査読の低5）。
  const unsafe = [
    ["gh x <<EOF", "git add -A", "EOF"].join("\n"),
    ["gh alias set x !bash", "gh x <<EOF", "git add -A", "EOF"].join("\n"),
  ];
  for (const cmd of unsafe) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, cmd);
  }
  const safe = [
    ["gh pr create --body-file - <<'EOF'", "git add -A と書く", "EOF"].join("\n"),
    ["gh issue create -F - <<EOF", "git add -A と書く", "EOF"].join("\n"),
  ];
  for (const cmd of safe) {
    assert.equal(scope.isBlockedAdd(cmd), false, cmd);
    assert.equal(guard.isBlockedAdd(cmd), false, cmd);
  }
});

// ---- H65: 誤警報側（6回目の査読。**ここが薄かった**） ----
//
// **`inOpenGroup` を足したことで、文書を書くだけの操作が鳴るようになっていた。**
// **文書の本文にはコード例が入る**ので、`function f() {` や `if (x) {` は当たり前に出てくる。
// **H65 が直そうとした問題そのものの再発**だった。
//
// 査読の指摘（中1・低2〜低4）と、自分の実測（本文の `{`）をまとめて固定する。

test("H65: 数えるときに読み飛ばすもの（誤警報を増やさない）", () => {
  const cases = [
    // **ヒアドキュメントの本文**（コード例の `{` を数えていた）
    ["cat > a.md <<'E1'", "{", "E1", "cat > b.md <<'E2'", "git add -A と書く", "E2"].join("\n"),
    ["cat > a.md <<'E1'", "function f() {", "E1", "cat > b.md <<'E2'", "git add -A と書く", "E2"].join("\n"),
    ["cat > a.md <<'E1'", "if (x) {", "E1", "cat > b.md <<'E2'", "git add -A と書く", "E2"].join("\n"),
    ["cat > a.md <<'E1'", "- item (see", "E1", "cat > b.md <<'E2'", "git add -A と書く", "E2"].join("\n"),
    // **引用符の中**
    ['echo "fix (wip"; cat > f.md <<EOF', "git add -A", "EOF"].join("\n"),
    ['grep -E "^\(" f', "git commit -F - -- a.md <<EOF", "git add -A", "EOF"].join("\n"),
    ['git commit -m "feat(x: y" -- a', "cat > f.md <<EOF", "git add -A", "EOF"].join("\n"),
    // **`#` コメントと `\` エスケープ**
    ["# {", "cat > f.md <<EOF", "git add -A", "EOF"].join("\n"),
    ["echo " + String.fromCharCode(92) + "{ ; cat > f.md <<EOF", "git add -A", "EOF"].join("\n"),
    // **`gh` の値オプション**（`--repo a/b` の値を読んで `pr` に届いていなかった）
    ["gh --repo a/b pr create --body-file - <<EOF", "git add -A と書く", "EOF"].join("\n"),
    ["gh -R a/b issue create -F - <<EOF", "git add -A と書く", "EOF"].join("\n"),
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), false, cmd);
    assert.equal(guard.isBlockedAdd(cmd), false, cmd);
  }
});

test("H65: 読み飛ばしても、本物のグループは見逃さない", () => {
  // **読み飛ばしを足した副作用で逆に見逃さないか** —— ここが落ちたら飛ばしすぎている。
  const cases = [
    // 前の本文に奇数個の `'` があっても、後ろの本物のグループは数える
    ["cat > a.md <<'EOF'", "don't", "EOF", "{", "cat <<E2", "git add -A", "E2", "} | bash"].join("\n"),
    // 引用符の中の `}` で深さを減らさない
    ['{ echo "}"; cat <<EOF', "git add -A", "EOF", "} | bash"].join("\n"),
    ['( echo ")"; cat <<EOF', "git add -A", "EOF", ") | bash"].join("\n"),
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, cmd);
  }
});

// ---- H70: ラッパーを1つ挟むと deny を通っていた ----
//
// **`parseGit` が `tokens[0].value !== "git"` で弾いていた。**
//
// > 実測: **`sudo git add -A` / `env` / `time` / `eval` / `command` / `nohup` /
// > `nice` / `xargs` / `/usr/bin/git` が、すべて deny を素通りしていた。**
//
// **`sudo` の付け忘れ・付け足しは実際に起こる**ので、
// **ヒアドキュメント由来の見逃し（H65）より事故の形に近い**。

test("H70: 包むコマンドとパス付きの形を越えて `git` を見る", () => {
  const cases = [
    "sudo git add -A",
    "env git add -A",
    "time git add -A",
    "eval git add -A",
    "command git add -A",
    "nohup git add -A",
    "nice git add -A",
    "xargs git add -A",
    "/usr/bin/git add -A",
    "sudo -u u git add -A",
    "nice -n 10 git add -A",
    "sudo /usr/bin/git add .",
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, cmd);
  }
});

test("H70: `git` を実行しない形では鳴らない（ここが最重要）", () => {
  // **`echo` や `cp` を包むコマンドに入れると、ここが落ちる。**
  // あれらは `git` を実行しないので、入れると文書作業で鳴る。
  const cases = [
    "echo git add -A",
    "cp /usr/bin/git add",
    "sudo ls /usr/bin/git",
    "command -v git",
    "grep -rn 'git add -A' docs/",
    "git status",
    "git add src/a.ts",
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), false, cmd);
    assert.equal(guard.isBlockedAdd(cmd), false, cmd);
  }
});

test("H70: 他の判定にも効く（`parseGit` は全判定の入口）", () => {
  // `isBlockedAdd` だけでなく、`commit -a` / `stash` / 範囲指定なしの破棄も同じ入口を通る。
  assert.equal(scope.isBlockedCommitAll("sudo git commit -am x"), true);
  assert.equal(scope.isBlockedStash("sudo git stash"), true);
  assert.equal(scope.isBlockedDiscard("sudo git checkout -- ."), true);
  assert.equal(scope.isUnscopedCommit("sudo git commit -m x"), true);
  // 包まない形は従来どおり
  assert.equal(scope.isBlockedCommitAll("git commit -- a.md"), false);
  assert.equal(scope.isUnscopedCommit("git commit -- a.md"), false);
});

// ---- H70: ラッパー直後の「最初の実コマンド」で判定する ----
//
// **「後ろのどこかに `git` があれば」ではいけない**（0.36.0 の査読）——
// ラッパーの後ろで**別のコマンドが動く**形や、**オプションの値が `git`** の形で誤る。

test("H70: ラッパーの後ろで別のコマンドが動く形では鳴らない", () => {
  // **ここが落ちたら「どこかに git」方式に戻っている。**
  // `echo` / `ls` / `man` / `docker` は `git` を**実行しない**。
  const cases = [
    "sudo echo git add -A",
    "time echo git add .",
    "env echo git add -A",
    "xargs echo git add -A",
    "sudo ls git status",
    "exec ls git stash",
    "sudo man git commit -a",
    "sudo grep -n git commit -a notes.md",
    "sudo less git commit -a",
    "sudo docker run --rm alpine/git add -A",
    "sudo ls /srv/git checkout .",
    "time docker compose run git reset --hard",
    "sudo apt-get install -y git stash",
  ];
  for (const cmd of cases) {
    const hit =
      scope.isBlockedAdd(cmd) ||
      scope.isBlockedCommitAll(cmd) ||
      scope.isBlockedStash(cmd) ||
      scope.isBlockedDiscard(cmd);
    assert.equal(hit, false, cmd);
    const hitGuard =
      guard.isBlockedAdd(cmd) ||
      guard.isBlockedCommitAll(cmd) ||
      guard.isBlockedStash(cmd) ||
      guard.isBlockedDiscard(cmd);
    assert.equal(hitGuard, false, cmd);
  }
});

test("H70: オプションの値が `git` でも見逃さない", () => {
  // `sudo -u git git push` の `-u` の値 `git` を先に見つけ、
  // サブコマンドが `git` になって**見逃していた**（査読の中2）。
  // `git` ユーザー（ホスティング用アカウント）はよくある名前である。
  assert.ok(scope.gitInvocations("sudo -u git git push").some((g) => g.sub === "push"));
  assert.ok(guard.gitInvocations("sudo -u git git push").some((g) => g.sub === "push"));
  assert.equal(scope.isBlockedAdd("sudo -u git git add -A"), true);
  assert.equal(guard.isBlockedAdd("sudo -u git git add -A"), true);
  // `-u` の値が `git` でも、動くのが `ls` なら鳴らない
  assert.equal(scope.isBlockedAdd("sudo -u git ls git add -A"), false);
});

test("H70: ラッパーのオプションを飛ばす（値あり／値なしを取り違えない）", () => {
  // **一律の表にしてはいけない** —— `env -i`（値なし）と `xargs -i`（値あり）は同じ綴り。
  // 一律に値ありとすると `env -i git add -A` の `git` を飛ばして**見逃す**。
  const cases = [
    "env -i git add -A",
    "xargs -I{} git add -A",
    "sudo -E git add -A",
    "nice -n 10 git add -A",
    "timeout 5 git add -A",
    "timeout --signal=TERM 5 git add -A",
    "stdbuf -o0 git add -A",
    "sudo -u x nice -n 5 git add -A",
    "setsid git add -A",
    "doas git add -A",
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, cmd);
  }
});

test("H70: `changesBeforeCommit` を一方向に緩めない", () => {
  // ラッパー越しの誤認で「ツリーを変えない」と判定され、**見逃しが増えていた**（査読の低4）。
  assert.ok(scope.changesBeforeCommit("sudo rm -rf build git status; git commit -m x"));
  assert.ok(scope.changesBeforeCommit("env X=1 rm -rf src git status && git commit -m x"));
  assert.ok(scope.changesBeforeCommit("sudo rm -rf build && git commit -m x"));
  // 読むだけの操作は従来どおり安全
  assert.equal(scope.changesBeforeCommit("git status && git commit -- a.md"), null);
});

// ---- H49: 2コピーの食い違いを「関数ごとに」機械で押さえる ----
//
// **`isUnscopedCommit` が片方だけ誤っていた。**
// `git-scope` は `args.includes("--")` で、**長いオプションに当たっていた** ——
// `--no-verify` / `--quiet` / `--signoff` があるだけで「パス指定あり」と誤判定し、
// **`git commit --quiet -m x` のようなごく普通のコマンドで警告が出なかった**（実測）。
// `repo-guard` 側は最初から正しかった。
//
// **根は「乖離検査がこの関数を見ていなかった」ことである。**
// 個別のケースを足すのではなく、**両方が持つ判定を全部、同じケース集に当てる**。
// **新しく共有の判定が増えたら、ここに自動で乗る。**

const SHARED_PREDICATES = [
  "isBlockedAdd",
  "isBlockedCommitAll",
  "isBlockedStash",
  "isBlockedDiscard",
  "isUnscopedCommit",
];

/** 乖離が出やすい形を集めてある。**減らさないこと**（減らすと乖離を見逃す） */
const PARITY_CASES = [
  // パス指定の区切りと、長いオプションの区別（H49 の本体）
  "git commit -m x",
  "git commit -m x -- a.md",
  "git commit -m x --no-verify",
  "git commit --quiet -m x",
  "git commit -m x --signoff",
  "git commit -m x --amend",
  "git commit -m x --dry-run",
  "git commit -am x",
  "git commit --all -m x",
  // 範囲まるごと
  "git add -A",
  "git add .",
  "git add --all",
  "git add src/a.ts",
  "git stash",
  "git stash push -- a.md",
  "git checkout -- .",
  "git restore .",
  "git clean -fd",
  "git clean -n",
  // ラッパーとパス付き（H70）
  "sudo git add -A",
  "sudo git commit --quiet -m x",
  "/usr/bin/git add -A",
  "sudo echo git add -A",
  "env -i git add -A",
  // 引用符・コメント・ヒアドキュメント（H50 / H65）
  "echo 'git add -A'",
  "# git add -A",
  ["cat > a.md <<'EOF'", "git add -A と書く", "EOF"].join("\n"),
  ["cat <<EOF | bash", "git add -A", "EOF"].join("\n"),
  ["{ cat <<EOF", "git add -A", "EOF", "} | bash"].join("\n"),
  ["git commit -m \"$(cat <<'EOF'", "git add -A は使わない", "EOF", ')" -- a.md'].join("\n"),
  // グローバルオプション
  "git -C /d commit -m x",
  "git -c user.name=x commit -m x",
  "git --no-pager add -A",
];

test("H49: 両方が持つ判定は、すべて同じ結果を返す", () => {
  const diffs = [];
  for (const name of SHARED_PREDICATES) {
    assert.equal(typeof scope[name], "function", `git-scope に ${name} が無い`);
    assert.equal(typeof guard[name], "function", `repo-guard に ${name} が無い`);
    for (const cmd of PARITY_CASES) {
      const a = scope[name](cmd);
      const b = guard[name](cmd);
      if (a !== b) diffs.push(`${name}: ${JSON.stringify(cmd)} → scope=${a} / guard=${b}`);
    }
  }
  assert.deepEqual(diffs, [], `2コピーが食い違っている:\n${diffs.join("\n")}`);
});

test("H49: 共有している判定を数え、増えたら気づける", () => {
  // **新しく共有の判定が増えたら、上の検査に入れ忘れないようにする。**
  // ここが落ちたら `SHARED_PREDICATES` に足す（または意図的な片側実装だと注記する）。
  const shared = Object.keys(scope).filter(
    (k) => typeof scope[k] === "function" && typeof guard[k] === "function",
  );
  // 判定以外（`scanCommands` / `tokenize` / `parseGit` / `gitInvocations`）は
  // 戻り値が構造体なので、上の検査とは別に扱う
  const helpers = ["scanCommands", "tokenize", "parseGit", "gitInvocations"];
  const predicates = shared.filter((k) => !helpers.includes(k)).sort();
  assert.deepEqual(predicates, [...SHARED_PREDICATES].sort());
});

test("H49: `gitInvocations` の結果も2コピーで一致する", () => {
  // 判定の土台。ここが食い違うと全部ずれる。
  for (const cmd of PARITY_CASES) {
    const a = scope.gitInvocations(cmd).map((g) => `${g.sub}:${g.args}`);
    const b = guard.gitInvocations(cmd).map((g) => `${g.sub}:${g.args}`);
    assert.deepEqual(a, b, cmd);
  }
});

// ---- H49: ソースそのものを突き合わせる（ケース集では閉じない） ----
//
// **手書きのケース集では「2コピーの食い違い」という型は閉じない**（査読が変異テストで実証）。
// 落とせるのは**ケースが踏んだ分岐の戻り値**だけで、次は素通りした。
//
// | 変異（`git-scope` 側だけ） | ケース集の検査 |
// |---|---|
// | `isBlockedDiscard` から `./` や `:/` を外す | **すり抜け** |
// | `STASH_SAFE` から `branch` / `show` を外す | **すり抜け** |
// | `GIT_VALUE_OPTS` から `--work-tree` を外す | **すり抜け** |
// | `SINK_PREFIXES` から `xargs` を外す | **すり抜け** |
// | `SEPARATORS` から `` ` `` を外す | **すり抜け** |
//
// **判定の「外」にある定数（集合・正規表現）は、戻り値を比べても見えない。**
// そこで**共有領域のソースを正規化して突き合わせる**。
//
// **共有領域は両方で連続していて、同じ順に並んでいる** ——
// `const SEPARATORS` から `isUnscopedCommit` の終わりまで。

const SHARED_BEGIN = "const SEPARATORS = new Set";
const SHARED_END = "function isUnscopedCommit";

/** 共有領域を取り出し、コメントと空白を落として比べられる形にする */
function sharedSource(file) {
  const text = fs.readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
  const begin = text.indexOf(SHARED_BEGIN);
  assert.ok(begin >= 0, `${file}: 共有領域の始まりが見つからない`);
  const endAt = text.indexOf(SHARED_END, begin);
  assert.ok(endAt >= 0, `${file}: 共有領域の終わりが見つからない`);
  // `isUnscopedCommit` の本体の終わり（次の `\n}` ）まで含める
  const close = text.indexOf("\n}\n", endAt);
  assert.ok(close >= 0, `${file}: ${SHARED_END} の終わりが見つからない`);

  return (
    text
      .slice(begin, close + 3)
      // ブロックコメントを落とす
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      // 行コメントを落とす（**文字列の中の `//` は無いことを前提にしている**。
      // 共有領域に URL やパスのリテラルが入ったら、ここを見直すこと）
      .map((l) => l.replace(/^\s*\/\/.*$/, "").trim())
      .filter(Boolean)
  );
}

test("H49: 共有領域のソースが2コピーで一致する（定数の食い違いも拾う）", () => {
  const a = sharedSource(path.join(SCRIPTS, "git-scope.js"));
  const b = sharedSource(path.join(ROOT, ".claude", "hooks", "repo-guard.js"));

  // **並び順の違いは許す**（`hasPathspecSep` の置き場が違う等）。
  // **中身の有無だけを見る** —— 足りない・多いを拾えれば乖離は分かる。
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  const onlyInScope = sortedA.filter((l) => !sortedB.includes(l));
  const onlyInGuard = sortedB.filter((l) => !sortedA.includes(l));

  assert.deepEqual(
    { onlyInScope, onlyInGuard },
    { onlyInScope: [], onlyInGuard: [] },
    "共有領域のソースが食い違っている（片方だけ直した可能性）",
  );
});

test("H49: 共有領域が小さくなりすぎていないか（取り出しの壊れに気づく）", () => {
  // **領域の切り出しが壊れると、検査が空振りして気づけない。**
  // 行数の下限を置いて、黙って無力化されるのを防ぐ。
  const a = sharedSource(path.join(SCRIPTS, "git-scope.js"));
  assert.ok(a.length > 300, `共有領域が ${a.length} 行しか取れていない（切り出しが壊れた可能性）`);
});

// ---------------------------------------------------------------------------
// H71 ①: 二重引用符の中のコマンド置換（0.37.0）
// ---------------------------------------------------------------------------

test("H71 ①: 引用符の中の `$(…)` も見る", () => {
  const cases = ['echo "$(git add -A)"', 'echo "x $(git clean -fd) y"', 'X="`git add -A`"'];
  for (const cmd of cases) {
    assert.equal(
      scope.isBlockedAdd(cmd) || scope.isBlockedDiscard(cmd),
      true,
      cmd
    );
  }
  // **文字列として書いただけなら鳴らさない**（置換ではないので誤検知にしない）
  assert.equal(scope.isBlockedAdd('echo "see git add -A here"'), false);
  assert.equal(scope.isBlockedAdd("echo 'git add -A'"), false);
});

test("H71 ①: コミットメッセージのヒアドキュメントは置換の中でも潰れたまま", () => {
  // このリポジトリが毎回使う形。**ここが鳴ると実用にならない**
  const cmd = [
    "git commit -q -m \"$(cat <<'EOF'",
    "fix: git add -A を禁じる",
    "EOF",
    ')" -- a.js',
  ].join("\n");
  assert.equal(scope.isBlockedAdd(cmd), false, cmd);
  assert.equal(guard.isUnscopedCommit(cmd), false, cmd);
});

// ---------------------------------------------------------------------------
// H72: 引数はトークンで見る（0.37.0）
// ---------------------------------------------------------------------------

// **生の文字列を正規表現で見ていたため、見逃しと誤検知が両方出ていた。**
// 下の期待値はすべて 0.36.3 で実測した結果からの変更である。
//
// | 形 | 0.36.3 | 0.37.0 |
// |---|---|---|
// | `git commit -m "a -- b"` | 警告なし（見逃し） | 警告 |
// | `git commit --` | 警告なし（見逃し） | 警告 |
// | `git commit -m "docs: --all を禁じる"` | **deny**（誤検知） | 通す |
// | `git add -- "a -A b.txt"` | **deny**（誤検知） | 通す |
test("H72: メッセージの中の `--` を区切りと読まない", () => {
  assert.equal(guard.isUnscopedCommit('git commit -m "a -- b"'), true);
  assert.equal(guard.isUnscopedCommit('git commit -m "a -- b" -- src/a.js'), false);
});

test("H72: 後ろにパス指定の無い `--` は「指定あり」ではない", () => {
  // `git commit --` はインデックス全体が入る
  assert.equal(guard.isUnscopedCommit("git commit --"), true);
  // `--amend` は `isUnscopedCommit` の対象外（文面が違うので `isAmendCommit` が見る）
  assert.equal(guard.isAmendCommit("git commit --amend --"), true);
  assert.equal(guard.isUnscopedCommit("git commit -- a.js"), false);
});

test("H72: メッセージの中のオプション名で deny しない", () => {
  for (const cmd of [
    'git commit -m "docs: --all を禁じる"',
    'git commit -m "-a は使わない"',
    'git add -- "a -A b.txt"',
    'git stash list -- "show me"',
  ]) {
    assert.equal(scope.isBlockedCommitAll(cmd), false, cmd);
    assert.equal(scope.isBlockedAdd(cmd), false, cmd);
    assert.equal(scope.isBlockedStash(cmd), false, cmd);
  }
});

test("H72: `--pathspec-from-file` もパス指定として数える", () => {
  assert.equal(guard.isUnscopedCommit("git commit --pathspec-from-file=list.txt"), false);
  assert.equal(guard.isUnscopedCommit("git commit --pathspec-from-file list.txt"), false);
});

// **値つきオプションの表をサブコマンドで分ける理由**（一律にすると見逃す）
test("H72: 値つきオプションの表はサブコマンドごとである", () => {
  // `-e` は clean では値を取り、add では `--edit` で値を取らない。
  // 一律に値ありとすると `git add -e .` の `.` を飲んで**見逃す**
  assert.equal(scope.isBlockedAdd("git add -e ."), true, "add の -e は値を取らない");
  assert.equal(scope.isBlockedDiscard("git clean -e build -fd"), true, "clean の -e は値を取る");
});

// 0.36.3 で実測した見逃し（いずれも同じ根：生の文字列を見ていた）
test("H72: まとめて実測した見逃し5件", () => {
  assert.equal(scope.isBlockedStash("git stash -m show"), true, "値が STASH_SAFE の語");
  assert.equal(scope.isBlockedAdd("git add -Av"), true, "短縮の束");
  assert.equal(scope.isBlockedAdd("git add ./"), true, "./ が表に無かった");
  assert.equal(scope.isBlockedDiscard("git clean -e build -fd"), true, "除外の値を対象と読んだ");
  // ⚠️ 初版は `git checkout -s HEAD -- .` を使っていたが、**checkout に `-s` は無い**
  // （実測: `error: unknown switch 's'`）。**git が受け付けないコマンドを期待値にしていた**ので、
  // 値を取ると実測した `restore -s` に替えた（査読の低5）
  assert.equal(scope.isBlockedDiscard("git restore -s HEAD ."), true, "-s の値を対象と読んだ");
});

test("H72: 確認だけの形は通す（束も見る）", () => {
  for (const cmd of ["git add -An", "git add -n -A", "git add --dry-run -A", "git clean -nfd"]) {
    assert.equal(scope.isBlockedAdd(cmd) || scope.isBlockedDiscard(cmd), false, cmd);
  }
});

// ---------------------------------------------------------------------------
// H73: 片側にしか無い実装
// ---------------------------------------------------------------------------

// **ソース突き合わせ検査は共有領域の中しか見ない。** 外にあるものは手で揃えるしかないので、
// **どれが片側だけなのかをテストで固定する**（増えたらここが落ちる）。
test("H73: 片側にしか無い実装の一覧を固定する", () => {
  // `repo-guard` だけ: このリポジトリ自身の規律（配布物は出さない警告）
  assert.equal(typeof guard.isAmendCommit, "function", "isAmendCommit は repo-guard だけ");
  assert.equal(scope.isAmendCommit, undefined, "git-scope には複製しない");
  // `git-scope` だけ: 配布物のコミット前ゲートが使う（repo-guard はゲートを持たない）
  assert.equal(typeof scope.changesBeforeCommit, "function", "changesBeforeCommit は git-scope だけ");
  assert.equal(guard.changesBeforeCommit, undefined, "repo-guard には複製しない");
});

// `isUnscopedCommit` は**配布側のフックから呼ばれていない**（0.36.3 で判明）。
// それでも `git-scope` に残すのは、**共有領域をひと続きに保つため**である ——
// 領域は `SEPARATORS` から `isUnscopedCommit` までで、ここだけ消すと
// 領域が2つに割れてソース突き合わせ検査が書けなくなる。**YAGNI より検査の単純さを採る。**
test("H73: `isUnscopedCommit` は共有領域の終端として両方に置く", () => {
  assert.equal(typeof scope.isUnscopedCommit, "function");
  assert.equal(typeof guard.isUnscopedCommit, "function");
});

// ---------------------------------------------------------------------------
// 0.37.2: 査読が出した回帰と取りこぼし
// ---------------------------------------------------------------------------

// **`--` があっても前を見る。** 0.37.0 は「区切りがあるときは後ろだけ」としたため、
// `restore` の `--` の前にある範囲まるごとの指定を見失った。
//
// > 実測: `git restore . --` も `git restore . -- sub/b.txt` も、**rc=0 のまま
// > 作業ツリー全体を破棄する**（使い捨てリポジトリで確認）。後者は**パスを指定している
// > ように見えて全部消す**ので、事故の形として最も起きやすい。**0.36.3 では止まっていた回帰。**
test("0.37.2 高1: `--` の前にある範囲まるごとの破棄を見逃さない", () => {
  for (const cmd of [
    "git restore . --",
    "git restore ./ --",
    "git restore :/ --",
    "git restore -W . --",
    "git restore . -- sub/b.txt",
    "git checkout . --",
  ]) {
    assert.equal(scope.isBlockedDiscard(cmd), true, cmd);
    assert.equal(guard.isBlockedDiscard(cmd), true, cmd);
  }
  // 正常な操作では鳴らない
  for (const cmd of [
    "git restore src/a.js",
    "git restore -- src/a.js",
    "git checkout main",
    "git checkout HEAD -- src/a.js",
    "git checkout -b feature/x",
  ]) {
    assert.equal(scope.isBlockedDiscard(cmd), false, cmd);
    assert.equal(guard.isBlockedDiscard(cmd), false, cmd);
  }
});

// **シェル系ごとに本体の探し方が違う。** 一律に「`c` を含むオプション」で見ると、
// PowerShell の `-ExecutionPolicy` / `-NonInteractive` に当たって**見逃す**。
test("0.37.2 中2: シェル系ごとの `-c` 本体を取り違えない", () => {
  const blocked = [
    'bash -o pipefail -c "git add -A"',
    'bash --login -c "git add -A"',
    'bash -lc "git add -A"',
    'bash -c "git add -A" name arg',
    'powershell -ExecutionPolicy Bypass -Command "git add -A"',
    'pwsh -NoLogo -NonInteractive -Command "git add -A"',
    'pwsh -Com "git add -A"',
    'cmd /c "git add -A"',
    "cmd /c git add -A",
  ];
  for (const cmd of blocked) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, cmd);
  }
  // **スクリプトを渡す形は読めない**（限界として固定する）
  for (const cmd of ["bash script.sh", "powershell -File x.ps1", "powershell -ExecutionPolicy Bypass -File x.ps1"]) {
    assert.equal(scope.isBlockedAdd(cmd), false, cmd);
  }
});

// `eval` と `-c` で本体の取り方が違う。**引用符の扱いが逆**である。
test("0.37.2: `eval` は連結して再解析、`-c` は1トークン", () => {
  // `eval` は引数を空白で連結してから再解析するので、**引用符は本当に失われる**
  // （実測: `eval f git commit -m "docs: --all dummy"` は bash で argc=6 になり `[--all]` が独立する）。
  // **査読はここを誤検知と見たが、deny が正しい。**
  assert.equal(scope.isBlockedCommitAll('eval git commit -m "docs: --all dummy" -- a.md'), true);
  assert.equal(scope.isBlockedAdd('eval "git add -A"'), true);
  // `-c` の本体は1つの引数なので引用符が残る。**ここは誤検知にしない**
  assert.equal(scope.isBlockedCommitAll('bash -c "git commit -m \\"docs: --all\\" -- a.md"'), false);
});

// ---------------------------------------------------------------------------
// 0.37.2 中3: 乖離検査しか無く、正解を1つも固定していなかった
// ---------------------------------------------------------------------------

// **`CASES` は2コピーの戻り値が一致することしか見ていない。**
// 「止める／通す」のコメントが付いているので固定されているように読めるが、
// **両コピーに同じ変異を当てると素通りする**（査読が実証した。このリポジトリの規律は
// むしろ「両方直す」を要求するので、ソース突き合わせ検査でも止まらない）。
//
// | 当てた変異 | 0.37.1 のテスト |
// |---|---|
// | `WHOLE_SCOPE` から `":/"` を外す | **素通り** |
// | `STASH_SAFE` に `"push"` を足す | **素通り** |
// | `isBlockedAdd` の `pathspecs` の検査を落とす | **素通り** |
//
// いずれも `CLAUDE.md` が名指しで禁じている形である。**正解を絶対値で固定する。**
test("0.37.2 中3: CLAUDE.md が名指しで禁じている形を絶対値で固定する", () => {
  const MUST_BLOCK = [
    ["git add -A", "isBlockedAdd"],
    ["git add .", "isBlockedAdd"],
    ["git add ./", "isBlockedAdd"],
    ["git add :/", "isBlockedAdd"],
    ["git add --all", "isBlockedAdd"],
    ["git add -- .", "isBlockedAdd"],
    ["git add -- :/", "isBlockedAdd"],
    ["git commit -a -m x", "isBlockedCommitAll"],
    ["git commit -am x", "isBlockedCommitAll"],
    ["git commit --all -m x", "isBlockedCommitAll"],
    ["git stash", "isBlockedStash"],
    ["git stash push", "isBlockedStash"],
    ["git stash push -- src/", "isBlockedStash"],
    ["git stash save wip", "isBlockedStash"],
    ["git checkout -- .", "isBlockedDiscard"],
    ["git checkout -- :/", "isBlockedDiscard"],
    ["git restore .", "isBlockedDiscard"],
    ["git restore -- .", "isBlockedDiscard"],
    ["git clean -fd", "isBlockedDiscard"],
    ["git clean -fdx", "isBlockedDiscard"],
    ["git clean -fd .", "isBlockedDiscard"],
  ];
  for (const [cmd, fn] of MUST_BLOCK) {
    assert.equal(scope[fn](cmd), true, "止めるべき: " + cmd + " (" + fn + ")");
    assert.equal(guard[fn](cmd), true, "止めるべき（repo-guard）: " + cmd);
  }
});

test("0.37.2 中3: 日常の操作では1つも鳴らない", () => {
  const MUST_PASS = [
    "git add src/a.js",
    "git add docs/ tests/",
    "git commit -m x -- a.js",
    "git status --short",
    "git log --oneline -1",
    "git diff HEAD",
    "git push",
    "git stash list",
    "git stash show",
    "git stash pop",
    "git stash apply",
    "git stash drop",
    "git checkout main",
    "git checkout -- src/a.js",
    "git restore src/a.js",
    "git clean -fd tests/",
    "git clean -n",
    "git clean -nfd",
    "git mv a.js b.js",
    "echo \"see git add -A here\"",
    "grep -rn 'git add -A' docs/",
  ];
  const all = ["isBlockedAdd", "isBlockedCommitAll", "isBlockedStash", "isBlockedDiscard"];
  for (const cmd of MUST_PASS) {
    for (const fn of all) {
      assert.equal(scope[fn](cmd), false, "通すべき: " + cmd + " (" + fn + ")");
      assert.equal(guard[fn](cmd), false, "通すべき（repo-guard）: " + cmd);
    }
  }
});

// ---------------------------------------------------------------------------
// H74 の査読: シェルの構文を1つ挟むと deny を素通りしていた
//
// `0.37.3` の独立査読が `post-branch-notice` の見逃しとして出したものを裏取りしたら、
// **同じ穴が `git add -A` の deny も素通りさせていた**（2コピーとも）。
// **`0.36.0`（ラッパーを1つ挟むと通る）と同じ型**で、あちらが `sudo` / `env` を
// 越えたのに対し、こちらはシェルの構文を越える。**ケースを消さないこと。**
// ---------------------------------------------------------------------------

test("H74査読: 制御構文の予約語の後ろでも deny が効く", () => {
  const cases = [
    "if true; then git add -A; fi",
    "if git diff --quiet; then git add -A; fi",
    "for i in 1; do git add -A; done",
    "while true; do git add -A; done",
    "until git add -A; do :; done",
    "if false; then :; else git add -A; fi",
    "! git add -A",
    "if true; then ! git add -A; fi",
    "if true; then FOO=1 git add -A; fi",
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, `repo-guard も: ${cmd}`);
  }
});

test("H74査読: PowerShell の代入で受けても deny が効く", () => {
  const ps = { shell: "powershell" };
  for (const cmd of ["$r = git add -A", "$out = git stash", "$x:y = git add ."]) {
    assert.equal(
      scope.isBlockedAdd(cmd, ps) || scope.isBlockedStash(cmd, ps),
      true,
      cmd
    );
    assert.equal(
      guard.isBlockedAdd(cmd, ps) || guard.isBlockedStash(cmd, ps),
      true,
      `repo-guard も: ${cmd}`
    );
  }
});

test("H74査読: 予約語を剥がしても、文字列やコメントでは発火しない", () => {
  // **剥がす向きに倒したので、誤検知が増えていないことを固定する。**
  const cases = [
    'git commit -m "then git add -A"',
    "echo 'if true; then git add -A; fi'",
    "echo if git add -A", // `echo` は git を実行しない
    "ls # then git add -A",
    "git commit -F - <<'EOF'\nthen git add -A\nEOF",
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd), false, cmd);
    assert.equal(guard.isBlockedAdd(cmd), false, `repo-guard も: ${cmd}`);
  }
});

// ---------------------------------------------------------------------------
// 0.38.0 の査読（誤検知と抜け道で2本に分けた）
//
// **塞いだ形の「隣の形」が残っていた。** いずれも実測で素通りしていたもので、
// `$x.y = ` / `$global:r = ` は**直す前から通っていた** —— 同じ代入なのに
// 形で差が出るのが分かりにくいので、まとめて受けるようにした。**ケースを消さないこと。**
// ---------------------------------------------------------------------------

test("0.38.0査読: PowerShell の代入は型キャスト・複合・複数・波括弧・添字も受ける", () => {
  const ps = { shell: "powershell" };
  const cases = [
    "[string]$r = git add -A",
    "[int]$r = git add -A",
    "[string[]]$r = git add -A",
    "$r += git add -A",
    "$a, $b = git add -A",
    "${r} = git add -A", // `{` は区切り文字なので断片が `= git …` に割れる
    "$x[0] = git add -A",
    "$x.y = git add -A",
    "$global:r = git add -A",
    "$null = git add -A",
  ];
  for (const cmd of cases) {
    assert.equal(scope.isBlockedAdd(cmd, ps), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd, ps), true, `repo-guard も: ${cmd}`);
  }
});

test("0.38.0査読: `return` / `coproc` も予約語として剥がす", () => {
  for (const cmd of ["return git add -A", "coproc git add -A", "if true; then coproc git add -A; fi"]) {
    assert.equal(scope.isBlockedAdd(cmd), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd), true, `repo-guard も: ${cmd}`);
  }
});

test("0.38.0査読: `Invoke-Expression` / `iex` は `eval` と同じに読む", () => {
  const ps = { shell: "powershell" };
  for (const cmd of ["iex 'git add -A'", "$r = Invoke-Expression 'git add -A'", "IEX \"git add -A\""]) {
    assert.equal(scope.isBlockedAdd(cmd, ps), true, cmd);
    assert.equal(guard.isBlockedAdd(cmd, ps), true, `repo-guard も: ${cmd}`);
  }
  // **bash では `iex` を見ない** —— Elixir の REPL が同じ名前なので方言で限る
  assert.equal(scope.isBlockedAdd("iex 'git add -A'"), false, "bash の iex は見ない");
  assert.equal(guard.isBlockedAdd("iex 'git add -A'"), false, "bash の iex は見ない");
});

test("0.38.0査読: `builtin` も包むコマンドに数える", () => {
  assert.equal(scope.isBlockedAdd("if true; then builtin eval 'git add -A'; fi"), true);
  assert.equal(guard.isBlockedAdd("if true; then builtin eval 'git add -A'; fi"), true);
});

test("0.38.0査読: 代入や予約語を広げても、まっとうな操作は止まらない", () => {
  const ps = { shell: "powershell" };
  const SAFE = [
    ["$r = git status", ps],
    ["[string]$out = git status", ps],
    ["$r += git log --oneline", ps],
    ["$msg = \"then git add -A\"", ps], // 文字列として書いただけ
    ["$x = 'git add -A'", ps],
    ["return git status", undefined],
    ["echo return git add -A", undefined],
    ["ls # coproc git add -A", undefined],
    ['git commit -m "return git add -A" -- a', undefined],
    ["if git diff --quiet; then git commit -m x -- a; fi", undefined],
  ];
  for (const [cmd, opts] of SAFE) {
    assert.equal(scope.isBlockedAdd(cmd, opts), false, cmd);
    assert.equal(guard.isBlockedAdd(cmd, opts), false, `repo-guard も: ${cmd}`);
  }
});

test("0.38.0査読: stripCommandPrefix は止まる", () => {
  // 各 replace は文字列を縮めるか不変にするだけなので、止まらない入力は作れない。
  // **念のため実測で固定する**（査読が 20,000 回で 8ms 以下と報告した）。
  const started = Date.now();
  assert.equal(scope.isBlockedAdd("then ".repeat(20000) + "git add -A"), true);
  assert.equal(scope.isBlockedAdd("$a = ".repeat(20000) + "git add -A", { shell: "powershell" }), true);
  assert.ok(Date.now() - started < 3000, "1秒台で終わること");
});

// ---------------------------------------------------------------------------
// 0.38.0 査読3 の付記: `changesBeforeCommit` が何も書き込まない形を咎めていた
//
// **誤検知の向きがコミットの deny** なので実害がある（1件目はありそうな書き方）。
// ---------------------------------------------------------------------------

test("0.38.0査読: 予約語を剥がすのは1回では足りない（コミットを止めていた）", () => {
  const cases = [
    "if ! git diff --quiet; then git commit -m a -- b; fi",
    "while ! git fetch; do sleep 1; done; git commit -m a -- b",
    "until git fetch; do sleep 1; done; git commit -m a -- b",
  ];
  for (const cmd of cases) assert.equal(scope.changesBeforeCommit(cmd), null, cmd);
  // **検出する側は変わっていない**
  assert.equal(scope.changesBeforeCommit("printf x > a.ts; git commit -- a.ts"), "printf x > a.ts");
});
