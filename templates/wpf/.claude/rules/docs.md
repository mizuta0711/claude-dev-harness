---
paths:
  - "docs/features/**"
  - "docs/設計書/**"
---

# 設計ドキュメントの運用ルール

## 改訂履歴ルール

`docs/設計書/` および `docs/features/` 配下の設計ドキュメントには末尾に改訂履歴テーブルを設け、改訂時は必ず更新すること。

**改訂履歴のフォーマット:**
```
| 版数 | 日付 | コミット | 内容 | 担当 |
```
- コミット列にはトリガーとなったコミットの短縮ハッシュ（7文字）を記入
- `/harness-core:update-docs` 実行時は `docs/設計書/.doc-sync.md`（台帳）にも同期記録を追記すること

## 機能設計書の運用ルール

- 新規機能開発時は `/harness-core:new-feature` で作成する（スキル同梱のテンプレートが使われる）
- 命名: `docs/features/pending/yyyymmdd_機能名.md`
- タスクステータス: 🔵未着手 / 🟡実装中 / ✅完了 / ⏸️保留（理由必須） / ❌却下（理由必須）
- 全タスク完了時はメタ情報のステータスを 🟢完了 に更新し、
  `/harness-core:complete-feature` で `docs/features/completed/` へ移動する
