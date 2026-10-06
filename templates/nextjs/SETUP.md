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
