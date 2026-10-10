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
