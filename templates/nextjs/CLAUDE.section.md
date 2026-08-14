## 環境: Next.js

**Stack:** Next.js 16 (App Router) + React 19 + TypeScript (strict) + TailwindCSS 4 + Zustand 5 + Prisma 6 (PostgreSQL) + NextAuth 4

<!-- TODO: 実際に採用したバージョン・ライブラリに合わせて更新する -->

> **Next.js 16 注意**: このバージョンには破壊的変更がある。
> コードを書く前に `node_modules/next/dist/docs/` のガイドを参照し、非推奨 API に注意すること。

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

### コマンド

`.claude/harness.config.json` の `commands` が正典（`/harness-core:build-check` が使う）。

| 用途 | コマンド |
|------|---------|
| 開発サーバー | `npm run dev` |
| ビルド | `npm run build` |
| 型チェック | `npx tsc --noEmit`（コミット前ゲート） |
| lint | `npm run lint` |

> **プロジェクト初期化時に `.claude/**` を lint 対象から外すこと。**
> ハーネスが同梱する `.claude/statusline.js` は Node で直接実行される CommonJS であり、
> `require()` が `@typescript-eslint/no-require-imports` に引っかかる。
> 除外しないと**アプリのコードが 0 行の時点で `npm run lint` が失敗し、
> `/harness-core:build-check` が初回から赤くなる**。
>
> `eslint.config.mjs` の `globalIgnores` に追加する:
>
> ```js
> globalIgnores([
>   ".next/**", "out/**", "build/**", "next-env.d.ts",
>   // ハーネスが提供する設定・スクリプト群。アプリのソースではない
>   ".claude/**",
> ]),
> ```

### アーキテクチャ規約

- **直接 DB 操作禁止** — API Route は必ず Service 層を経由する
- **BE/FE を別サブエージェントに委譲する場合は共有型を先に定義する**（`src/types/`）。
  API 提供側と消費側の両方が同じ型を import し、レビューで突き合わせる
- Server / Client Components を適切に分離する
- `any` 型は禁止（`unknown` / union / ジェネリクスで代替）

詳細なコーディング規約は `.claude/rules/` にパス条件付きで置いてある
（該当ファイルを読んだ時点で自動ロードされるため、手動で読む必要はない）。

| ルール | 発火条件（`paths`） |
|--------|-------------------|
| `typescript.md` | `src/**/*.{ts,tsx}` |
| `react-nextjs.md` | `src/features/**/*.tsx`, `src/components/**/*.tsx`, `src/app/**/*.tsx` |
| `api.md` | `src/app/api/**`, `src/features/**/hooks/**`, `src/lib/services/**` |
| `prisma.md` | `prisma/schema.prisma`, `tools/export-to-sql.ts`, `tools/scripts/generate-table-docs.ts` |
| `tools-scripts.md` | `tools/**` |
| `docs.md` | `docs/features/**`, `docs/設計書/**` |

### DB スキーマ変更時の必須ルール

**バックアップ実行 / `///` コメント付与 / 3点同期**の3点が必須。
スキーマ変更前に必ず [.claude/rules/prisma.md](.claude/rules/prisma.md) を読むこと。
**1つでも更新漏れがあると、バックアップが不完全になる。**

<!-- 「同じ情報を2箇所に書かない」に対する意図的な例外。
     paths ルールはコンパクト後に自動再注入されないため、この要約だけは常時ロードされる
     CLAUDE.md 側に残す。手順の詳細は .claude/rules/prisma.md にのみ書く。 -->

### 環境固有スキル

| スキル | 用途 |
|--------|------|
| `/harness-nextjs:browser-test` | Playwright MCP でブラウザ動作確認・UX 評価を行い、エビデンスを残す |

- `browser-test` は UI 変更を含む場合に実施する（M / L フローの「動作確認」に相当）
- `product-advisor` エージェントは `/harness-core:design-review feature` が
  code-reviewer と並列で起動する（企画・UX 体験観点）

### 環境固有フック（harness-nextjs プラグイン）

| フック | 発火 | 挙動 |
|--------|------|------|
| `post-edit-lint` | `src/**` の編集直後 | `npx eslint --fix` を実行。自動修正できない指摘だけ通知（非ブロッキング） |
| `pre-migrate-backup` | `prisma migrate` 実行前 | `tools/export-to-sql.ts` でバックアップ。**失敗・未設定なら migrate をブロックする** |
