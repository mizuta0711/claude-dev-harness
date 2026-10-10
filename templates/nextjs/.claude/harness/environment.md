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

<!-- TODO: 実際に採用した版・ライブラリを記入する（`package.json` が正典）。
     **版を断定形で書いたまま放置しないこと** — この節は全セッションで常時展開されるので、
     実際と食い違うと嘘が常に読まれる（実際にやった: 15.3 のプロジェクトに「16」と書いた雛形を配った）。

     雛形の例（create-next-app の既定に近い構成。合っていなければ書き換える）:
     Next.js <版> (App Router) + React 19 + TypeScript (strict) + TailwindCSS 4
     + Zustand 5 + Prisma 6 (PostgreSQL) + NextAuth 4 -->

**Stack:** <!-- TODO: 上の例を参考に、このプロジェクトの実際の構成を書く -->

<!-- TODO: 採用した版に破壊的変更があるなら、その注意を書く（無ければこのコメントを消す）。
     例（Next.js 16 の場合）:
     > **Next.js 16 注意**: このバージョンには破壊的変更がある。
     > コードを書く前に `node_modules/next/dist/docs/` のガイドを参照し、非推奨 API に注意すること。 -->

**初回のセットアップ（プラグイン導入・`create-next-app` の落とし穴）は [SETUP.md](../../SETUP.md) にある。**

### ディレクトリ構成

<!-- TODO: 下のツリーは `create-next-app` の既定に近い**雛形**である。
     **実態と違っていたら書き換える**（この節は常時展開されるので、違っていると嘘が常に読まれる。
     実際に、雛形のまま配られたツリーより CLAUDE.md 側の方が実態に合っていた例がある）。
     確認は `ls src/` と `ls src/features/` で足りる。**個々の機能名を列挙しない**（必ず腐る）。 -->

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
（該当ファイルを読んだ時点で自動ロードされる。**発火条件は各ファイルの frontmatter `paths` が正**）。

⚠️ **ただし「置けば必ず読まれる」わけではない。**

- **コンパクト（文脈の圧縮）後に再注入されない。** 長いセッションでは規約が静かに消える。
  **コンパクトを挟んで実装に戻るときは、該当ファイルを読み直す**
- **新規ファイルを一から作るときは発火しないことがある**（既存の該当ファイルを読まないため）

**この節に要点を再掲しているのは、その2つの穴を埋めるための意図的な例外である**
（手順の詳細は `.claude/rules/` にのみ書く）。

### DB スキーマ変更時の必須ルール

**バックアップ実行 / `///` コメント付与 / 3点同期**の3点が必須。
スキーマ変更前に必ず [.claude/rules/prisma.md](../rules/prisma.md) を読むこと。
**1つでも更新漏れがあると、バックアップが不完全になる。**

<!-- 「同じ情報を2箇所に書かない」に対する意図的な例外（理由は上の「実装ルール」の節にある）。 -->

### 環境固有の挙動

- **`/harness-nextjs:browser-test` は UI 変更を含む場合に実施する**（M / L フローの「動作確認」に相当）
- **`pre-migrate-backup` フックは `prisma migrate` の前にバックアップを取り、
  失敗なら migrate をブロックする**（`tools/export-to-sql.ts`）。
  **未設定でブロックするのは PostgreSQL のときだけ**（SQLite は一覧を使わないため検査しない）
- `post-edit-lint` フックが編集直後に `eslint --fix` を走らせる（非ブロッキング。
  **`npx` は使わず `node_modules/.bin/eslint` を直叩きする** — 解決処理のぶん毎編集に約0.9秒乗るため）。
  **対象を決めるのは `harness.config.json` の `paths.source` の glob**
  （キーが無いときだけ `src/**` を既定とする）。**固定の範囲だと思わないこと**
