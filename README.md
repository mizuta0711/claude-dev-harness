# claude-dev-harness

言語・フレームワークに依存しない Claude Code 開発ハーネス。
共通コアを **プラグイン**（`plugins/harness-core`）として配信し、環境差分は薄い **テンプレート層**（`templates/`）で吸収する。

nextjs-claude-template / UnityTemplate / WPFDotNet8Templete の3テンプレートを統合したもの。
設計の経緯は ProjectTemplete リポジトリの `docs/02_統合テンプレート提案.md` を参照。

## 現在の状態

| フェーズ | 内容 | 状態 |
|---------|------|------|
| Phase 1 | `harness-core` の抽出と config 契約化 | ✅ 完了 |
| Phase 2 | 環境プラグイン3本（nextjs / unity / wpf）とテンプレート層、`create-project.mjs` | ✅ 完了 |
| Phase 3 | `harness-update` の実装、既存3テンプレートの後始末、CHANGELOG | ✅ 本リポジトリの現状 |

変更履歴は [CHANGELOG.md](CHANGELOG.md) を参照。

## クイックスタート（新規プロジェクトの生成）

```bash
node tools/create-project.mjs --env <nextjs|unity|wpf> --dest ../MyProject
cd ../MyProject
claude plugin install harness-core@dev-harness  --scope project   # ★必須
claude plugin install harness-<env>@dev-harness --scope project   # ★必須
```

プレースホルダ（プロジェクト名など）は対話で尋ねられる（`--set KEY=VALUE` でも指定可）。
`--dry-run` を付けると、生成予定のファイル一覧と置換内容を表示するだけで何も書き込まない。

> ⚠️ **`claude plugin install` を飛ばすとスキルも hooks も動かない。**
> `.claude/settings.json` の `enabledPlugins` は初回起動でプラグインを導入しない（実測）。
>
> ⚠️ **`--scope project` も省略しない。** 既定は `user` だが、`project` 側の登録は
> `enabledPlugins` がどのみち自動生成するため、省略すると二重登録になり
> **更新のたびに両方へ当てる**ことになる（実測）。

**手順の詳細・環境ごとの追加セットアップ・よくある失敗は
[docs/guide/セットアップガイド.md](docs/guide/セットアップガイド.md) を参照。**

## ドキュメント

| 文書 | 内容 |
|------|------|
| [入門ガイド](docs/guide/入門ガイド.md) | **初めて使う人向け**。期待値調整・最初の1機能・つまずきポイント |
| [運用ガイド](docs/guide/運用ガイド.md) | スキルの使い分け・規模判定・フックの挙動・設計書の運用 |
| [セットアップガイド](docs/guide/セットアップガイド.md) | 導入・更新・既存プロジェクトへの後付け・取り外し |
| [既存プロジェクト移行指示書](docs/guide/既存プロジェクト移行指示書.md) | **旧テンプレートからの移行**。エージェントにそのまま渡す手順書 |
| [オプションMCP追加ガイド](docs/guide/オプションMCP追加ガイド.md) | 標準以外の MCP を足すとき |
| [図（diagrams/）](docs/diagrams/) | 全体構造 / 開発フロー / 役割比較 / スキル実行 / フック発火 / 改善還元 の6本 |
| [背景（background/）](docs/background/) | **なぜこの設計なのか**（意思決定記録。**決定は書き換えず、差異の記載は現行版へ追従する**） |

## 構成

```
claude-dev-harness/
├── .claude-plugin/marketplace.json    # プラグインカタログ（配信の入口）
├── plugins/
│   ├── harness-core/                  # 共通コア（全環境で同一）
│   │   ├── .claude-plugin/plugin.json
│   │   ├── skills/                    # 12スキル（下表）
│   │   ├── agents/                    # coding-specialist / code-reviewer / documentation-manager / japanese-proofreader
│   │   │                              # （フックは6本。下表）
│   │   └── hooks/
│   │       ├── hooks.json
│   │       └── scripts/               # 全 Node.js・config 駆動
│   ├── harness-nextjs/                # 環境プラグイン（下表）
│   ├── harness-unity/
│   └── harness-wpf/
├── templates/                         # 薄いテンプレート層
│   ├── base/                          # 全環境共通（CLAUDE.md 共通部 / constitution.md / 設計方針層 README / docs 骨格）
│   ├── nextjs/                        # 環境差分（CLAUDE.section.md / rules / config / 設計方針の骨格 / 設計書の枠）
│   ├── unity/
│   └── wpf/
├── tools/create-project.mjs           # base + env を合成してプロジェクトを生成する
└── docs/                              # ハーネス自体の仕様・運用文書
    ├── guide/                    # 使い方（セットアップ / オプション MCP）
    ├── diagrams/                 # 構造・フロー・フックの図（mermaid）
    ├── background/               # なぜそうしたか（意思決定記録。決定は不変・差異の記載は追従）
    ├── プラグイン開発手順.md      # プラグインの修正・反映手順（開発しながら直したいとき）
    ├── harness設定契約.md         # harness.config.json の設定契約
    └── permissionsベースライン.md # permissions の設計方針（単純化してはいけない点つき）
```

### 環境プラグイン

`harness-core` と**併用**する。テンプレートが生成する `.claude/settings.json` が
該当プラグインを `enabledPlugins` に入れるが、**導入は `claude plugin install` で別途行う**
（[プロジェクトからの利用](#プロジェクトからの利用marketplace-経由)を参照）。

| プラグイン | スキル | エージェント | フック |
|-----------|--------|-------------|--------|
| `harness-nextjs` | `browser-test`（Playwright MCP） | `browser-tester` / `product-advisor` | `post-edit-lint` / `pre-migrate-backup` |
| `harness-unity` | `unity-verify`（Unity MCP） | `game-designer` | `pre-commit-cs-check` |
| `harness-wpf` | `capture-screenshots`（UIAutomation） | `product-advisor` | （なし） |

環境プラグインの hook は **core の `harness-lib.js` を require しない**。
`${CLAUDE_PLUGIN_ROOT}` はプラグインごとに異なりプラグイン間参照が保証されないため、
必要な最小ヘルパ（`plugin-lib.js`）を各プラグインが自前で持つ。重複は意図的。

## harness-core が提供するもの

### スキル（`/harness-core:<name>` で呼び出す）

| スキル | 用途 |
|--------|------|
| `new-feature` | 機能設計書の作成（規模判定 S/M/L ＋ 曖昧さの解消） |
| `design-review` | 設計レビュー（`feature` = Stage 1 / `tech` = Stage 2）＋ トレーサビリティ検査 |
| `code-review` | 実装レビュー＋指摘対応 |
| `build-check` | `commands` に定義されたチェックの一括実行 |
| `update-docs` | 変更駆動の設計書更新 |
| `sync-check` | 全量照合＋残作業のタスク化（converge） |
| `complete-feature` | 完了処理（受け入れ基準ゲート → `completed/` へ移動） |
| `pre-push-check` | push 前の台帳同期チェック |
| `done` | 完了報告 |
| `plugin-update` | プラグイン層の更新（導入済みプラグインとスコープを自動特定し、更新前後の版を報告） |
| `harness-update` | テンプレート層の追従（3点比較で差分を分類し、承認したものだけ適用） |
| `proofread-ja` | 日本語校正（AI が書いた文章の品質ゲート）。`japanese-proofreader` へ委譲する |

### フック

| イベント | スクリプト | 役割 |
|---------|-----------|------|
| SessionStart | `session-start-context.js` | 状況の注入＋`harness.config.json` の検証・警告 |
| PreCompact | `pre-compact-save.js` | コンパクト前の文脈退避 |
| PreToolUse | `pre-commit-check.js` | `gates.preCommit` のコマンドを実行し、失敗でコミットをブロック |
| PostToolUse | `post-commit-doc-check.js` | `paths.docTriggers` に従い設計書更新を促す |
| PostToolUse | `post-branch-notice.js` | ブランチ作成を検知して画面と文脈の両方へ通知する（**止めない**） |
| SubagentStop | `subagent-stop-diff.js` | サブエージェント終了時に差分確認を促す |

実装規約:

- すべて Node.js（CommonJS）。PowerShell / Bash スクリプトは使わない（Windows・コンテナ両対応のため）
- 発火判定は matcher に頼らず、stdin JSON の `tool_input.command` を各スクリプトで判定する
- config 不在・パース失敗・コマンド未定義は **`exit 0` で素通り**（fail-open）
- ブロック強度: 自己修復可能な失敗は `permissionDecision:"deny"`、人間判断が要る場合のみ `continue:false`

## 設定契約 `.claude/harness.config.json`

core の hooks / skills は**すべてこのファイルを読んで動く**。仕様は
[docs/harness設定契約.md](docs/harness設定契約.md) を参照。

## プロジェクトからの利用（marketplace 経由）

利用側プロジェクトの `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "dev-harness": {
      "source": { "source": "github", "repo": "mizuta0711/claude-dev-harness" }
    }
  },
  "enabledPlugins": {
    "harness-core@dev-harness": true,
    "harness-nextjs@dev-harness": true
  }
}
```

（この設定は `create-project.mjs` が生成時に書き込むため、通常は手で書く必要はない。）

> ⚠️ **`enabledPlugins` は初回起動ではプラグインを導入しない**（実測）。
> `extraKnownMarketplaces` が行うのは marketplace の登録とクローンまでで、
> **導入は `claude plugin install` が必須**。導入確認は `/plugin` と `/` で行う
> （起動時の `[harness] <環境> / config OK` の1行でも分かる。harness-core 0.5.0 以降）。
>
> 手順・確認方法・つまずいたときの対処は
> **[docs/guide/セットアップガイド.md](docs/guide/セットアップガイド.md)** に集約してある。

スキルは `/harness-core:<name>` の形式で呼び出す（プラグインのスキルは名前空間が付くため、
Claude Code の組み込みスキルと同名でも衝突しない）。

## ローカルでの動作確認

```
claude --plugin-dir <このリポジトリ>/plugins/harness-core \
       --plugin-dir <このリポジトリ>/plugins/harness-<env>
```

対象プロジェクトに `.claude/harness.config.json` を置いた状態で起動すると、
SessionStart で config が検証され、スキルは `/harness-core:<name>` /
`/harness-<env>:<name>` で呼び出せる。

## 運用原則: 改善はコアへ還元する

**このハーネスは「使いながら育てる」前提で設計されている。** 各プロジェクトで見つけた改善は、
そのプロジェクトに直接パッチを当てるのではなく、**このリポジトリへ入れて全プロジェクトへ配信する**。

| 改善の種類 | 入れる場所 | プロジェクトへの届き方 |
|-----------|-----------|---------------------|
| スキル・エージェント・フック | `plugins/harness-*/` | marketplace 経由。**版を上げて push → 利用側で `plugin update` → 再起動** |
| CLAUDE.md / constitution.md / `.claude/rules/` / `harness.config.json` / 設計方針層の骨格 / docs 骨格 | `templates/` | `/harness-core:harness-update` で追従 |
| ハーネス自体の仕様・設計記録 | `docs/` | （参照用） |

### なぜプロジェクト側で直さないのか

プロジェクト側の場当たり修正は**他プロジェクトへ伝播せず、差分の温床になる**。
3テンプレートを別々に保守していた結果として実際に起きた劣化（permissions の欠落、
呼び名の分裂、同じバグの重複）が、この統合の動機そのものである。

### 手順

1. 改善に気づいたら、**その場では直さずメモに残して開発を続ける**（区切りでまとめて対応する）
2. 区切りでこのリポジトリを直す。手元での試し方は
   **[docs/プラグイン開発手順.md](docs/プラグイン開発手順.md)** に手順がある
3. 影響範囲に応じてバージョンを上げる（semver）。`CHANGELOG.md` に記録する
4. push する
5. 各プロジェクトで `claude plugin marketplace update dev-harness` →
   `claude plugin update harness-<name>@dev-harness --scope project` → **再起動**して取り込む
6. テンプレート層の変更は、各プロジェクトで `/harness-core:harness-update` を実行して取り込む

> ⚠️ **バージョンを上げないと届かない。** `claude plugin update` は版番号の変化で更新を判断するため、
> 中身だけ変えて push しても利用側は `already at the latest version` となり**何も起きない**（実測）。
> 「push したのに直らない」の原因はほぼこれ。

プロジェクト固有の事情でどうしてもローカル改変が必要な場合は、そのまま残してよい。
`harness-update` の3点比較が**「プロジェクト固有の改変」として保持**する（無断で上書きしない）。

## 開発ルール

**このリポジトリを直すときの規律は [CLAUDE.md](CLAUDE.md) に集約している。** ここには複製しない。

要点だけ挙げると:

- 改善は**必ずこのリポジトリへ**入れる（各プロジェクトへ直接入れない）
- **コミットはパス指定**（`git commit -- <path...>`）。複数セッションが同時に触るため、
  `git add -A` は他セッションの作業を巻き込む
- プラグインを触ったら `plugin.json` と `marketplace.json` の**版番号を両方上げる**。
  push 前に `claude plugin validate . --strict`
- バージョンは semver。`0.1.0` から
- **`templates/` に業務固有名・実プロジェクト由来の固有値を入れない**（本リポジトリは public）
