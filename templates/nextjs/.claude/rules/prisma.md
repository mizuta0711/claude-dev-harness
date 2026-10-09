---
paths:
  - "prisma/**"
  - "tools/export-to-sql.ts"
  - "tools/scripts/generate-table-docs.ts"
  - "src/lib/db.ts"
  - "src/lib/services/**"
  - "src/features/**/services/**"
---

<!-- paths を `prisma/schema.prisma` だけにすると、**DB を触るコードを書くときに発火しない**
     （スキーマを変えずにクエリだけ足す場面）。そこで **DB に触る層**（クライアントの定義と Service）
     まで広げている。**`src/lib/**` や `src/app/api/**` のように層をまたぐ glob は置かない** —
     DB と関係のない編集で 60行超の手順がロードされる。
     API Route は Service を経由する規約なので、route から直接 Prisma は触らない。
     一から作るときの案内は `typescript.md`（`src/**` で必ず発火する）に置いてある。 -->

# Prisma / DB のルール

## クライアントは必ずシングルトンにする

**`new PrismaClient()` をあちこちで書かない。** `src/lib/db.ts` の1インスタンスを import して使う。

- Next.js の開発サーバはモジュールを**ホットリロードで作り直す**ため、
  ファイルごとにインスタンスを作ると**接続が積み上がって接続上限に当たる**
- 新しく作るときは `src/lib/db.ts` が既にあるかを先に確認する（無ければ作る。
  `globalThis` にキャッシュして開発時の再生成を防ぐ形が定石）

## DB スキーマ変更時の必須ルール

テーブル構造の変更（カラム追加・削除・型変更・テーブル追加/削除）を行う際は、以下を**必ず**守ること:

1. **バックアップ実行**: スキーマ変更の**前に** `npx tsx tools/export-to-sql.ts` を実行
2. **コメント必須**: カラム追加・変更時は `/// 説明` コメントを必ず付与する（テーブル定義書の自動生成に使用）
3. **3点同期**: スキーマ変更時は以下の3箇所を**必ず同時に更新**する:

| # | 対象 | ファイル |
|---|------|---------|
| 1 | スキーマ | `prisma/schema.prisma` |
| 2 | 設計書 | `npx tsx tools/scripts/generate-table-docs.ts` を実行して自動生成 |
| 3 | バックアップツール | `tools/export-to-sql.ts`（`ORDERED_TABLES` + `DB_TABLE_MAP`） |

**1つでも更新漏れがあると、バックアップが不完全になる。**

> `ORDERED_TABLES` はテンプレート出荷時は空（TODO）である。空のままだと空のダンプが
> できてしまうため、`harness-nextjs` の `pre-migrate-backup` hook がこれを検出して
> `prisma migrate` をブロックする。最初の migrate の前に必ず記入すること。

## 補足情報の置き場（重要）

> ⚠️ **`docs/設計書/テーブル定義書.md` に手書きで追記してはいけない。**
> `generate-table-docs.ts` は `fs.writeFileSync` で**全文を上書き生成**するため、
> 手書きの補注は次回生成時に**無言で消える**。

補足したいこと（`Json` カラムの形状、値の意味、単位など）は **`schema.prisma` の `///` コメントに書く**。
生成スクリプトがこれを「説明」列へ取り込むため、**そこが唯一の永続的な置き場**になる。

```prisma
model ChatMessage {
  /// クイックリプライ候補。{ label: string, value: string }[] 形式
  quickReplies Json?
}
```

書いたら `npx tsx tools/scripts/generate-table-docs.ts` を実行し、説明列に反映されたことを確認する。

## 参照

- テーブル定義の実態: [docs/設計書/テーブル定義書.md](../../docs/設計書/テーブル定義書.md) / [ER図.md](../../docs/設計書/ER図.md)

<!-- TODO: DB 設計方針（命名規則・インデックス方針・論理削除の扱い等）を定めたらここに追記する -->
