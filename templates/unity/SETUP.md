# {{PROJECT_NAME}} — Unity セットアップ

このプロジェクトは [claude-dev-harness](https://github.com/mizuta0711/claude-dev-harness) の
`create-project.mjs` で生成されている。**プレースホルダの一括置換は生成時に完了済み**
（namespace は `{{PROJECT_NAME}}`）。残る手順は Unity 側の接続だけ。

## Step 1: Claude Code の起動とプラグイン信頼

```bash
claude
```

`.claude/settings.json` の `extraKnownMarketplaces` により marketplace は初回起動で自動登録されるが、
**初回起動ではプラグインが導入されない**（実測・2026-08-14）。
プロジェクトで一度だけ次を実行する:

```bash
claude plugin install harness-core@dev-harness  --scope project
claude plugin install harness-unity@dev-harness --scope project
```

**`--scope project` を省略しない。** 既定の `user` に入れると `enabledPlugins` が作る
`project` 側の登録と二重になり、更新のたびに両方へ当てることになる。

読み込めたかは **`/plugin`（enabled とバージョン）** と **`/`（スキル一覧に `harness-core:new-feature`）**
で確認する。

> SessionStart フックが出す `[harness] environment: unity` は `additionalContext` として
> Claude に渡されるもので、**画面には表示されない**。表示の有無で判断しないこと。

## Step 2: Unity MCP のセットアップ

[CoplayDev/unity-mcp](https://github.com/CoplayDev/unity-mcp)（MCP For Unity）を使い、
Claude Code から Unity Editor（シーン操作・コンソール確認・GameObject 操作など）を直接操作できるようにする。

本テンプレートは `.mcp.json`（プロジェクトスコープ・Git 管理下）で登録する方式を採用している。
ユーザー単位設定（`~/.claude.json`）に書き込む方式と違って
**Windows のドライブレター大文字/小文字の不一致で登録が迷子になる問題が起きない**。

### Claude が実施する事項

1. `.mcp.json` がプロジェクトルートに存在することを確認する（生成時に配置済み）
2. Unity プロジェクトの `Packages/manifest.json` に以下の依存を追加する
   ```json
   "com.coplaydev.unity-mcp": "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity"
   ```
3. Unity Editor 側の作業が終わった後、`mcp__UnityMCP__*` ツールが見えるようになったら
   `read_console` 等で疎通確認する

### ユーザーに依頼する事項（画面操作が必要なため）

1. Unity Editor にフォーカスを移し、パッケージの解決（git clone・コンパイル）を待つ
2. メニューの **Window > MCP For Unity** を開き、「Local Server」が起動していることを確認する
   （起動していなければ Start Server）
   - ※ Client Configuration の「Configure All Detected Clients」は使わなくてよい（`.mcp.json` 側で代替するため）
3. Claude Code 側で `.mcp.json` に定義された MCP サーバーの利用許可を求めるプロンプトが出たら承認する
   （`.claude/settings.json` の `enabledMcpjsonServers` に `UnityMCP` を明示済みのため、通常は自動で有効になる）
4. VSCode を再起動（`Developer: Reload Window` でも可）し、セッションに MCP サーバーを読み込ませる

### 既知のトラブル

上記でも接続できない場合、`~/.claude.json` の該当プロジェクトパスが
大文字/小文字違いで重複登録されていないか確認する
（例: `D:/Develop/Unity/Foo` と `d:/Develop/Unity/Foo` の両方が存在し、片方にしか `mcpServers` が入っていない）。
重複していれば、実際にセッションが使っている方のキーに `mcpServers` をマージする。

## Step 3: プロジェクト情報の記入

`CLAUDE.md` の `<!-- TODO -->` 箇所（Unity バージョン・レンダーパイプライン・フォルダ構成）を記入する。

## Step 4: 開発開始

```
/harness-core:new-feature <機能名>
```

規模判定（S/M/L）から始まる。動作確認は `/harness-unity:unity-verify`
（ただし**面白さ・実プレイ感の確認はユーザー自身が Unity Editor で行う** —
`harness.config.json` の `verification.manualGate` が `true`）。

## このプロジェクトのハーネス構成

| 層 | 内容 |
|----|------|
| `harness-core`（プラグイン） | 規模判定フロー・設計/実装レビュー・設計書同期・コミット前後フック |
| `harness-unity`（プラグイン） | `unity-verify` スキル / `game-designer` エージェント / `pre-commit-cs-check` フック |
| `.claude/`（このリポジトリ） | `harness.config.json`（設定契約）・`rules/`・`settings.json` |
| `docs/`（このリポジトリ） | 設計書（実態）・機能設計書・レビュー記録 |
