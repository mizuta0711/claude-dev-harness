---
name: pre-push-check
description: git push 前に必ず実行する。未プッシュの全コミットが設計書に同期済みかを台帳と突き合わせて高速チェックする。
allowed-tools: "Bash(git log:*), Bash(git diff:*), Bash(git diff-tree:*), Bash(git show:*), Grep, Read"
---

# プッシュ前 設計書同期チェック（config 駆動）

git push の前に必ず実行する。`.claude/harness.config.json` の `designDocs.ledger`
（既定: `docs/設計書/.doc-sync.md`）に全コミットハッシュが記録されているかを確認する。

## Step 0: 設定の読み込み

| 使う設定 | 用途 |
|---------|------|
| `designDocs.ledger` | 台帳のパス |
| `paths.source` | 「ソース変更あり」の判定に使う glob 群 |

config が読めない場合: 台帳が `docs/設計書/.doc-sync.md` にあれば推定で続行し、
その旨を報告に明記する。台帳も無ければ「チェック不能」として報告し、push の可否はユーザーに委ねる。

## Step 1: 未プッシュコミットの列挙

```
git log --format=%h @{upstream}..HEAD
```

出力が空なら「未プッシュのコミットはありません」と報告して終了する。
（upstream が未設定の場合は `git log --format=%h -20` 等で範囲をユーザーに確認する）

## Step 2: コミットごとの判定

各コミットについて:

1. 変更ファイルを取得: `git diff-tree --no-commit-id --name-only -r {hash}`
2. **SKIP 判定**: 変更ファイルが `paths.source` のどの glob にも一致しない場合は
   「ソースコード変更なし」として SKIP（設計書・ドキュメントのみのコミット等）
3. 一致するものがある場合、台帳にそのハッシュが記録されているか検索する
   - 記録あり → OK
   - 記録なし → **MISSING**

> パスの比較はリポジトリルートからの相対パス・フォワードスラッシュで行う（Windows でも `/` に揃える）。

## Step 3: 判定と対応

- **MISSING なし** → `✅ プッシュ可能` と報告して終了
- **MISSING あり** → 該当コミットの内容を `git show --stat {hash}` で確認し、
  `/harness-core:update-docs` を実行して設計書と台帳を更新する。更新後、Step 2 を再実行して全て記録済みになったことを確認する

**全コミットが記録されるまでプッシュしないこと。**

## Step 4: 結果報告

```
## プッシュ前チェック結果

### チェック対象: N件のコミット（SKIP: M件 = ソース変更なし）
### 未同期: 0件（または K件 → 修正済み）
### 判定: ✅ プッシュ可能 / ❌ 未同期あり
```
