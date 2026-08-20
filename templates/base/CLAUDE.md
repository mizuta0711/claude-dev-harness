# CLAUDE.md — {{PROJECT_NAME}}

対話は日本語で行うこと。

## プロジェクト概要

{{PROJECT_NAME}} は {{PROJECT_DESCRIPTION}}。

<!-- TODO: 対象ユーザー・主要機能・スコープを記入する。
     詳細な要件・設計は docs/ 配下に置き、ここには1〜2段落の要約だけを残す。 -->

## 開発フロー

**すべての作業（新規機能・改修・バグ修正）は規模判定 S/M/L から始める。**
入口は `/harness-core:new-feature`。判定基準・各規模のフロー・バグ修正フローは
スキルが読み込む「開発フローと規模判定」に定義されている（CLAUDE.md には複製しない）。

| 規模 | フロー |
|------|--------|
| S（軽微・1ファイル程度） | 実装 → `/harness-core:build-check` → コミット → `/harness-core:done` |
| M（機能追加・複数ファイル・UX変更なし） | 設計 → 実装 → `/harness-core:code-review` → 動作確認 → `/harness-core:build-check` → `/harness-core:update-docs` → コミット → `/harness-core:done` |
| L（新機能・大規模変更・UX変更あり） | Stage 1 設計 → `/harness-core:design-review feature` → ユーザー承認 → Stage 2 設計 → `/harness-core:design-review tech` → 実装 →（以降 M と同じ） |

規模判定は **AI が推測 → ユーザーが承認** の2ステップ。迷ったら L 寄りで提示し、
**UX 変更（画面・操作フローの変更）を含む場合は自動的に L** として扱う。

### スキル一覧

| スキル | 用途 |
|--------|------|
| `/harness-core:new-feature` | 機能設計書をテンプレートから作成する。規模判定と曖昧さの解消まで行う（フローの入口） |
| `/harness-core:design-review` | 設計書のレビュー。`feature` = Stage 1、`tech` = Stage 2 |
| `/harness-core:code-review` | 実装レビュー。設計書との突き合わせ・エラー処理・セキュリティを確認し修正まで行う |
| `/harness-core:build-check` | `harness.config.json` の `commands` を一括実行し結果を表で報告する |
| `/harness-core:update-docs` | 実装変更に基づいて `docs/設計書/` を更新し、台帳に記録する |
| `/harness-core:sync-check` | 設計書と実装の網羅的な突き合わせ（変更駆動では拾えない乖離の発見）。**`pre-push-check` が push 前に自動で呼ぶ**ので、通常は直接叩かない |
| `/harness-core:complete-feature` | 機能設計書の完了処理。受け入れ基準を確認して `completed/` へ移動する |
| `/harness-core:pre-push-check` | push 前チェック。未 push コミットが台帳に記録済みかを確認し、**ソース変更を含む場合は設計書と実装の全量照合も行う** |
| `/harness-core:done` | 完了報告を定型テーブル形式で出力する |
| `/harness-core:usage-audit` | 利用実績の監査。**配ったのに動いていない仕組み**と規律の遵守を transcript から実測する（前回から日数が空くと起動時に知らせる） |
| `/harness-core:plugin-update` | プラグイン層（skills / agents / hooks）**だけ**を更新する。**再起動が要る**。両方まとめてやるなら `harness-update` |
| `/harness-core:harness-update` | **ハーネスの更新（「ハーネス更新して」の入口）。** プラグイン層とテンプレート層の両方を更新する。判断が要る差分は**別エージェントの査読を通して推奨つきで確認**する |
| `/harness-core:receive-handoff` | `docs/handoff/` の引き継ぎを受け取る。**書いてあることを実物で裏取りし**、判断が要るものはユーザーに確認したうえで、すぐ着手するものと保留するものに分けて格納する |
| `/harness-core:proofread-ja` | 日本語校正。AI が書いた文書の不自然な日本語を直す。**`update-docs` / `complete-feature` が「利用者が読む日本語を書いた」ときに案内する**ので、その案内が出たら実行を検討する |

> **ハーネスの使い方**（導入・確認・つまずいたとき）は
> [セットアップガイド](https://github.com/mizuta0711/claude-dev-harness/blob/master/docs/guide/セットアップガイド.md)、
> 更新の流れは [改善還元フロー図](https://github.com/mizuta0711/claude-dev-harness/blob/master/docs/diagrams/06_改善還元フロー図.md) を参照。

> **注意**: 素の `/code-review` は Claude Code 組み込みスキルが起動する。
> 本ハーネスのレビューを使うときは必ず `/harness-core:code-review` と名前空間付きで呼ぶこと。
> 環境固有のスキルは `/harness-<環境>:...` で提供される（本ファイル末尾の「環境」セクションを参照）。

### スラッシュコマンドが解決しない環境での実行（★エージェント向け）

**クライアントによっては `/harness-core:...` が `No matching commands` になる**
（VS Code の Claude Code 拡張パネルで実測。統合ターミナルの CLI では解決する）。

**これは導入の失敗ではない。スキルは実行できる。**
スキルの実体は `SKILL.md` という手順書なので、**読んで従えば同じことができる**。

ユーザーから「**`<スキル名>` を実行して**」と依頼され、スラッシュコマンドとして
起動できない場合は、次の手順を取ること。**「使えません」と返さない。**

```bash
node "$HOME/.claude/plugins/marketplaces/dev-harness/plugins/harness-core/skills/plugin-update/scripts/plugin-versions.mjs" --skill <スキル名>
```

- **導入済みの版**の `SKILL.md` の絶対パスが1行で出る（marketplace の HEAD ではない）
- そのファイルを読み、**書かれた Step のとおりに実行する**
- スキル内の `${CLAUDE_PLUGIN_ROOT}` は、出力パスから
  `skills/<名前>/SKILL.md` を除いた部分に読み替える
- 見つからない場合は、探した場所が標準エラーに出る。**プラグインが導入されていない**
  可能性があるので、その旨を報告する

> **この手順を使ったときは報告に1行添える**（「スラッシュコマンドが解決しないため
> SKILL.md を直接実行した」）。ユーザーが環境の問題に気づけなくなるため。

## 原則

不変原則は [constitution.md](constitution.md) に集約している。**変更にはユーザー承認が必要**。
ここには複製しない — 判断に迷ったら constitution.md を読むこと。

## 運用ルール

- **コミットは必ずパス指定**: `git commit` はインデックス全体をコミットするため、
  他のエージェント／セッションがステージ済みの変更を巻き込む。`git commit -- <path...>` を使い、
  `git add -A` / `git add .` は使わない
  - **`git commit -a` / `-am` も同じ**（追跡済みを全部巻き込む）。
    `git stash` と、範囲指定なしの `git checkout -- .` / `git restore .` / `git clean` も避ける
  - `pre-commit-scope` フックが検知して**知らせる**。**止めたいなら**
    `.claude/harness.config.json` に `"gates": { "commitScope": "paths" }` を設定する
    （既定は警告のみ。既存プロジェクトが追従した瞬間にコミットが止まらないようにしてある）
- 一度に編集するファイルは最大5ファイル。段階的にビルド確認する
- push はフェーズ完了時、またはユーザーから指示された時のみ。軽微な修正のたびに push しない
- **ブランチを切ったら必ず報告する。** エージェントは既定ブランチ上でコミットするとき
  自動でブランチを作るが、**作成そのものは黙って行われる**。
  完了報告に「ブランチ `<名前>` を作成した」の1行を必ず入れ、
  **push するか既定ブランチへマージするかの判断をユーザーに返すこと**。
  報告しないと、**ユーザーが知らないブランチにコミットが積み上がる**
  （実測: 4コミットが約20時間気づかれずに残った）
- サブエージェントの結果は**必ずメインで差分確認**してからコミットする。**ビルド成功 ≠ 正しい実装**
- **プロジェクト固有の用語を増やすときは `glossary-keeper` へ申請する。** 自分で用語集へ追記しない。
  **語を使いたい人が可否を決めてはいけない**（目の前の文書を通したい動機で判断が歪む）。
  却下されたら、示された一般語へ言い換える
- **重い読み込みを伴う作業はサブエージェントへ委譲する。** 実装は `coding-specialist`、
  設計書の更新は `documentation-manager`。理由は3つあり、**いちばん効くのはコンテキスト衛生**:
  - **その作業でしか読まない文書**（設計方針・ライブラリ規約・設計書一式）をメインの文脈に持ち込まない
  - 直前の文脈のまま作業すると、**成果物ではなく自分の理解に合わせて**書いてしまう
  - 上位モデルを要さない作業が多い
  - **モデルはエージェント定義が持つ**（`coding-specialist` / `documentation-manager` /
    `code-reviewer` などは `sonnet`、日本語校正の `japanese-proofreader` だけ上位モデル）。
    **起動側で上書きしない。** 変えたい場合はプロジェクトの `.claude/agents/` に同名で置く
- **その場限りの依頼も `sonnet` を明示する。** 定義済みエージェントを使わず、
  メインが一時的にサブエージェントへ投げる場合（調査・探索・一括置換など）も、
  **起動時に `model` へ `sonnet` を指定する**。
  - 指定を省くと**メインのモデルを継承する**ため、委譲の理由の1つ（コスト）が消える
  - **上位モデルが要ると判断した場合は、その理由を報告に書く。** 黙って上げない
- **CLAUDE.md の肥大化防止**: 追記前に「これは方針か実態か」を自問する。実態は `docs/設計書/`、
  汎用の規約は `.claude/rules/`、**このプロジェクトの設計方針は `.claude/01_development_docs/`**、
  不変原則は constitution.md へ。全体で 300 行を超えたら整理対象
- 同じ手順を将来も繰り返しそうだと気づいたら、その場でスキル化を提案する

## ドキュメント構成

**方針（How）と実態（What）を分離する。同じ情報を2箇所に書かない。**

| 場所 | 役割 | 変更頻度 |
|------|------|----------|
| `constitution.md` | プロジェクトの不変原則（変更にはユーザー承認） | 極低 |
| `.claude/rules/` | パス条件付きコーディング規約（該当ファイルを読むと自動ロード） | 低 |
| `.claude/harness.config.json` | ハーネスの設定契約（コマンド・ゲート・設計書の軸） | 低 |
| `.claude/00_project/` | **要件・ドメイン知識**（Stage 1 で読む）。`projectDocs.requirements` に登録する | 低 |
| `.claude/01_development_docs/` `02_design_system/` | **このプロジェクトの設計方針**（Stage 2 で読む）。`projectDocs.policy` に登録する。書き方は [README](.claude/01_development_docs/README.md) | 低 |
| `docs/設計書/` | **実態**の一覧・定義。軸は `harness.config.json` の `designDocs` が定義する | 高（コードと同期） |
| `docs/features/` | 機能設計書（`yyyymmdd_機能名.md`） | 高 |
| `docs/reviews/` | レビュー結果の記録（**手順書は置かない**） | 中 |
| `docs/handoff/` | **セッション／担当をまたぐ引き継ぎ文書**。判断依頼・作業指示など。**受け渡し専用で、作業場所ではない**（→ 下記） | 随時 |

### `docs/handoff/` は受け渡し専用（作業場所ではない）

```
渡す側: docs/handoff/ に置く
  → 受け取る側: /harness-core:receive-handoff
     （裏取り → ユーザー確認 → 仕分け → 所定のフォルダへ移動 → handoff を空に）
  → 移してから着手する
```

**受け取りは `/harness-core:receive-handoff` を通す。** 手順を覚えている必要はない。

- **`docs/handoff/` で作業を進めない。** 受け取ったら**着手前に**行き先を決めて移す
- **対応中のものを `docs/handoff/` に置いたままにしない。** 「受け渡し中」と「作業中」が混ざると、
  中身を見ただけでは**どちらなのか判断できなくなる**
- 移し終えたら **handoff 側の文書は削除してよい**（設計書ではない）

> **なぜ「移してから着手」なのか。** 作業中のものが handoff に残っていると、
> **片付けが「引き継ぎ置き場そのものを畳む」ことだと誤解される**。
> 実際に「中身を適切な場所へ移した」という作業が、記録の上で
> **「`docs/handoff/` を廃止した」に化けた**ことがある。しかも別の文書がそれを引き継いで広め、
> **配置表の定義は生きているのに、廃止されたと書いた記録が2つ**という状態になった。
> **置き場の空き＝廃止ではない。** 空にしてよいのは、それが受け渡し専用だからである。

### `docs/features/` のライフサイクル

```
/harness-core:new-feature で docs/features/ 直下に作成 → 直下に置いたまま実装
  → 全タスク完了 → /harness-core:complete-feature
  → 🟢完了 は completed/ へ、⏸️一部保留 は pending/ へ移動
```

- **作業中の設計書は `docs/features/` 直下に置く**（`pending/` は一部保留の置き場。作業場所ではない）
- 命名: `yyyymmdd_機能名.md`
- タスクステータス: 🔵未実施 / 🟡実装中 / ✅完了 / ⏸️保留（理由必須） / ❌却下（理由必須）
- 設計書には末尾に改訂履歴テーブルを設け、コミット列に**トリガーとなった実装コミット**の短縮ハッシュ（7文字）を記入する。
  **書けないときは `—`（`(未確定)` と書かない。埋め戻す機会が来ず永久に残る）**
- `/harness-core:update-docs` 実行時は台帳（`harness.config.json` の `designDocs.ledger`）にも追記する

<!-- ENV_SECTION -->
