# claude-dev-harness

言語・フレームワークに依存しない Claude Code 開発ハーネス。
共通コアを **プラグイン**（`plugins/harness-core`）として配信し、環境差分は薄い **テンプレート層**（`templates/`）で吸収する。

nextjs-claude-template / UnityTemplate / WPFDotNet8Templete の3テンプレートを統合したもの。
設計の経緯は ProjectTemplete リポジトリの `docs/02_統合テンプレート提案.md` を参照。

## 現在の状態

| フェーズ | 内容 | 状態 |
|---------|------|------|
| Phase 1 | `harness-core` の抽出と config 契約化 | ✅ 本リポジトリの現状 |
| Phase 2 | 環境プラグイン（nextjs）とテンプレート層、`create-project.mjs` | ⬜ 未着手 |
| Phase 3 | Unity / WPF の移行、`harness-update` の実装 | ⬜ 未着手 |

## 構成

```
claude-dev-harness/
├── .claude-plugin/marketplace.json    # プラグインカタログ（配信の入口）
├── plugins/
│   └── harness-core/                  # 共通コア（全環境で同一）
│       ├── .claude-plugin/plugin.json
│       ├── skills/                    # 10スキル（下表）
│       ├── agents/                    # coding-specialist / code-reviewer / documentation-manager
│       └── hooks/
│           ├── hooks.json
│           └── scripts/               # 全 Node.js・config 駆動
├── templates/                         # 薄いテンプレート層（Phase 2）
├── tools/                             # create-project.mjs 等（Phase 2）
└── docs/                              # ハーネス自体の仕様・運用文書
```

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
| `harness-update` | テンプレート層の追従（**骨子のみ・Phase 3 で実装**） |

### フック

| イベント | スクリプト | 役割 |
|---------|-----------|------|
| SessionStart | `session-start-context.js` | 状況の注入＋`harness.config.json` の検証・警告 |
| PreCompact | `pre-compact-save.js` | コンパクト前の文脈退避 |
| PreToolUse | `pre-commit-check.js` | `gates.preCommit` のコマンドを実行し、失敗でコミットをブロック |
| PostToolUse | `post-commit-doc-check.js` | `paths.docTriggers` に従い設計書更新を促す |
| SubagentStop | `subagent-stop-diff.js` | サブエージェント終了時に差分確認を促す |

実装規約:

- すべて Node.js（CommonJS）。PowerShell / Bash スクリプトは使わない（Windows・コンテナ両対応のため）
- 発火判定は matcher に頼らず、stdin JSON の `tool_input.command` を各スクリプトで判定する
- config 不在・パース失敗・コマンド未定義は **`exit 0` で素通り**（fail-open）
- ブロック強度: 自己修復可能な失敗は `permissionDecision:"deny"`、人間判断が要る場合のみ `continue:false`

## 設定契約 `.claude/harness.config.json`

core の hooks / skills は**すべてこのファイルを読んで動く**。仕様は
[docs/harness-config-contract.md](docs/harness-config-contract.md) を参照。

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
    "harness-core@dev-harness": true
  }
}
```

スキルは `/harness-core:<name>` の形式で呼び出す（プラグインのスキルは名前空間が付くため、
Claude Code の組み込みスキルと同名でも衝突しない）。

## ローカルでの動作確認

```
claude --plugin-dir <このリポジトリ>/plugins/harness-core
```

対象プロジェクトに `.claude/harness.config.json` を置いた状態で起動すると、
SessionStart で config が検証され、スキルは `/harness-core:<name>` で呼び出せる。

## 開発ルール

- 改善は**必ずこのリポジトリへ**入れる（各プロジェクトへ直接入れない）
- 全ファイル UTF-8（BOM 無し）・改行 LF（`.gitattributes` で固定）
- バージョンは semver。`0.1.0` から
