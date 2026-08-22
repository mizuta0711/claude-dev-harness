# templates/ — テンプレート層

プラグインでは配布できないもの（CLAUDE.md / `constitution.md` / `.claude/rules/` /
`docs/` 骨格 / `.claude/settings.json` / `.claude/harness.config.json` / `.gitignore` / `.mcp.json`）を
**プロジェクト生成時にコピーする層**。

```
templates/
├── base/     # 全環境共通
├── nextjs/   # 環境差分
├── unity/
├── wpf/
└── android/
```

生成は [`../tools/create-project.mjs`](../tools/create-project.mjs) が行う:

```bash
node tools/create-project.mjs --env <nextjs|unity|wpf|android> --dest ../MyProject
```

> **生成後にプラグインの導入が要る。**
> テンプレートが書き込む `.claude/settings.json` の `extraKnownMarketplaces` は
> marketplace の登録を行うが、**プラグインの導入自体は自動で行われない**。
> 生成先で一度だけ実行する:
>
> ```bash
> claude plugin install harness-core@dev-harness  --scope <user か project、選んだ方>
> claude plugin install harness-<env>@dev-harness --scope <同じ方>
> ```
>
> **スコープは`user`/`project`どちらでもよい（選ぶのは導入する側）。`--scope`は省略しない。**
> 詳細は[セットアップガイド§2-1](../docs/guide/セットアップガイド.md#2-1-スコープの選び方)。
>
> 導入できたかは **`/plugin`（enabled とバージョン）** と **`/`（スキル一覧）** で確認する。
> SessionStart フックは harness-core 0.5.0 以降 `[harness] <env> / config OK` を**画面に1行出す**ので、
> 出なければ導入できていない（または config が読めていない）と言える。
> ただし**版が古いままでも出る**ため、確認は `/plugin` と `/` を正とすること。
>
> 詳細は [../docs/guide/セットアップガイド.md](../docs/guide/セットアップガイド.md)。

## 合成のルール

| 対象 | 合成方法 |
|------|---------|
| `CLAUDE.md` | base の `<!-- ENV_SECTION -->` マーカーを、env の `CLAUDE.section.md` の内容で置換する |
| `.claude/settings.json` | deep-merge（オブジェクトは再帰マージ、配列は連結 + 重複除去） |
| `.gitignore` | base + env の連結 |
| その他 | env が base を上書きする |

生成先へは**コピーされない**テンプレート層のメタファイル:

| ファイル | 役割 |
|---------|------|
| `<env>/template.json` | その環境が要求するプレースホルダの宣言（`create-project` が読む） |
| `<env>/CLAUDE.section.md` | `CLAUDE.md` へ埋め込まれる環境セクションの原稿 |

## プレースホルダ

`{{PROJECT_NAME}}` のような `{{KEY}}` 形式。**ファイルの内容だけでなくパスにも適用される。**
どのキーを要求するかは `<env>/template.json` の `placeholders` が宣言する。

| 環境 | プレースホルダ |
|------|---------------|
| nextjs | `PROJECT_NAME` / `PROJECT_DESCRIPTION` |
| unity | `PROJECT_NAME`（C# の root namespace を兼ねる） / `PROJECT_DESCRIPTION` |
| wpf | `PROJECT_NAME` / `PROJECT_DESCRIPTION` / `CORE_PROJECT` / `UI_PROJECT` |
| android | `PROJECT_NAME` / `PROJECT_DESCRIPTION` / `APPLICATION_ID`（パッケージ名） / `MODULE_NAME`（既定 `app`） |

`placeholders[].default` は既に決まった値を参照できる（例: wpf の `CORE_PROJECT` の既定値は
`{{PROJECT_NAME}}.Core`）。

## 置いていないもの（意図的）

| 対象 | 理由 |
|------|------|
| `docs/features/TEMPLATE.md` | `harness-core` の `new-feature` スキル同梱版を正とする（二重管理の防止）。プロジェクト固有の調整が必要になったプロジェクトだけが `docs/features/TEMPLATE.md` を自前で置く — スキルはそれを優先する |
| `.claude/hooks/` | hooks はプラグイン（`harness-core` / `harness-<env>`）が配信する |
| `.claude/skills/` / `.claude/agents/` | 同上。名前空間付き（`/harness-core:<name>`）で提供される |

## `settings.json` と `settings.local.json` の使い分け

テンプレートが配るのは **`.claude/settings.json` だけ**。`settings.local.json` は生成されない
（`.gitignore` 対象で、必要になった人が手元で作る）。

| ファイル | Git 管理 | 置くもの |
|---------|---------|---------|
| `.claude/settings.json` | **する**（派生プロジェクトへ伝播する） | **deny は全部ここ**。共有すべき allow / ask、hooks、`enabledPlugins` |
| `.claude/settings.local.json` | しない | **手元だけの allow**（個人の作業効率化）、個人的な env |

**セキュリティに関わる設定を `settings.local.json` に置かない。** 共有されないため、
そこから派生したプロジェクトが無防備になる（Phase 0 の発見事項 F1。WPF テンプレートで実際に起きた）。

テンプレート既定の制限がきつすぎる場合も、`settings.json` の deny を削るのではなく
`settings.local.json` の allow で手元だけ緩める。方針の正典は
[../docs/reference/permissionsベースライン.md](../docs/reference/permissionsベースライン.md) §1。

## 環境を追加する

**「アダプタを用意した」は「環境を追加し終えた」ではない。** 環境名を列挙している場所が
リポジトリ全体に散っており、**足し忘れても何のエラーも出ない**（新環境が生成テストを
一度も通らない、利用者に存在が届かない、といった形で静かに失敗する）。

### 1. 環境アダプタ（`templates/<env>/` と `plugins/harness-<env>/`）

| # | 置くもの | 必須 |
|---|---------|------|
| 1 | `templates/<env>/template.json`（`environment` / `plugin` / `placeholders`） | ✅ |
| 2 | `templates/<env>/CLAUDE.section.md`（技術スタック・構成・コマンド・rules 表・環境固有スキル） | ✅ |
| 3 | `templates/<env>/.claude/harness.config.json`（`commands` / `gates` / `paths` / `designDocs` / `verification`） | ✅ |
| 4 | `templates/<env>/.claude/rules/`（パス条件付きの規約） | ✅ |
| 5 | `templates/<env>/docs/設計書/`（**ヘッダと表の枠だけ**。実データを入れない） | ✅ |
| 6 | `templates/<env>/.claude/settings.json`（`enabledPlugins` と、その環境のコマンドの allow / ask） | ✅ |
| 7 | `templates/<env>/.gitignore` / `.mcp.json`（要る場合だけ） | 任意 |
| 8 | `templates/<env>/.claude/01_development_docs/01_*.md`（設計方針層の骨格） | 推奨 |
| 9 | `plugins/harness-<env>/`（動作確認スキル・体験系エージェント・環境固有フック） | ✅ |

### 2. リポジトリ側の波及（**ここが抜ける**）

| # | 直す場所 | 抜けると |
|---|---------|---------|
| 1 | `.claude-plugin/marketplace.json` に登録（**版は `plugin.json` と2箇所**） | **プラグインを配れない** |
| 2 | `tests/create-project.smoke.test.mjs` の `ENVS` に追加 | **生成テストを一度も通らない**（env リストはハードコード） |
| 3 | 判定ロジックを持つフックを足したなら `tests/` にテストを足す（[../CLAUDE.md](../CLAUDE.md) §4） | 次に触る人が壊せる |
| 4 | `../docs/reference/harness設定契約.md`（`environment` の値・「対応ハーネス版」行） | 契約が実装と食い違う |
| 5 | `../docs/guide/`（セットアップ / 入門 / 運用 / 移行指示書の環境判定） | **利用者に存在が届かない** |
| 6 | `../docs/diagrams/`（環境列を持つ図） | 図と実物が乖離する |
| 6b | `../docs/background/`（**両書とも「差異の記載は現行版に追従する」と自ら定めている**） | **実際に漏れた**（`941b257` は `docs 影響` 行で自ら挙げていたのに、この表に無かった） |
| 7 | `../README.md` / 本ファイル / `../tools/README.md` の環境一覧 | 同上 |
| 8 | `../CHANGELOG.md`（`docs 影響` の行を省略しない） | 追従漏れが検出できない |
| 9 | **要素の「数え上げ」を書いている箇所**（`skills N / agents N / hooks N` の形）。`grep -rn "agents [0-9]" docs/ README.md` | **固有名の grep では当たらない**（H29）。実際に `agents 4`（実数5）・`skills 12`（実数13）・`hooks 6`（実数7）が4箇所で腐っていた |

**完了条件**: `node --test "tests/*.test.mjs"` が通り、
`claude plugin validate . --strict` が通り、生成したプロジェクトで
`[harness] <env> / config OK` が出ること。

## 追加・変更するときの注意

- **業務固有名・実プロジェクト由来の固有値を入れない**（本リポジトリは public）
- `docs/設計書/` に置くのは**ヘッダと表の枠だけ**。サンプルの実データを残さない
- permissions の方針は [../docs/reference/permissionsベースライン.md](../docs/reference/permissionsベースライン.md) が正典
  （実機検証済みのパターンが記録されている）
