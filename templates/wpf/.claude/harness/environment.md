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

## 環境: WPF (.NET 8)

### 技術スタック

- .NET 8 / WPF
- ModernWpfUI（Fluent Design UIライブラリ）
- CommunityToolkit.Mvvm（MVVM基盤、Source Generator使用）
- System.Text.Json（設定・状態の永続化が必要な場合）

<!-- TODO: 追加で使用するライブラリがあれば記入 -->

**DBは使用しない**（既定）。永続化は JSON 設定ファイルのみ。

### プロジェクト構成

コアロジック（WPF非依存）と WPF UI を分離した2プロジェクト構成を基本とする。

```
{{PROJECT_NAME}}.sln
├── {{CORE_PROJECT}}/         # ビジネスロジック（WPF非依存・System.Windows 禁止）
│   ├── Models/               # ドメインモデル・DTO
│   └── Services/             # アプリケーションサービス
└── {{UI_PROJECT}}/           # WPF + ModernWpfUI
    ├── Views/                # XAML（ウィンドウ・画面・ダイアログ）
    ├── ViewModels/           # ViewModel（CommunityToolkit.Mvvm）
    ├── Converters/           # IValueConverter 等
    └── Services/             # UI寄りのサービス（永続化など）
```

<!-- TODO: 実際のフォルダ構成・主要クラスに合わせて更新する。
     構成が固まったら docs/設計書/ の各一覧と同期する。 -->

**テストプロジェクトを追加する場合（推奨規約）**: `{{CORE_PROJECT}}.Tests`（Core ロジック・net8.0）／
`{{UI_PROJECT}}.Tests`（ViewModel/Service・net8.0-windows。`InternalsVisibleTo` で UI の internal を検証）の
2本立てとし、xUnit + FluentAssertions を使う。配布対象外。`dotnet test` で実行。

### コマンドとゲート

**`.claude/harness.config.json` の `commands` が正典**（`/harness-core:build-check` が一括実行する）。
**コマンドはここに再掲しない。** コミット前ゲートは `gates.preCommit` の **`build`**。

### 実装ルール

C# / MVVM / XAML の規約は `.claude/rules/` にパス条件付きで置いてある
（該当ファイルを読んだ時点で自動ロードされる。**発火条件は各ファイルの frontmatter `paths` が正**）。

⚠️ **ただし「置けば必ず読まれる」わけではない。**

- **コンパクト（文脈の圧縮）後に再注入されない。** 長いセッションでは規約が静かに消える。
  **コンパクトを挟んで実装に戻るときは、該当ファイルを読み直す**
- **新規ファイルを一から作るときは発火しないことがある**（既存の該当ファイルを読まないため）

**この節に要点を再掲しているのは、その2つの穴を埋めるための意図的な例外である**
（手順の詳細は `.claude/rules/` にのみ書く）。

要点だけ再掲する:

- **`{{CORE_PROJECT}}` は WPF に依存してはいけない**（`System.Windows` 名前空間を使用しない）
- 非同期処理は `async/await` + `CancellationToken` を徹底する
- 例外は Core 層でキャッチせず、イベントで通知して ViewModel 側でハンドリングする

### 環境固有の挙動

- **動作確認（`verification.skill`）は `/harness-wpf:capture-screenshots`**（UIAutomation で
  実機スクリーンショットを撮影・プライバシー保護チェック込み）
- **スクリーンショットの保存先は `.gitignore` のビルド成果物パターン
  （`[Rr]elease/` `[Bb]uild/` `[Oo]ut/` `[Dd]ebug/` `[Ll]og(s)/` `[Bb]in/` `[Oo]bj/` 等）と
  衝突しないか確認する**（衝突すると `git status` にすら出ずコミット対象外になる）

### 実装順序

<!-- TODO: このプロジェクトの実装順序を記入する。推奨は
     「Core のインターフェース・モデル定義 → コアサービス → UI 骨格（MainWindow + 主要 View）
      → ViewModel 接続 → 周辺機能」の順。 -->
