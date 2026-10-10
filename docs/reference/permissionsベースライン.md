# permissions ベースライン（テンプレートの `settings.json` が実装する方針）

| 項目 | 内容 |
|------|------|
| 位置づけ | **方針の正典**。この文書自体は動作しない。`templates/base` / `templates/<env>` の `.claude/settings.json` が実装する |
| 裏取り | Claude Code 公式ドキュメント（permissions / settings / mcp / skills）で確認済み。コロンなしワイルドカード（`Bash(rm -rf *)`）は有効、`Read()` の deny は Bash の `cat`/`head`/`tail`/`sed` にも波及する |
| 実測 | **2026-08-14 に全項目を実測済み**（Claude Code 2.1.220 / headless `claude -p` + `--output-format json` の `permission_denials`）。下記 §2 は実測結果を反映した形になっている |
| 検証の記録 | 検証方法・結果の詳細・その後に発覚した4件は **ProjectTemplete リポジトリ `docs/reviews/20260814_permissions実機検証と発覚事項.md`**。§5 の決定を疑う前にそちらを読む |

## 1. 層の分離

| ファイル | Git 管理 | 置くもの |
|---------|---------|---------|
| `.claude/settings.json` | **する**（テンプレート・派生プロジェクトへ伝播） | **deny 全部**、共有すべき allow、`extraKnownMarketplaces`（`permissions.ask` は置かない → §3。hooks はプラグインが配る） |
| `.claude/settings.local.json` | しない（`.gitignore`） | 手元だけの allow（個人の作業効率化）、個人的な env |

**原則: セキュリティに関わる設定を `*.local.json` に置かない。** 共有されないため派生プロジェクトが無防備になる。

**`ask` はどの層からも打ち消せない。** 上位層の `allow` でも `settings.local.json` でも、フックの `allow` でも覆らない
（§3 の実測）。マシンごとに変えたい確認は `permissions.ask` に置かず、`askGuards`（§3）で扱う。

## 2. deny のベースライン

```jsonc
{
  "permissions": {
    "deny": [
      // 秘密情報の読み書き
      //   `Edit(path)` はファイル編集ツール全般（Write / NotebookEdit 等）を覆う。
      //   `Write(path)` はファイル権限チェックの対象外で、書いても効かないうえ
      //   起動時に警告が出る（§5-1）
      //
      //   ⚠️ ここだけ「ワイルドカードで変種を拾う」方針の**例外**として列挙している。
      //   `.env*` だと `.env.example` まで塞いでしまい、`.gitignore` の `!.env.example`
      //   （＝コミット対象）と矛盾する。deny はツール層で「今回だけ許可」ができないため、
      //   シェル経由の迂回を誘発する（§5-2）。実際に秘密を持つファイルだけを列挙する
      "Read(./.env)",
      "Read(./.env.local)",
      "Read(./.env.development)",
      "Read(./.env.development.local)",
      "Read(./.env.production)",
      "Read(./.env.production.local)",
      "Read(./.env.test)",
      "Read(./.env.test.local)",
      "Read(./secrets/**)",
      "Edit(./.env)",
      "Edit(./.env.local)",
      "Edit(./.env.development)",
      "Edit(./.env.development.local)",
      "Edit(./.env.production)",
      "Edit(./.env.production.local)",
      "Edit(./.env.test)",
      "Edit(./.env.test.local)",

      // Read deny が波及しない経路を塞ぐ
      //   公式に波及が明記されているのは cat / head / tail / sed。
      //   grep / Select-String / type などは明記が無いため個別に塞ぐ。
      //   ここは `.env*` のワイルドカードのまま残す（秘密の漏れを塞ぐ方を優先）
      "Bash(grep * .env*)",
      "Bash(rg * .env*)",
      "PowerShell(Select-String*.env*)",
      "PowerShell(Get-Content*.env*)",

      // 破壊的削除
      //   `Bash(rm -rf *)` は `rm -fr` / `rm -r` / `rm --recursive` を取りこぼす（§5-3）。
      //   rm はフラグを1トークンに結合するため、綴りごとに列挙する。`rm plain.txt` は通る
      "Bash(rm -r*)",
      "Bash(rm -f*)",
      "Bash(rm --recursive*)",
      "Bash(rm --force*)",
      "PowerShell(Remove-Item*-Recurse*)",   // 引数順序に依存しない形

      // force push（refspec 形式も塞ぐ）
      "Bash(git push --force*)",
      "Bash(git push -f *)",
      "Bash(git push * +*)",
      "PowerShell(git push --force*)",
      "PowerShell(git push -f *)",
      "PowerShell(git push * +*)"
    ]
  }
}
```

## 3. ask のベースライン（`guarded-command-ask` フックが実装する）

**テンプレートの `settings.json` は `permissions.ask` を持たない**（H46・harness-core 0.21.0）。
止める操作は `harness.config.json` の `askGuards.sets` で選び、harness-core の
`guarded-command-ask` フックが `permissionDecision: "ask"` を返す。

`git push` は**テンプレート既定では allow にしない**。無確認の push は事故が戻しにくい。

### なぜ `permissions.ask` ではないのか

**`permissions.ask` はマシン別に無効化できない。** 権限を絞った専用ユーザーで動かす VPS のように
「このマシンでは確認を出さない」が妥当な環境があっても、打ち消す手段が無い。

実測（2026-10-02・Claude Code 2.1.270・headless `claude -p` の `permission_denials`）:

| 試した方式 | モード | 結果 |
|---|---|---|
| user 層の `permissions.allow` で同じコマンドを許可 | bypass | **止まる**（ask が勝つ） |
| PreToolUse フックが `permissionDecision: "allow"` を返す | default / bypass | **止まる** |
| PreToolUse フックが `permissionDecision: "ask"` を返す | bypass | **止まる**（`permissionDecisionReason` が画面に出る） |
| どのリストにも無いコマンド | bypass | 素通り |

つまり **deny > ask > allow は層をまたいで絶対で、フックの `allow` でも ask ルールは覆らない**。
一方、**フックが返す `ask` は bypass / auto を貫通する**。だから止めるかどうかの判断をフックに置き、
フックがマシンを見て出し分ける。

### 信頼済み環境

次のどちらかがあるマシンでは、フックは**何も返さない**（bypass なら無確認で通る）。

- `~/.claude/.harness-trusted-env`（中身は問わない。置いた理由を書いておく）
- 環境変数 `HARNESS_TRUSTED_ENV=1`（**値は `1` だけ**。`true` / `yes` では効かない）

**ホームしか見ない。** リポジトリ内に同名ファイルを置いても効かない。

### 集合

| 集合 | 止めるもの | 有効にしているテンプレート |
|---|---|---|
| `git-destructive` | `git push` / `reset` / `checkout` / `clean` | 全環境 |
| `prisma-schema-change` | `prisma migrate dev` / `deploy` / `reset` / `resolve`、`prisma db push` | nextjs |
| `android-device` | `gradlew installDebug` / `uninstallDebug` / `uninstallAll`、`adb install` / `uninstall` | android |

`askGuards` が無い config では、**`git-destructive` ＋ `environment` に応じた集合**（上の表の既定）が有効になる。
**JSON が壊れた config では `git-destructive` だけ**になる（`environment` も読めないため）。素通りにはしない。
`harness-update` が settings.json の ask 削除だけを当て、config への `askGuards` 追加を見送っても守りが消えないようにするため。
**config 自体が無いリポジトリでは何もしない**（harness-core は user スコープでも入るので、ハーネス未導入のリポジトリで止め始めないため）。

**ラッパー経由の起動も拾う**（harness-core 0.36.0・H70）。**`sudo git push` / `env` / `time` / `timeout` / `nice` / `xargs` / `setsid` / `doas` / フルパスの `git.exe` は確認にかかる** ——`sudo` の付け忘れ・付け足しは実際に起こるので、**拾わないと事故の形で素通りする**。
**判定はラッパー直後の「最初の実コマンド」で行う**ので、`sudo echo git push` のように**別のコマンドが動く形では鳴らない**。
**シェルの構文を1つ挟んだ形も拾う**（harness-core 0.38.0）—— **`if` / `then` / `do` / `else` / `while` / `until` / `!` の後ろと、
PowerShell の `$out = git push` のような代入で受ける形**。いずれも**区切り文字では割れない**ため、
断片の先頭が予約語や代入になった時点で**その後ろの git を見ていなかった**（実測）。

**引用符の中の `-c` 本体も拾う**（harness-core 0.37.0・H69）。
`bash -c "git push"` / `sh -c 'git push'` / `eval "git push"` / `sudo bash -c "…"` / 束の `bash -lc "…"` /
`bash -o pipefail -c "…"` / `powershell -ExecutionPolicy Bypass -Command "…"` / `cmd /c "…"` は**確認にかかる**。

**対象外は「本体がこの文字列の中に無い」形**（`bash deploy.sh` / `powershell -File x.ps1` /
`powershell -EncodedCommand <base64>`）—— 中身はファイルや別の符号の側にあり、
**読みに行くとフックがファイルシステムに依存する**ので、見逃しとして残してある（→ §3 の残る限界）。

### 何を止めるかの方針

**`ask` は bypassPermissions でも止まる**（フック由来の `ask` も同じ）。bypass で運用する利用者にとって、
`ask` は「確認が要る操作」ではなく「**毎回そこで作業が止まる操作**」になる。サブエージェントの中で
聞かれると、気づくまで全体が止まる。**だから `ask` は、止めてでも人が見るべき操作だけに絞る。**

- **読み取りだけの操作を巻き込まない。** 例: prisma は DB を変えるサブコマンドだけを止め、
  `status` / `diff` は止めない（`pre-migrate-backup` が読み取り専用として扱う集合と同じ）
- **コマンド位置で判定する。** `git-scope.scanCommands()` で引用符・コメント・ヒアドキュメントの外にある
  コマンドの先頭だけを見る。`cd X && DATABASE_URL=... npx prisma migrate deploy` や
  `git -c k=v push` は止め、`git commit -m "git push は禁止"` は止めない。
  **本文の引用符で状態が反転して後続を見落とす形は 0.31.3 で解消した**（下の残余リスク）
- **シェルの方言で読み方を変える。** `Bash` と `PowerShell` はエスケープ文字が違う（`\` と `` ` ``）。
  ツール名から判断し、PowerShell の `cd "D:\work\"; git push` でも後続を見落とさない（H47）
- **`git` のグローバルオプションはトークン単位で飛ばす。** `git -C "D:/my proj" push` /
  `git --git-dir x push` / `git -P push` のいずれもサブコマンドを取り違えない（H47）
- **破壊的でない実行は止めない。** wpf の `dotnet run` は H39 で外した。アプリを起動するだけで、
  サブエージェントが scratchpad の使い捨てプロジェクトで API を調べるたびに止まっていた
- **判定パターンを `harness.config.json` に書かせない。** config は集合名を選ぶだけにする。
  §5 の 5-2 / 5-3 はどちらも「パターンを書き間違える・単純化する」ことで起きた。判定はコードに持ち、テストで守る
- 止めない操作も、**allow に無い限り通常モードでは従来どおり確認が出る**。変わるのは bypass / auto だけ

### 配っている allow のうち、フックが使わないもの

**`templates/nextjs/.claude/settings.json` の `Bash(npx eslint:*)` は、フックのためではない。**
`post-edit-lint` は `node_modules/.bin/eslint` を**直叩き**する（`npx` 経由だと毎編集に約 0.9 秒
上乗せされる。0.37.1 で冒頭コメントの食い違いを直した）。**フックは permissions を経由しない**ので、
この allow はあくまで**人や Claude が手で `npx eslint` を打つとき**のものである。

> **実装が使わなくなった allow を黙って消さない。** 消すと手打ちのときだけ確認が増え、
> 「なぜ消えたか」が残らない。**使い道が変わったことを書いて残す**（査読の低2）。

### 残余リスク（承知のうえで採っている）

- **harness-core を無効化すると確認が一切出なくなる。** `permissions.ask` 時代はプラグイン無しでも止まった
- **信頼済み環境では `git push` も無確認になる。** force push は `deny`（§2）なので引き続き止まる
- **判定の取りこぼしの責任がハーネス側に移る。** 集合を増やすときは `tests/guarded-command-ask.test.mjs` にケースを足す
- ~~**引用符の状態が反転して後続を見落とす形が残っている**~~ → **harness-core 0.31.3 で解消**（H50）。
  `scanCommands()` が**ヒアドキュメントと PowerShell ヒアストリングの本文を先に空白へ潰す**ようになった
  （`maskHereBodies`。長さは変えないので、インデックスを使う呼び出し側の契約は壊れない）。
  取りこぼしていたのは次の2形で、**どちらも実測で再現させてから直した**。
  - `"$(…)"` の中のヒアドキュメント（Claude Code 標準のコミット形）で、本文の `"` が奇数個
  - PowerShell の here-string（`@'…'@` / `@"…"@`）で、本文に囲みと同じ引用符が奇数個

  **⚠️ 0.31.3 の `maskHereBodies` 自身が、別の見逃しを5形作っていた**（0.34.0 で解消）。
  **本文を潰す条件が緩すぎた** —— ①導入部の行をまるごと潰していたので
  `cat <<EOF | git add -A` の後半が消えた ②**シェルへ渡す本文（`bash <<EOF` / `ssh h <<EOF`）は
  実際に実行される**のに潰していた ③`<<<`（ヒアストリング）と算術のシフト（`$((1 << N))`）を
  ヒアドキュメントと誤認し、終端が無いので後続を全部潰した。
  **潰すのは `<<delim` のトークンと本文の行だけ**にし、
  **本文を受け取るコマンドが `cat` / `tee` / `git` のときに限った**
  （許可リストにしてあるのは、**知らないコマンドを「潰さない」側へ倒すため**）。

  **それでも足りなかった**（0.34.2）—— **`cat` は本文を出力へ流すだけで、
  その先が実行系なら実行される**（`cat <<EOF | bash` / `source <(cat <<EOF … )`）。
  **導入部の行に実行系（`bash` / `sh` / `eval` / `source` / `xargs` 等）があれば潰さない**条件を足した。

  **0.35.0 で禁止リストから許可リストへ反転した。** 0.34.0〜0.34.2 は
  「実行系を見つけたら潰さない」で、**3回続けて前提が崩れた**
  （`bash <<EOF` → `cat <<EOF | bash` → `cat <<EOF | $SHELL` / `| . /dev/stdin` / 関数 / 別の行）。
  **名前を並べる方式は収束しない** —— 別名・変数・関数・別の行で抜ける
  （査読が13形を実測し、**うち5形は実際に本文が実行されることまで確かめた**）。

  **いまは「確実に安全な形のときだけ潰す」。**

  **許可リストは2つの軸で閉じる**（0.35.1。**0.35.0 は導入部の行だけを見ており、
  その行を包む外側を見ていなかった** —— 査読が `(cat <<EOF … EOF
) | bash` と
  `bash -c "$(cat <<EOF … )"` の見逃しを**実行確認つきで**出した）。

  | 軸 | 潰す条件（**すべて**満たすとき） |
  |---|---|
  | **① 導入部の行の中** | 本文を受け取るのが **`cat` / `tee` / `git` / `gh`**（前置きの環境変数代入と `sudo` / `env` / `command` / `nohup` / `time` / `xargs` は飛ばす） |
  | | 導入部に**コマンドの区切りも置換も無い**（`|` `;` `&` `` ` `` `$(` `>(` `>&`） |
  | | `<<DELIM` の**後ろもリダイレクトかコメントだけ** |
  | | **`git` はメッセージを読むサブコマンドだけ**（`commit` / `tag` / `notes` / `merge` / `revert` / `cherry-pick`）。**`-c` は認めない** —— `git -c alias.x='!bash' x <<EOF` は本文が実行される |
  | **② 行を包む外側** | **閉じていない素のグループ（`(…)` / `{…}`）の中ではない** —— `(cat <<EOF … EOF` の次に `) | bash`、`{ cat <<EOF … EOF` の次に `} | bash` が来る形は**閉じ括弧の後ろで実行される**（終端より後ろなので行の判定に入らない）。**グループの深さを数える**ので、`{` が別の行にあっても・関数定義の中でも効く |
  | | **プロセス置換（`<(` / `>(`）の中ではない** |
  | | **バッククォートの中ではない** |
  | | **`$(…)` の中なら、外側の「先頭の」コマンドが `git` のメッセージ引数のときだけ** —— `bash -c "$(cat …)"` / `eval "$(cat …)"` / `eval git commit -m "$(cat …)"` は値が実行される（**どこかに `git` があれば通す形にしていて素通りした**） |
  | | **`gh` も `git` と同じくサブコマンドを限る**（`pr` / `issue` / `release` / `gist` / `api`）—— `gh alias set x '!bash'; gh x <<EOF` の形がある |
  | | **グループの深さを数えるときは、ヒアドキュメントの本文・引用符の中・`#` コメント・`\` のエスケープを読み飛ばす** —— **文書の本文にはコード例が入る**ので、`function f() {` を書くだけで**次の文書書き込みが鳴っていた**（0.35.3。H65 が直そうとした問題の再発） |

  **どれか外れたら潰さない＝許容されている誤検知**に倒れる。
  **不確かなものは全部そちらへ落ちるので、見逃しを新しく作らない。**

  ⚠️ **残る限界。** **テストで固定してある**（直したら期待値を変える）。

  1. ~~**引用符の中は見えない**~~ → **harness-core 0.37.0 で解消**（H69）。
     **`bash -c "git add -A"` / `sh -c '…'` / `eval "…"` が、ヒアドキュメント無しでも素通りしていた**（実測）。
     直し方は「**引用符の中を一緒に走査する**」ではない —— あれは H50 で踏んだ事故の側である。
     **`-c` の後ろを取り出して、同じ規則で読み直す**（`wrappedCommand`）。
     あわせて**二重引用符の中のコマンド置換**（`echo "$(git add -A)"`）も読み直す（H71 ①）。
     **シェル系ごとに本体の探し方が違う**（0.37.2 で揃えた）。一律に「`c` を含むオプション」で
     見てはいけない —— PowerShell には `-ExecutionPolicy` / `-NonInteractive` のように
     **小文字の `c` を含む実在のフラグ**があり、そこを本体の位置と取り違えると**見逃す**
     （実測で3形。査読が出した）。`eval` と `-c` では**引用符の扱いが逆**である ——
     `eval` は引数を連結して再解析するので引用符は本当に失われ（実測: bash で `argc=6`）、
     `-c` の本体は1つの引数なので残る。`cmd /c` は残り全部を受け取る。

     **残るのは「本体がこの文字列の中に無い」形**（`bash deploy.sh` / `powershell -File x.ps1` /
     `-EncodedCommand`）—— 中身はファイルや別の符号の側にあり、
     読みに行くとフックがファイルシステムに依存するので、**見逃しとして残す**。
     下の 3 と同じ「本文を別の場所へ書く形」である
  2. ~~**ラッパーを1つ挟むと見えない**~~ → **harness-core 0.36.0 で解消**（H70）。
     **`sudo git add -A` / `env` / `time` / `eval` / `command` / `nohup` / `nice` / `xargs` /
     `/usr/bin/git` がすべて素通りしていた**（実測）。`parseGit` が**先頭トークンしか見なかった**ため。
     **包むだけのコマンドとパス付きの形を越えて `git` を探す**ようにした（`gitTokenIndex`）。
     **`echo` / `cp` は包むコマンドに入れない** —— あれは `git` を実行しないので、
     入れると `echo git add -A` で鳴る。**`parseGit` は全判定の入口なので、
     `commit -a` / `stash` / 範囲指定なしの破棄・`guarded-command-ask` の確認にも効く**
  3. ~~**シェルの構文を1つ挟むと見えない**~~ → **harness-core 0.38.0 で解消**（**断片の先頭に来る形**）。
     **`if true; then git add -A; fi` / `for i in 1; do git add -A; done` / `! git add -A` /
     PowerShell の `$r = git add -A` がすべて素通りしていた**（実測）。
     予約語も代入も**区切り文字では割れない**ため、断片の先頭トークンが `then` などになり、
     **コマンド位置を見失っていた**。**2 と同じ型**で、あちらが `sudo` / `env` を越えたのに対し、
     こちらはシェルの構文を越える（`stripCommandPrefix`）。
     **環境変数の代入はここで剥がしてはいけない** —— 値の枝が引用符を跨いで食うことがあり、
     剥がした本文を渡すと**引用符の中のコマンド置換が壊れて逆に素通りする**（テストが落ちて分かった）。

     **剥がすのは「断片の先頭に置かれた構文」だけである。** 受けるのは
     予約語9種（`if` / `then` / `elif` / `else` / `while` / `until` / `do` / `time` / `coproc`）・
     `!`・`return`・PowerShell の代入（**型キャスト・複合代入・複数代入・波括弧つき・添字つき**を含む）。
     **先頭以外に現れる構文や、本体を別の場所へ書く形は 4 の限界**に当たる。
     あわせて **PowerShell の `Invoke-Expression` / `iex` も `eval` と同じに読む**ようにした
     （bash では `iex` を見ない —— Elixir の REPL が同じ名前なので方言で限る）
  4. **本文を別の場所へ書いて、あとで実行する形**（`cat > x.sh <<EOF … EOF` → 別のコマンドで `sh x.sh`、
     FIFO、`/dev/fd/N`、`git -c alias.x='!sh'`）。
     これは `echo 'git add -A' > x.sh; sh x.sh` でも同じく見えないので、**この解析の範囲外**である

  **引数は生の文字列ではなくトークンで見る**（0.37.0・H72）。
  `-m "a -- b"` のメッセージ中の `--` を区切りと読んで**警告が出なかった**一方、
  `-m "docs: --all を禁じる"` のメッセージ中のオプション名で **deny していた**（どちらも実測）。
  **同じ根から見逃し5件も出ていた**（`git stash -m show` / `git add -Av` / `git add ./` /
  `git clean -e build -fd` / `git checkout -s HEAD -- .`）。
  **値つきオプションの表はサブコマンドごとに持つ** —— `-e` は `clean` では値を取るが
  `add` では取らないので、**一律の表にすると `git add -e .` の `.` を飲んで見逃す**
  （`WRAPPER_VALUE_FLAGS` と同じ理由）。
  **表には実測で値を取ると確かめたものだけを入れる** —— 0.37.0 は `checkout` に
  実在しない `-s` を、値を取らない `-t` / `--track` とともに入れていた（0.37.2 で外した）。

  ⚠️ **`--` があっても前を見る。** 0.37.0 は「区切りがあるときは後ろだけ」としたため、
  **`git restore . --` と `git restore . -- <path>` が deny を素通りした**（0.36.3 では
  止まっていた回帰で、査読が実物の git で `rc=0` のまま作業ツリー全体が消えることを確かめた）。
  **`restore` は `--` の前後どちらもパス指定**である。後者は**パスを指定しているように見えて
  全部消す**ので、事故の形として最も起きやすい。

  `tests/git-scope.test.mjs` が**すり抜けと誤警報を対にして**押さえている（2コピー両方に当てている）。
  **本文を飛ばしすぎる方向にも間違う** — `-- <path>` を見失うと**正常なコミットで警告が鳴る**ので、
  そちらもテストに入れてある（§8「安全弁は正常な操作で鳴らないことが要件」）。

## 4. allow の方針

- 読み取り系（`Read` / `Glob` / `Grep`）と、破壊的でない git 参照系（`status` / `diff` / `log` / `show` / `branch`）
- 環境ごとのビルド・チェックコマンドは **`harness.config.json` の `commands` に書かれたものと一致させる**
  （config で実行するコマンドが allow に無いと、hook 経由の実行で毎回確認が入る）
- 個人の趣味に属するもの（エディタ起動、雑多な CLI）は `settings.local.json` へ

## 5. 単純化してはいけない4点

いずれも**一度単純な形にして事故が起きた**もの。**「もっと短く書けるのでは」と思ったら、
まず ProjectTemplete `docs/reviews/20260814_permissions実機検証と発覚事項.md` を読むこと。**

| # | 決定 | 単純化すると起きること |
|---|------|----------------------|
| 5-1 | **`Write(path)` を deny に書かない。`Edit(path)` を使う** | `Write` はファイル権限チェックの対象外で照合されない。**書いても保護にならず**、毎回起動時に警告が出る |
| 5-2 | **`.env` は `.env*` でなく列挙する** | `.env.example` を巻き込む。`.gitignore` の `!.env.example` と矛盾し、AI が雛形を読めず・作れなくなる。deny は「今回だけ許可」ができないため**シェル経由の迂回が常態化**する |
| 5-3 | **`rm` はフラグの綴りごとに列挙する** | `Bash(rm -rf *)` だけでは **`rm -fr` が通る**（実測でディレクトリが消えた）。rm はフラグを1トークンに結合するため、中間ワイルドカードによる順序非依存化が効かない |
| 5-4 | **`prisma migrate reset` を deny しない**（`askGuards` の `ask` + `pre-migrate-backup` で守る） | **deny はフックより手前で効く**ため、`pre-migrate-backup` が働く機会を奪う。さらにハーネス自身の手順と衝突し、DB を `rm` で消す**迂回案**を誘発した |

**共通する型**: 5-1 / 5-2 / 5-4 はいずれも「**安全側に倒したつもりが安全性を損なう**」。
deny を足す前に、**それがフックや正規の手順を殺さないか**を確認する。

### 残余リスク

- `Bash` の deny はコマンド文字列のパターン照合であり、`bash -c 'rm -fr x'`・エイリアス・
  スクリプト経由の間接実行までは塞げない。**deny は事故防止であって攻撃対策ではない**
- `PowerShell(Remove-Item*-Recurse*)` は `ri -r`（別名+短縮フラグ）を塞がない。
  別名の網羅は現実的でないため未対応とする
- `.env.staging` のような**列挙外の命名**は 5-2 の deny をすり抜ける。
  独自の環境名を使うプロジェクトは `.claude/settings.json` に追加すること
