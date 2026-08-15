# tools/

開発支援ツール・自動化スクリプト群。

```
tools/
├── README.md                       # このファイル
├── export-to-sql.ts                # DB 全量バックアップツール
├── dump.sql                        # バックアップ出力（gitignore）
├── backup/                         # 日付付きバックアップアーカイブ（gitignore・世代上限あり）
└── scripts/
    └── generate-table-docs.ts      # schema.prisma からテーブル定義書を自動生成
```

---

## `export-to-sql.ts` — DB 全量バックアップ

PostgreSQL の全テーブルを TRUNCATE + INSERT 形式の SQL としてエクスポートし、zip 圧縮する。

```bash
npx tsx tools/export-to-sql.ts
```

**出力**

- `tools/dump.sql` — 最新の SQL
- `tools/backup/dump_YYYYMMDD.zip` — 日付付きバックアップ（同日2回目以降は `_2`, `_3` ...）

古い世代は自動的に削除される（既定10世代）。

**呼ばれるタイミング**

- 手動実行
- `harness-nextjs` の `pre-migrate-backup` フックが `npx prisma migrate` の**実行前**に自動実行する。
  失敗した場合は migrate がブロックされる

**スキーマ変更時は3点同期が必要**（`.claude/rules/prisma.md`）:

1. `prisma/schema.prisma`
2. `docs/設計書/テーブル定義書.md`（自動生成）
3. `tools/export-to-sql.ts` の `ORDERED_TABLES` + `DB_TABLE_MAP`

<!-- TODO: 初回に ORDERED_TABLES をこのプロジェクトのテーブル構成へ書き換える
     （外部キー制約を考慮した順序にすること）。 -->

---

## `scripts/generate-table-docs.ts` — テーブル定義書の自動生成

`prisma/schema.prisma` を読み取り、`docs/設計書/テーブル定義書.md` を生成する。

```bash
npx tsx tools/scripts/generate-table-docs.ts
```

- **前提**: schema.prisma の各カラムに `/// 説明` コメントが付いていること
- model のフィールド・型・nullable・既定値・インデックス・リレーション・Enum を網羅する
- 手動で書くと最も乖離が起きやすい文書のため自動生成にしている
- `/harness-core:sync-check` が差分確認の手段として利用する

---

## `scripts/` の整理ルール

用途別フォルダで整理する（詳細は `.claude/rules/tools-scripts.md`）。

```
tools/scripts/
├── seed/         # テストデータ投入
├── migration/    # データ移行
└── analysis/     # データ分析・検証
```

- **ルート直下（`tools/`）に直接置かない** — ルートは主要ツールのみ
- 冒頭にコメントブロックで用途・使い方・前提を書く
- **シードデータ生成にアプリの AI API を使わない**（コスト・再現性のため）

---

## Prisma を使わない場合

| ファイル | 対応 |
|---------|------|
| `export-to-sql.ts` | **削除可**。`harness.config.json` の `paths` から prisma 関連も外す |
| `scripts/generate-table-docs.ts` | **削除可**。`designDocs` から「テーブル定義書.md」「ER図.md」を外す |

他の ORM（Drizzle / TypeORM 等）を使う場合は、これらを参考に独自のバックアップ・生成スクリプトを作る。

## 関連

- [.claude/rules/prisma.md](../.claude/rules/prisma.md) — DB スキーマ変更時の必須ルール
- [.claude/rules/tools-scripts.md](../.claude/rules/tools-scripts.md) — スクリプトの整理ルール
