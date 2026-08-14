---
name: build-check
description: harness.config.json の commands に定義されたビルド・型チェック・lint・テストを一括実行し、結果を表で報告する。
allowed-tools: "Read, Glob"
---

# ビルド＋品質チェック（config 駆動）

実行するコマンドは `.claude/harness.config.json` の `commands` が決める。
**このスキルは特定のコマンド名（npm / dotnet 等）を前提にしない。**

## Step 1: 設定の読み込み

`.claude/harness.config.json` を読む。

- **config が無い / 壊れている** → コマンドは実行せず、次の1行で報告して終了:
  `ビルド＋品質チェックをスキップしました: .claude/harness.config.json が読めません。`
- **`commands` が全て null** → 実行せず次の1行で報告して終了:
  `この環境には CLI チェックがありません（commands は全て null）。動作確認は verification の手段で行ってください。`

## Step 2: 実行順序の決定

`commands` のうち **非 null のものだけ** を、以下の順で実行する:

1. `typecheck`
2. `build`
3. `lint`
4. `format`（`--verify` 系の検証用途を想定。書き換えを伴うコマンドが設定されている場合は実行前にユーザーへ確認する）
5. `test`

`dev` は**実行しない**（開発サーバーの起動はこのスキルの責務ではない）。

## Step 3: 実行前の存在確認

コマンドの実行ファイル・依存が未整備な状態（例: 依存パッケージ未インストール、SDK 未導入）では、
**そのコマンドをスキップし、理由を報告に残す**。フローを止めない。

判断材料の例:
- 依存ディレクトリ・マニフェストの有無（`node_modules/`、`package.json`、`*.sln`、`*.csproj` 等）
- コマンド本体の存在確認（`--version` 等の軽い呼び出し）

## Step 4: 結果報告

```
## ビルド＋品質チェック結果

| # | チェック | コマンド | 結果 |
|---|---------|---------|------|
| 1 | typecheck | {commands.typecheck} | ✅ 成功 / ❌ 失敗 / ⬜ スキップ（理由） |
| 2 | build | {commands.build} | |
| 3 | lint | {commands.lint} | |
| 4 | format | {commands.format} | |
| 5 | test | {commands.test} | |

### エラー・警告
（失敗したコマンドの出力を、原因が分かる範囲で抜粋。既存 warning と新規 warning を区別する）

### 総合判定: ✅ コミット可 / ❌ 修正必要
```

## Step 5: エラーがある場合

- 失敗したコマンドの出力から原因を特定し、修正を提案する
- 今回の変更と無関係な既存 warning は無視してよい（その旨を明記する）
