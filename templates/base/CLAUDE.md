# CLAUDE.md — {{PROJECT_NAME}}

対話は日本語で行うこと。

## プロジェクト概要

{{PROJECT_NAME}} は {{PROJECT_DESCRIPTION}}。

<!-- TODO: 対象ユーザー・主要機能・スコープを記入する。
     詳細な要件・設計は docs/ 配下に置き、ここには1〜2段落の要約だけを残す。 -->

## 開発フロー

**すべての作業（新規機能・改修・バグ修正）は規模判定 S/M/L から始める。**
入口は `/harness-core:new-feature`。判定基準・各規模のフロー・バグ修正フローは
スキルが読み込む「開発フローと規模判定」に定義されている（CLAUDE.md には複製しない）。

| 規模 | フロー |
|------|--------|
| S（軽微・1ファイル程度） | 実装 → `/harness-core:build-check` → コミット → `/harness-core:done` |
| M（機能追加・複数ファイル・UX変更なし） | 設計 → 実装 → `/harness-core:code-review` → 動作確認 → `/harness-core:build-check` → `/harness-core:update-docs` → コミット → `/harness-core:done` |
| L（新機能・大規模変更・UX変更あり） | Stage 1 設計 → `/harness-core:design-review feature` → ユーザー承認 → Stage 2 設計 → `/harness-core:design-review tech` → 実装 →（以降 M と同じ） |

規模判定は **AI が推測 → ユーザーが承認** の2ステップ。迷ったら L 寄りで提示し、
**UX 変更（画面・操作フローの変更）を含む場合は自動的に L** として扱う。

### スキル一覧

| スキル | 用途 |
|--------|------|
| `/harness-core:new-feature` | 機能設計書をテンプレートから作成する。規模判定と曖昧さの解消まで行う（フローの入口） |
| `/harness-core:design-review` | 設計書のレビュー。`feature` = Stage 1、`tech` = Stage 2 |
| `/harness-core:code-review` | 実装レビュー。設計書との突き合わせ・エラー処理・セキュリティを確認し修正まで行う |
| `/harness-core:build-check` | `harness.config.json` の `commands` を一括実行し結果を表で報告する |
| `/harness-core:update-docs` | 実装変更に基づいて `docs/設計書/` を更新し、台帳に記録する |
| `/harness-core:sync-check` | 設計書と実装の網羅的な突き合わせ（変更駆動では拾えない乖離の発見） |
| `/harness-core:complete-feature` | 機能設計書の完了処理。受け入れ基準を確認して `completed/` へ移動する |
| `/harness-core:pre-push-check` | push 前チェック。未 push コミットが台帳に記録済みかを確認する |
| `/harness-core:done` | 完了報告を定型テーブル形式で出力する |
| `/harness-core:harness-update` | テンプレート層を claude-dev-harness の最新へ追従させる |
| `/harness-core:proofread-ja` | 日本語校正。AI が書いた文書の不自然な日本語を直す（文書を書き終えた区切りで） |

> **ハーネスの使い方**（導入・確認・つまずいたとき）は
> [セットアップガイド](https://github.com/mizuta0711/claude-dev-harness/blob/master/docs/guide/セットアップガイド.md)、
> 更新の流れは [改善還元フロー図](https://github.com/mizuta0711/claude-dev-harness/blob/master/docs/diagrams/06_改善還元フロー図.md) を参照。

> **注意**: 素の `/code-review` は Claude Code 組み込みスキルが起動する。
> 本ハーネスのレビューを使うときは必ず `/harness-core:code-review` と名前空間付きで呼ぶこと。
> 環境固有のスキルは `/harness-<環境>:...` で提供される（本ファイル末尾の「環境」セクションを参照）。

## 原則

不変原則は [constitution.md](constitution.md) に集約している。**変更にはユーザー承認が必要**。
ここには複製しない — 判断に迷ったら constitution.md を読むこと。

## 運用ルール

- **コミットは必ずパス指定**: `git commit` はインデックス全体をコミットするため、
  他のエージェント／セッションがステージ済みの変更を巻き込む。`git commit -- <path...>` を使い、
  `git add -A` / `git add .` は使わない
- 一度に編集するファイルは最大5ファイル。段階的にビルド確認する
- push はフェーズ完了時、またはユーザーから指示された時のみ。軽微な修正のたびに push しない
- サブエージェントの結果は**必ずメインで差分確認**してからコミットする。**ビルド成功 ≠ 正しい実装**
- **CLAUDE.md の肥大化防止**: 追記前に「これは方針か実態か」を自問する。実態は `docs/設計書/`、
  汎用の規約は `.claude/rules/`、**このプロジェクトの設計方針は `.claude/01_development_docs/`**、
  不変原則は constitution.md へ。全体で 300 行を超えたら整理対象
- 同じ手順を将来も繰り返しそうだと気づいたら、その場でスキル化を提案する

## ドキュメント構成

**方針（How）と実態（What）を分離する。同じ情報を2箇所に書かない。**

| 場所 | 役割 | 変更頻度 |
|------|------|----------|
| `constitution.md` | プロジェクトの不変原則（変更にはユーザー承認） | 極低 |
| `.claude/rules/` | パス条件付きコーディング規約（該当ファイルを読むと自動ロード） | 低 |
| `.claude/harness.config.json` | ハーネスの設定契約（コマンド・ゲート・設計書の軸） | 低 |
| `.claude/00_project/` | **要件・ドメイン知識**（Stage 1 で読む）。`projectDocs.requirements` に登録する | 低 |
| `.claude/01_development_docs/` `02_design_system/` | **このプロジェクトの設計方針**（Stage 2 で読む）。`projectDocs.policy` に登録する。書き方は [README](.claude/01_development_docs/README.md) | 低 |
| `docs/設計書/` | **実態**の一覧・定義。軸は `harness.config.json` の `designDocs` が定義する | 高（コードと同期） |
| `docs/features/` | 機能設計書（`yyyymmdd_機能名.md`） | 高 |
| `docs/reviews/` | レビュー結果の記録（**手順書は置かない**） | 中 |
| `docs/handoff/` | **セッション／担当をまたぐ引き継ぎ文書**。判断依頼・作業指示など。設計書ではないので、**用が済んだら削除してよい** | 随時 |

### `docs/features/` のライフサイクル

```
/harness-core:new-feature で docs/features/ 直下に作成 → 直下に置いたまま実装
  → 全タスク完了 → /harness-core:complete-feature
  → 🟢完了 は completed/ へ、⏸️一部保留 は pending/ へ移動
```

- **作業中の設計書は `docs/features/` 直下に置く**（`pending/` は一部保留の置き場。作業場所ではない）
- 命名: `yyyymmdd_機能名.md`
- タスクステータス: 🔵未実施 / 🟡実装中 / ✅完了 / ⏸️保留（理由必須） / ❌却下（理由必須）
- 設計書には末尾に改訂履歴テーブルを設け、コミット列に短縮ハッシュ（7文字）を記入する
- `/harness-core:update-docs` 実行時は台帳（`harness.config.json` の `designDocs.ledger`）にも追記する

<!-- ENV_SECTION -->
