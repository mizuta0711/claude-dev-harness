import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
// `bash -c "…"` / `eval "…"` の中は**ヒアドキュメントが無くても見えない**。
//
// > 実測: `bash -c "git add -A"`（ヒアドキュメント無し）も `false` である。
// > **この修正による回帰ではなく、元からある限界**である。
// > 引用符の中を走査する形は H50 で「やってはいけない」と決めた側なので、
// > ここを直すには別の設計が要る（ProjectTemplete の **H69**）。
test("H65: 引用符の中は見えない（元からの限界。直したら期待値を変える）", () => {
  const cases = [
    'bash -c "git add -A"',
    'eval "git add -A"',
    ["bash -c \"$(cat <<EOF", "git add -A", "EOF", ")\""].join("\n"),
    ["eval \"$(cat <<'EOF'", "git add -A", "EOF", ")\""].join("\n"),
  ];
  for (const cmd of cases) {
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
test("H65: 引用符の中は見えない（元からの限界。ラッパー越しは H70 で直した）", () => {
  const quoted = [
    'bash -c "git add -A"',
    "sh -c 'git add -A'",
    'eval "git add -A"',
    ["bash -c \"$(cat <<EOF", "git add -A", "EOF", ")\""].join("\n"),
    ["eval \"$(cat <<'EOF'", "git add -A", "EOF", ")\""].join("\n"),
  ];
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
