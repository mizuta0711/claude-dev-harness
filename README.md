# claude-dev-harness

言語・フレームワークに依存しない Claude Code 開発ハーネス。
共通コアを **プラグイン**（`plugins/harness-core`）として配信し、環境差分は薄い **テンプレート層**（`templates/`）で吸収する。

nextjs-claude-template / UnityTemplate / WPFDotNet8Templete の3テンプレートを統合したもの。
設計の経緯は ProjectTemplete リポジトリの `docs/02_統合テンプレート提案.md` を参照。

## 現在の状態

| フェーズ | 内容 | 状態 |
|---------|------|------|
| Phase 1 | `harness-core` の抽出と config 契約化 | ✅ 完了 |
| Phase 2 | 環境プラグイン3本（nextjs / unity / wpf）とテンプレート層、`create-project.mjs` | ✅ 本リポジトリの現状 |
| Phase 3 | `harness-update` の実装、既存3テンプレートの後始末 | ⬜ 未着手 |

## クイックスタート（新規プロジェクトの生成）

```bash
node tools/create-project.mjs --env <nextjs|unity|wpf> --dest ../MyProject
```

プレースホルダ（プロジェクト名など）は対話で尋ねられる（`--set KEY=VALUE` でも指定可）。
`--dry-run` を付けると、生成予定のファイル一覧と置換内容を表示するだけで何も書き込まない。

生成物は `templates/base` と `templates/<env>` の合成結果で、
`.claude/settings.json` に marketplace 経由のプラグイン導入設定が入っているため、
生成先で `claude` を起動してプラグインを信頼すれば、そのまま
`/harness-core:new-feature` から開発を始められる。

## 構成

```
claude-dev-harness/
├── .claude-plugin/marketplace.json    # プラグインカタログ（配信の入口）
├── plugins/
│   ├── harness-core/                  # 共通コア（全環境で同一）
│   │   ├── .claude-plugin/plugin.json
│   │   ├── skills/                    # 10スキル（下表）
│   │   ├── agents/                    # coding-specialist / code-reviewer / documentation-manager
│   │   └── hooks/
│   │       ├── hooks.json
│   │       └── scripts/               # 全 Node.js・config 駆動
│   ├── harness-nextjs/                # 環境プラグイン（下表）
│   ├── harness-unity/
│   └── harness-wpf/
├── templates/                         # 薄いテンプレート層
│   ├── base/                          # 全環境共通（CLAUDE.md 共通部 / constitution.md / docs 骨格）
│   ├── nextjs/                        # 環境差分（CLAUDE.section.md / rules / config / 設計書の枠）
│   ├── unity/
│   └── wpf/
├── tools/create-project.mjs           # base + env を合成してプロジェクトを生成する
└── docs/                              # ハーネス自体の仕様・運用文書
```

### 環境プラグイン

`harness-core` と**併用**する。テンプレートが生成する `.claude/settings.json` が
該当プラグインを `enabledPlugins` に入れるため、通常は意識せず有効になる。

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
    "harness-core@dev-harness": true,
    "harness-nextjs@dev-harness": true
  }
}
```

（この設定は `create-project.mjs` が生成時に書き込むため、通常は手で書く必要はない。）

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

## 開発ルール

- 改善は**必ずこのリポジトリへ**入れる（各プロジェクトへ直接入れない）
- 全ファイル UTF-8（BOM 無し）・改行 LF（`.gitattributes` で固定）。
  **例外: `.ps1` は UTF-8 BOM 付き**（Windows PowerShell 5.1 が BOM 無し UTF-8 を
  CP932 と誤読して日本語が化けるため）
- バージョンは semver。`0.1.0` から
- **`templates/` に業務固有名・実プロジェクト由来の固有値を入れない**（本リポジトリは public）
