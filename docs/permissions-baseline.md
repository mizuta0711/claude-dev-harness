# permissions ベースライン（Phase 2 の `settings.json` 雛形が実装する方針）

| 項目 | 内容 |
|------|------|
| 位置づけ | **設計記録**。この文書自体は動作しない。Phase 2 の `templates/base` / `templates/<env>` の `.claude/settings.json` 雛形が実装する |
| 根拠 | Phase 0 の発見事項 F1〜F3・F7 と、レビュー追加発見 R2・R3・R5（ProjectTemplete `docs/reviews/20260814_094949_phase0-fixes_レビュー.md`） |
| 裏取り | Claude Code 公式ドキュメント（permissions / settings / mcp / skills）で確認済み。コロンなしワイルドカード（`Bash(rm -rf *)`）は有効、`Read()` の deny は Bash の `cat`/`head`/`tail`/`sed` にも波及する |

## 1. 層の分離（F1）

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
      // 秘密情報の読み取り（R5: 列挙ではなくワイルドカードで変種を漏らさない）
      "Read(./.env*)",
      "Read(./secrets/**)",
      "Edit(./.env*)",
      "Write(./.env*)",

      // Read deny が波及しない経路を塞ぐ（R3）
      //   公式に波及が明記されているのは cat / head / tail / sed。
      //   grep / Select-String / type などは明記が無いため個別に塞ぐ
      "Bash(grep * .env*)",
      "Bash(rg * .env*)",
      "PowerShell(Select-String*.env*)",
      "PowerShell(Get-Content*.env*)",

      // 破壊的削除
      "Bash(rm -rf *)",
      "PowerShell(Remove-Item*-Recurse*)",   // F2: 引数順序に依存しない形にする

      // force push（F3: refspec 形式も塞ぐ）
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

## 3. ask のベースライン（F7・R2）

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

## 5. 未検証事項（Phase 2 で実測する）

| # | 内容 |
|---|------|
| 1 | `Bash(grep * .env*)` 形式が実際にマッチするか（`*` の位置と引数境界の扱い） |
| 2 | `PowerShell(Remove-Item*-Recurse*)` が引数順序に依存せず機能するか |
| 3 | `Bash(git push * +*)` が refspec 形式の force push を実際に捕まえるか |

**上記3点は「そう書けば塞げるはず」という設計であり、実機確認は未了。**
Phase 2 で雛形に入れる際、実際に拒否されることを確認してから採用すること。
