---
paths:
  - "tools/**"
---

# スクリプトの整理ルール

作業用スクリプトは `tools/scripts/` 以下に用途別フォルダで整理する。

例:
- `tools/scripts/seed/` — テストデータ投入系
- `tools/scripts/migration/` — データ移行系
- `tools/scripts/analysis/` — データ分析・検証系

シードデータの生成は Claude Code 自身の AI 能力で行う。アプリの AI API を開発ツールとして使わない。
