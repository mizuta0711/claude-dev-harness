---
name: create-project
description: ハーネスを適用した新規プロジェクトを生成する（テンプレート層の CLAUDE.md / constitution.md / .claude/rules/ / harness.config.json / docs 骨格を合成して git init まで）。「Next.js の新規プロジェクト作って」「新しく WPF のプロジェクトを始めたい」の入口。環境と生成先を引数で渡せる（例: nextjs D:/Develop/Web/my-app）。
allowed-tools: "Bash(node:*), Bash(claude plugin list:*), Read"
---

# 新規プロジェクトの生成（create-project）

**「〇〇の新規プロジェクト作って」の入口。** 引数の例: `nextjs D:/Develop/Web/my-app`

プラグインを `user` スコープで入れていれば、**空のフォルダや無関係なプロジェクトからでも呼べる**。
生成の本体は claude-dev-harness の `tools/create-project.mjs` で、このスキルはそれを
**GitHub から取得して実行し、その後の手順を案内する**だけである。

> **このスキルが作るのはハーネスの骨格だけ。** `package.json` や `.sln` などフレームワーク本体は作らない。
> それは生成先で `/harness-core:new-feature` を始めたときに **Phase 0（初期化）** として扱う
> （new-feature の Step 0）。ここで `create-next-app` 等を先に走らせないこと —
> 空でないディレクトリで失敗するか、生成物の `CLAUDE.md` を壊す。

スクリプトは `${CLAUDE_SKILL_DIR}/scripts/create.mjs`（以降 `${CREATE}` と書く）。
ハーネスを毎回 GitHub から `--depth 1` で取得し、その `tools/create-project.mjs` を実行して後始末する。

## Step 1: 何を作るかを決める

```bash
node "${CREATE}" describe
```

利用可能な環境と、各環境が要求するプレースホルダ（`template.json` の宣言）が JSON で返る。
**環境によって要求されるプレースホルダが違う**（wpf は `CORE_PROJECT` / `UI_PROJECT`、
android は `APPLICATION_ID` / `MODULE_NAME` も要る）ので、**必ずここから引く。覚えている値で埋めない。**

次の値を揃える。**引数や依頼文から分かるものは尋ねない。** 足りないものだけまとめて1回で聞く。

| 値 | 決め方 |
|---|---|
| 環境 | 依頼文から（「Next.js」→ `nextjs`）。曖昧なら候補を示して聞く |
| 生成先 | 絶対パスで確定させる。**既存のファイルがあるフォルダなら、上書きになる旨を伝えて確認を取る** |
| プレースホルダ | `describe` の `placeholders`。`default` があるものは提案値として示す。`example` は**例であって既定値ではない** |

## Step 2: dry-run で確認する

```bash
node "${CREATE}" run --env <env> --dest <生成先> --set KEY=VALUE ... --dry-run
```

生成先・置換内容・ファイル一覧を**要約して**ユーザーに示す（ファイル一覧の全件は貼らない）。
警告（生成先が空でない・未置換のプレースホルダ）が出ていたら必ず伝える。

## Step 3: 生成する

ユーザーの了承を得たら、`--dry-run` を外して同じコマンドを実行する。

- `git init` まで行われる（既存の `.git` があればスキップ）
- `.claude/harness-baseline.json` に取得したハーネスのコミットが記録される
  （以後の `/harness-core:harness-update` がこれを起点に3点比較する）

**ネットワークに出られない場合**は、`--repo <claude-dev-harness のローカルクローン>` を付ければ
取得を省ける。取得に失敗したら中断して報告する（推測で骨格を手書きしない）。

## Step 4: 環境プラグインが入っているかを確認する

```bash
claude plugin list
```

`describe` の `plugin`（例: `harness-nextjs@dev-harness`）が一覧に無ければ、導入コマンドを案内する。
**スコープは利用者が選ぶ**ので、こちらで決めて実行しない。

```bash
claude plugin install <plugin> --scope <user か project>
```

> `harness-core` はこのスキルが動いている以上、導入済みである。

## Step 5: 次の手順を案内する

create-project.mjs が出す「次の手順」はプラグイン未導入の前提で長い。
**Step 4 の結果に合わせて、実際に要るものだけ**を次の形で伝える。

```
生成しました: <生成先>

次の手順:
  1. <生成先> で Claude Code を開き直す
     （CLAUDE.md・settings・rules はセッション開始時にしか読まれない。このセッションで cd しても効かない）
  2. /harness-core:new-feature 初期構築
     → 未初期化と判定され、フレームワークの初期化が Phase 0 として設計書に入る
```

加えて、環境ごとに**人が手でやる必要があるもの**を1行添える。

| 環境 | 伝えること |
|---|---|
| nextjs | `.env` は deny で塞がれており AI は作れない。DB の接続情報などは自分で作る |
| その他 | 生成物の `CLAUDE.md` の環境セクションに初期化の注意があれば、その要点 |

## やらないこと

- **生成先で続けて作業しない。** ハーネスの設定は生成先のセッションでしか効かない
- **生成物を手で直さない。** 気になる点があればテンプレート側（claude-dev-harness）の問題として報告する
