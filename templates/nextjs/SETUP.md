# {{PROJECT_NAME}} — Next.js セットアップ

このプロジェクトは [claude-dev-harness](https://github.com/mizuta0711/claude-dev-harness) の
`create-project.mjs` で生成されている。**プレースホルダの一括置換は生成時に完了済み**。
残る手順は**プラグインの導入**と **Next.js 自体の足場づくり**の2つ。

## Step 1: Claude Code の起動とプラグイン導入

```bash
claude
```

`.claude/settings.json` の `extraKnownMarketplaces` により marketplace は初回起動で自動登録されるが、
**初回起動ではプラグインが導入されない**（実測・2026-08-14）。
プロジェクトで一度だけ次を実行する:

```bash
claude plugin install harness-core@dev-harness   --scope <user か project、選んだ方>
claude plugin install harness-nextjs@dev-harness --scope <同じ方>
```

**スコープは `user` / `project` どちらでもよい（選ぶのは導入する側）。`--scope` は省略しない**
（詳細は[セットアップガイド §2-1](https://github.com/mizuta0711/claude-dev-harness/blob/master/docs/guide/%E3%82%BB%E3%83%83%E3%83%88%E3%82%A2%E3%83%83%E3%83%97%E3%82%AC%E3%82%A4%E3%83%89.md#2-1-スコープの選び方)）。

読み込めたかは **`/plugin`（enabled とバージョン）** と **`/`（スキル一覧に `harness-core:new-feature`）**
で確認する。

## Step 2: Next.js の足場を作る（`create-next-app`）

**ハーネス適用済みのリポジトリは既に非空である。** `create-next-app` をそのまま実行すると
必ず詰まるか、既存ファイルを壊す。以下に従うこと。

| 落とし穴 | 対処 |
|---------|------|
| **非空ディレクトリで失敗する** | 一時ディレクトリに生成してから中身を移す。`--yes` で対話を飛ばす |
| **生成物の `CLAUDE.md` / `AGENTS.md` を取り込むと、ハーネスの `CLAUDE.md` を上書きして壊す** | 移す前に**必ず除外する**。ハーネスの `CLAUDE.md` / `constitution.md` / `.claude/` / `docs/` / `tools/` が正 |
| **`.gitignore` が上書きされる** | ハーネス側の `.gitignore` とマージする（`!.env.example` の行を失わないこと） |
| **`npm run lint` が初回から失敗する** | `eslint.config.mjs` の `globalIgnores` に **`.claude/**` を追加**する（下記） |
| **足場だけでは `/harness-core:build-check` が原理的に通らない** | **足場の直後に Prisma も入れる**（下記） |
| **生成された `next.config.ts` に `cacheComponents` / `partialPrefetching` が入る** | **外すか、移行まで含めて決める**（下記） |
| **`npm run dev` のたびに `AGENTS.md` が戻る** | `next.config.ts` に **`agentRules: false`**（下記） |
| **`next dev` の待ち受けが既定で `0.0.0.0`**（LAN の全端末から見える） | `scripts.dev` を **`next dev -H 127.0.0.1`** に固定する（下記） |

`.claude/statusline.js` は Node で直接実行される CommonJS のため `require()` が
`@typescript-eslint/no-require-imports` に引っかかる。除外しないと**アプリのコードが 0 行の時点で
`npm run lint` が失敗し、`/harness-core:build-check` が初回から赤くなる**。

```js
globalIgnores([
  ".next/**", "out/**", "build/**", "next-env.d.ts",
  // ハーネスが提供する設定・スクリプト群。アプリのソースではない
  ".claude/**",
]),
```

### 足場の直後に Prisma も入れる

**アプリのコードが0行の時点でも、Prisma を入れるまで型チェックとビルドが通らない。**
ハーネスが配る `tools/export-to-sql.ts` が `@prisma/client` を**値として** import していて、
`create-next-app` が作る `tsconfig.json` の `include`（`**/*.ts`）が `tools/` を拾うため、
`TS2307` で落ちる。

```bash
npm install prisma @prisma/client
```

**`@prisma/client` が入るだけで解消する**（スキーマ定義も `prisma generate` も要らない）。
`tsconfig.json` の `exclude` に `tools` を足す解き方は採らない —— **`tools/` の型チェックが
丸ごと落ちる**ため。

### `next.config.ts` の生成内容を確かめる

`create-next-app`（16.4.0 で確認）は `next.config.ts` に **`cacheComponents`** と
**`partialPrefetching`** を書き込む。**Next.js 自体の既定は `cacheComponents: false`** なので、
これは**足場が足している**ものである。

`cacheComponents` を有効にしたままにするなら、**ルートセグメントの設定を移行する必要がある** ——
`export const dynamic` は外して `use cache` へ寄せ、`export const runtime = 'edge'` は使えない
（Cache Components は Node.js ランタイムを要求する）。移行の内容は
`node_modules/next/dist/docs/01-app/02-guides/migrating-to-cache-components.md` にある。

**どちらにするかを Phase 0 で決めること。** 決めずに書き進めると、
**後から `dynamic` / `runtime` を書いた時点でビルドが落ちる**。

### `AGENTS.md` を生成物から除外しても、`npm run dev` で戻る

Next.js 16.3 以降の `next dev` は `CLAUDE.md` / `AGENTS.md` に管理ブロックを書き足す。
**上の表の「除外する」は初回しか効かない。** `next.config.ts` で止める:

```ts
const nextConfig: NextConfig = {
  // next dev が AGENTS.md を自動生成・更新するのを止める（既定は有効）
  agentRules: false,
};
```

**ハーネスでは `CLAUDE.md` が正**で、`CLAUDE.md` 自身が
`node_modules/next/dist/docs/` を読む指示を既に持っている。**指示書を2枚にしない。**
新規生成の時点で抑えるなら `create-next-app --no-agents-md` もある
（止めたいのは `next dev` が**毎回**戻すことなので、`agentRules: false` の方が確実）。

### `scripts.dev` の待ち受けを固定する

**`next dev` の既定の待ち受けは `0.0.0.0`** で、同じ LAN の他の端末からも開ける。
開発機を共有ネットワークに置くなら `package.json` の `scripts.dev` を固定する:

```json
"dev": "next dev -p 3000 -H 127.0.0.1"
```

**ポートを固定する利点もある** —— 既定は使用中なら勝手にずれるため、
`browser-test` の URL と食い違う。

> **型チェックは `next typegen` を前置してある。** `harness.config.json` の
> `commands.typecheck` は `npx next typegen && npx tsc --noEmit` である。
> Next.js 16 の `LayoutProps` / `PageProps` は**グローバル型で、`.next/types` が生成される
> まで存在しない**ため、`npx tsc --noEmit` だけだと**クローン直後や `.next` を消した直後に
> コミット前ゲートが落ちる**。Next.js 自身の文書も CI では
> `next typegen && tsc --noEmit` を勧めている。

## Step 3: プロジェクト情報の記入

初期化が済んだら、`CLAUDE.md` の `<!-- TODO -->` 箇所を埋める。特に
**「環境: Next.js」の `Stack:` 行を実際に採用した構成へ更新する**こと
（既定から外した場合は理由も1行残す）。

`.env` は `.claude/settings.json` の deny で保護されている。Prisma が `DATABASE_URL` を
要求するため、初期化時にここへ触れる必要が出る場面がある。

## Step 4: 開発開始

```
/harness-core:new-feature <機能名>
```

規模判定（S/M/L）から始まる。UI 変更を含む場合の動作確認は `/harness-nextjs:browser-test`
（Playwright MCP。`.mcp.json` に登録済み）。

## このプロジェクトのハーネス構成

| 層 | 内容 |
|----|------|
| `harness-core`（プラグイン） | 規模判定フロー・設計/実装レビュー・設計書同期・コミット前後フック |
| `harness-nextjs`（プラグイン） | `browser-test` スキル / `browser-tester`・`product-advisor` エージェント / `post-edit-lint`・`pre-migrate-backup` フック |
| `.claude/`（このリポジトリ） | `harness.config.json`（設定契約）・`rules/`・`settings.json` |
| `docs/`（このリポジトリ） | 設計書（実態）・機能設計書・レビュー記録 |
