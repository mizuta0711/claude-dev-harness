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

```bash
npx tsx tools/export-to-sql.ts
```

**取り方は datasource provider で変わる**

| provider | 何をするか | 出力 |
|---|---|---|
| `postgresql` | 全テーブルを TRUNCATE + INSERT 形式の SQL にして zip 圧縮する | `tools/dump.sql` / `tools/backup/dump_YYYYMMDD.zip`（同日2回目以降は `_2`, `_3` ...） |
| `sqlite` | **DB ファイルをコピーする**（WAL の `-wal` / `-shm` も一緒に） | `tools/backup/<db>.<時刻>.bak` |
| それ以外 | **止まる。** この SQL 方言を出力できないため（復元できないダンプを「成功」と報告しない） | — |

古い世代は自動的に削除される（既定10世代）。

**失敗したら成功で終わらせない**

1テーブルでも書き出せなければ**終了コード 1** で終わる。

- 既存の `tools/dump.sql` は**上書きしない**（最後に成功したダンプを壊さないため）。
  部分的な出力は診断用に `tools/dump.failed.sql` へ書く
- `ORDERED_TABLES` のモデル名が Prisma クライアントに無い、または `DB_TABLE_MAP` に
  テーブル名が無い場合は、**1件も書き出す前に**止まる

**呼ばれるタイミング**

- 手動実行
- `harness-nextjs` の `pre-migrate-backup` フックが `npx prisma migrate` の**実行前**に自動実行する。
  失敗した場合は migrate がブロックされる

**スキーマ変更時は3点同期が必要**（`.claude/rules/prisma.md`）:

1. `prisma/schema.prisma`
2. `docs/設計書/テーブル定義書.md`（自動生成）
3. `tools/export-to-sql.ts` の `ORDERED_TABLES` + `DB_TABLE_MAP` — **PostgreSQL のときだけ。**
   SQLite はファイルコピーなので、この一覧を読まない（書いても使われず腐る）

<!-- TODO: PostgreSQL なら、初回に ORDERED_TABLES をこのプロジェクトのテーブル構成へ
     書き換える（外部キー制約を考慮した順序にすること）。SQLite なら記入は不要。 -->

---

## `scripts/generate-table-docs.ts` — テーブル定義書の自動生成

`prisma/schema.prisma` を読み取り、`docs/設計書/テーブル定義書.md` を生成する。

```bash
npx tsx tools/scripts/generate-table-docs.ts
```

- **前提**: schema.prisma の各カラムに `/// 説明` コメントが付いていること
- **`///` は複数行に分けて書ける**（連結される）。**`model` の直上に書いた `///` は
  テーブル一覧の「説明」列と各テーブルの節に出る**
- **解析と本文作りは `scripts/lib/parse-prisma-schema.ts`**（I/O を持たない）。
  このファイルが I/O だけなのは、**解析部を検査できるようにするため**である
- **生成されるのは `テーブル定義書.md` だけ。** `ER図.md` は手で書く
  （`.claude/rules/prisma.md` に理由がある）
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
