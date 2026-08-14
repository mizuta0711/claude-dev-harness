# CHANGELOG

このリポジトリの変更履歴。バージョンは各プラグインの semver を指す。
経緯・設計判断の詳細は ProjectTemplete リポジトリの `docs/` と `docs/reviews/` にある。

## [Unreleased] — Phase 3（harness-update と後始末）

### harness-core 0.2.0

#### Added
- **`harness-update` スキルを実装**（Phase 1 では骨子のみだった）。
  テンプレート層（CLAUDE.md / constitution.md / `.claude/rules/` / `harness.config.json` / docs 骨格）を
  最新へ追従させる。差分エンジン `scripts/harness-diff.mjs`（`analyze` / `apply` / `finalize`）を同梱
  - 取得は `git clone --depth 1`。`--repo <path>` でローカルクローンも使える（オフライン用）
  - **3点比較**（A=baseline 時点 / B=最新 / C=現物）で差分を機械的に分類する。
    A・B は**クローン側の `create-project.mjs` をその時点のコミットで実行して再現**するため、
    合成規則の二重実装が発生しない
  - 分類: `template-improvement` / `project-local` / `already-applied` / `conflict` / `template-removed`
  - `apply` は**競合ファイルの上書きを拒否**する（ローカル改変の無断上書き禁止の機械的担保）
  - `finalize` は**未解決の競合が残っていると中断**する（`--force` で明示的に見送れる）。
    baseline を進めるとテンプレート側の変更が視界から消えるため
  - `docs/features/` / `docs/reviews/` / `docs/設計書/`（台帳を除く）は追従対象外

#### Changed
- `harness.config.json` は**スキーマ差分**として扱う（新フィールドの追加提案・既存値の保持・
  `schemaVersion` 引き上げ時のユーザー承認）

### テンプレート層

#### Added
- `.claude/harness-baseline.json` を `create-project.mjs` が生成するようにした。
  内容: `templatesCommit` / `environment` / `appliedAt` / `placeholders`。
  `harness-update` が「前回どの時点を適用したか」と「どの置換値で生成されたか」を知るために使う。
  **このファイルはコミットする**（チーム全員が同じ基準点を使うため）
- `templates/base/.gitattributes` を追加。生成されたプロジェクトにも LF 固定を引き継ぐ
  （無いと Windows の `core.autocrlf=true` で作業ツリーが CRLF になり、
  `harness-update` の3点比較で全ファイルが差分として出る）
- `templates/base/.gitignore` に `.claude/.harness-update/`（作業ディレクトリ）を追加

---

## [Phase 2] — 環境モジュールとテンプレート層（2026-08-14）

### harness-nextjs 0.1.0 / harness-unity 0.1.0 / harness-wpf 0.1.0（新規）

#### Added
- **harness-nextjs**: `browser-test` スキル（Playwright MCP）/ `browser-tester`・`product-advisor` エージェント /
  `post-edit-lint`・`pre-migrate-backup` フック
- **harness-unity**: `unity-verify` スキル（Unity MCP）/ `game-designer` エージェント /
  `pre-commit-cs-check` フック
- **harness-wpf**: `capture-screenshots` スキル（UIAutomation）/ `product-advisor` エージェント /
  `ui-capture.ps1`

環境プラグインの hooks は **core の `harness-lib.js` を require しない**。
`${CLAUDE_PLUGIN_ROOT}` はプラグインごとに異なりプラグイン間参照が保証されないため、
必要な最小ヘルパ（`plugin-lib.js`）を各プラグインが自前で持つ。重複は意図的。

### テンプレート層（新規）

#### Added
- `templates/base`（CLAUDE.md 共通部 / `constitution.md` / `settings.json` / `statusline.js` / docs 骨格）
- `templates/{nextjs,unity,wpf}`（`CLAUDE.section.md` / `.claude/rules/` / `harness.config.json` / 設計書の空枠）
- `tools/create-project.mjs` — base + env を合成してプロジェクトを生成する
  （プレースホルダ置換・`--dry-run`・Node 標準ライブラリのみ）。
  WPF テンプレートの `init-template.ps1` の Node 移植

### 設定契約

#### Added
- `envOptions`（任意フィールド）— 環境プラグイン専用の値置き場。core は読まない。
  現在の利用箇所は `envOptions.rootNamespace`（Unity の namespace 検査）

### Fixed
- **F5**: Unity の `pre-commit-cs-check` にあった namespace `YourApp` のハードコードを
  `envOptions.rootNamespace` 駆動へ。**未設定なら namespace 検査だけスキップ**（fail-open）
- **R1**: browser-test 系が機能設計書を節番号（「§4」「§5」）で参照していたのを**見出し名参照**へ
- `pre-migrate-backup` が `ORDERED_TABLES` 空のまま**空バックアップを黙って作る**問題を、
  検出してブロックするように変更
- nextjs の rules 索引と実ファイルの `paths` の不一致
- `pre-commit-cs-check` のヘッダコメントと実装の齟齬（`Assets/` と `Assets/Scripts/`）
- **permissions**: `Bash(rm -rf *)` が `rm -fr` 等の綴り違いを取りこぼしていた（実機検証で発見）。
  `Bash(rm -r*)` / `(rm -f*)` / `(rm --recursive*)` / `(rm --force*)` の列挙へ書き直し
- `.ps1` を UTF-8 BOM 付きに統一（Windows PowerShell 5.1 の CP932 誤読対策）

### レビュー修正（Phase 2 レビュー）
- 「作業中の機能設計書は `docs/features/pending/`」という誤記を6ファイルで修正。
  **正しくは作業中は `docs/features/` 直下**（`pending/` は一部保留の置き場）。
  core の `session-start-context` / `sync-check` は直下だけを見るため、
  `pending/` に置くとハーネスから見えなくなる
- `pre-migrate-backup` の `execSync(..., stdio: "inherit")` を `pipe` へ。
  **hook の stdout は JSON のみ**という公式仕様があり、子プロセスの出力が混ざると
  パース失敗で `continue:false` が無効化されるため

---

## [0.1.1] — Phase 1.1（レビュー指摘対応・2026-08-14）

### Fixed
- **R-1**: ゲートの合計時間が hook timeout を超えるとコミットが無検査で通る問題。
  各コマンドのタイムアウトを `min(MAX_COMMAND_MS, 残り予算 / 残りコマンド数)` とし、
  **タイムアウトは失敗扱いで deny** する
- **R-2**: `post-commit-doc-check` がコミットの成否を見ていなかった問題。
  `.claude/.pre-commit-head`（HEAD 記録）→ `git reflog` の2段構えで成立を確認する
- **R-3**〜**R-7**: `git commit` 検知の正規表現、`commands` のキー不在と null の区別、ほか

### 実測メモ
- 現行の Claude Code では **Bash ツールが非ゼロ終了した場合 PostToolUse hook は発火しない**

---

## [0.1.0] — Phase 1（harness-core の抽出・2026-08-14）

### Added
- `harness-core` プラグイン — 3テンプレート（nextjs / Unity / WPF）から環境非依存部分を抽出
  - スキル10本: `new-feature` / `design-review` / `code-review` / `build-check` / `update-docs` /
    `sync-check` / `complete-feature` / `pre-push-check` / `done` / `harness-update`（骨子）
  - エージェント3本: `coding-specialist` / `code-reviewer` / `documentation-manager`
  - フック5本: SessionStart / PreCompact / PreToolUse / PostToolUse / SubagentStop
- **設定契約 `.claude/harness.config.json`（schemaVersion 1）** — hooks / skills は全てこれを読んで動く
- `marketplace.json` — `extraKnownMarketplaces` 経由で認証なしに導入できる

### 設計原則
- すべて Node.js（CommonJS）。PowerShell / Bash スクリプトは使わない
- 発火判定は matcher に頼らず、stdin JSON の `tool_input.command` を各スクリプトで判定する
- config 不在・パース失敗・コマンド未定義は **`exit 0` で素通り**（fail-open）
- ブロック強度: 自己修復可能な失敗は `permissionDecision:"deny"`、
  人間判断が要る場合のみ `continue:false`
