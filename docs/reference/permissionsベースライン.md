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

**ラッパー経由の起動は対象外**（`bash -c "git push"` / `sudo` / `cmd /c` / フルパスの `git.exe` 等）。`permissions.ask` 時代も同じく拾っていなかった。

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
