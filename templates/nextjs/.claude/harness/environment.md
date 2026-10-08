<!--
  このファイルは**プロジェクトが育てる**。テンプレートが配るのは雛形で、
  `CLAUDE.md` から `@.claude/harness/environment.md` で読み込まれ、起動時に展開される。

  **実態を書く場所である** — スタックの実際の版・ディレクトリ構成・コマンド・固有の注意点。
  **`TODO` を見つけたら、このプロジェクトの実態に書き換えること。**

  **ハーネス更新（`/harness-core:harness-update`）はこのファイルを触らない**（0.28.0 以降）。
  記入した事実を雛形で上書きしないため。構成そのものを見直したくなったら、
  テンプレートの同名ファイルを見て差分を自分で取り込む。

  ハーネスが持つ規律は隣の `core.md`（あちらは追従対象で、編集すると競合になる）。
-->

## 環境: Next.js

**Stack:** Next.js 16 (App Router) + React 19 + TypeScript (strict) + TailwindCSS 4 + Zustand 5 + Prisma 6 (PostgreSQL) + NextAuth 4

<!-- TODO: 実際に採用したバージョン・ライブラリに合わせて更新する -->

> **Next.js 16 注意**: このバージョンには破壊的変更がある。
> コードを書く前に `node_modules/next/dist/docs/` のガイドを参照し、非推奨 API に注意すること。

**初回のセットアップ（プラグイン導入・`create-next-app` の落とし穴）は [SETUP.md](../../SETUP.md) にある。**

### ディレクトリ構成

```
src/
├── app/           # Next.js App Router（ページ・API）
├── features/      # 機能別モジュール
│   └── {feature}/ # components/, stores/, hooks/, services/, data/
├── components/    # 共通コンポーネント（layout/, providers/, common/）
├── lib/           # ユーティリティ（api/, auth.ts, db.ts, services/）
└── types/         # 型定義
```

### コマンドとゲート

**`.claude/harness.config.json` の `commands` が正典**（`/harness-core:build-check` が一括実行する）。
**コマンドはここに再掲しない。** コミット前ゲートは `gates.preCommit` の **`typecheck`**。

### アーキテクチャ規約

- **直接 DB 操作禁止** — API Route は必ず Service 層を経由する
- **BE/FE を別サブエージェントに委譲する場合は共有型を先に定義する**（`src/types/`）。
  API 提供側と消費側の両方が同じ型を import し、レビューで突き合わせる
- Server / Client Components を適切に分離する
- `any` 型は禁止（`unknown` / union / ジェネリクスで代替）

詳細なコーディング規約は `.claude/rules/` にパス条件付きで置いてある
（該当ファイルを読んだ時点で自動ロードされるため、手動で読む必要はない。
**発火条件は各ファイルの frontmatter `paths` が正**）。

### DB スキーマ変更時の必須ルール

**バックアップ実行 / `///` コメント付与 / 3点同期**の3点が必須。
スキーマ変更前に必ず [.claude/rules/prisma.md](../rules/prisma.md) を読むこと。
**1つでも更新漏れがあると、バックアップが不完全になる。**

<!-- 「同じ情報を2箇所に書かない」に対する意図的な例外。
     paths ルールはコンパクト後に自動再注入されないため、この要約だけは常時ロードされる
     CLAUDE.md 側に残す。手順の詳細は .claude/rules/prisma.md にのみ書く。 -->

### 環境固有の挙動

- **`/harness-nextjs:browser-test` は UI 変更を含む場合に実施する**（M / L フローの「動作確認」に相当）
- **`pre-migrate-backup` フックは `prisma migrate` の前にバックアップを取り、
  失敗・未設定なら migrate をブロックする**（`tools/export-to-sql.ts`）
- `post-edit-lint` フックが `src/**` の編集直後に `npx eslint --fix` を走らせる（非ブロッキング）
