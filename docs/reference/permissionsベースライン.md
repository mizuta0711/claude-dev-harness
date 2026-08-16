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
| `.claude/settings.json` | **する**（テンプレート・派生プロジェクトへ伝播） | **deny 全部**、共有すべき allow / ask、hooks、`enabledPlugins` |
| `.claude/settings.local.json` | しない（`.gitignore`） | 手元だけの allow（個人の作業効率化）、個人的な env |

**原則: セキュリティに関わる設定を `*.local.json` に置かない。** 共有されないため派生プロジェクトが無防備になる。

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

## 3. ask のベースライン

`git push` は**テンプレート既定では allow にしない**。無確認の push は事故が戻しにくい。

```jsonc
{
  "permissions": {
    "ask": [
      "Bash(git push:*)",
      "PowerShell(git push:*)",
      "Bash(git reset:*)",
      "Bash(git checkout:*)",
      "Bash(git clean:*)"
    ]
  }
}
```

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
| 5-4 | **`prisma migrate reset` を deny しない**（`ask` + フックで守る） | **deny はフックより手前で効く**ため、`pre-migrate-backup` が働く機会を奪う。さらにハーネス自身の手順と衝突し、DB を `rm` で消す**迂回案**を誘発した |

**共通する型**: 5-1 / 5-2 / 5-4 はいずれも「**安全側に倒したつもりが安全性を損なう**」。
deny を足す前に、**それがフックや正規の手順を殺さないか**を確認する。

### 残余リスク

- `Bash` の deny はコマンド文字列のパターン照合であり、`bash -c 'rm -fr x'`・エイリアス・
  スクリプト経由の間接実行までは塞げない。**deny は事故防止であって攻撃対策ではない**
- `PowerShell(Remove-Item*-Recurse*)` は `ri -r`（別名+短縮フラグ）を塞がない。
  別名の網羅は現実的でないため未対応とする
- `.env.staging` のような**列挙外の命名**は 5-2 の deny をすり抜ける。
  独自の環境名を使うプロジェクトは `.claude/settings.json` に追加すること
</content>
