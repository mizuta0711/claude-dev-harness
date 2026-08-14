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

`.claude/harness.config.json` の `commands` が正典（`/harness-core:build-check` が使う）。

| 用途 | コマンド |
|------|---------|
| ビルド | `dotnet build --nologo -v quiet -clp:NoSummary`（**コミット前ゲート**） |
| フォーマット検証 | `dotnet format --verify-no-changes --no-restore` |
| 実行 | `dotnet run` |

### 実装ルール

C# / MVVM の規約は `.claude/rules/` にパス条件付きで置いてある
（該当ファイルを読んだ時点で自動ロードされるため、手動で読む必要はない）。

| ルール | 発火条件（`paths`） |
|--------|-------------------|
| `csharp-wpf.md` | `{{CORE_PROJECT}}/**`, `{{UI_PROJECT}}/**` |
| `mvvm-viewmodel.md` | `{{UI_PROJECT}}/ViewModels/**`, `{{UI_PROJECT}}/Views/**` |
| `docs.md` | `docs/features/**`, `docs/設計書/**` |

要点だけ再掲する:

- **`{{CORE_PROJECT}}` は WPF に依存してはいけない**（`System.Windows` 名前空間を使用しない）
- 非同期処理は `async/await` + `CancellationToken` を徹底する
- 例外は Core 層でキャッチせず、イベントで通知して ViewModel 側でハンドリングする

### 環境固有スキル

| スキル | 用途 |
|--------|------|
| `/harness-wpf:capture-screenshots` | UIAutomation で実機スクリーンショットを撮影する（プライバシー保護チェック込み） |

- `product-advisor` エージェントは `/harness-core:design-review feature` が
  code-reviewer と並列で起動する（企画・UX 体験観点）
- **スキル名は `.gitignore` のビルド成果物パターン（`[Rr]elease/` `[Bb]uild/` `[Oo]ut/` `[Dd]ebug/`
  `[Ll]og(s)/` `[Bb]in/` `[Oo]bj/` 等）と衝突しないか確認する**
  （衝突すると `git status` にすら出ずコミット対象外になる）

### 実装順序

<!-- TODO: このプロジェクトの実装順序を記入する。推奨は
     「Core のインターフェース・モデル定義 → コアサービス → UI 骨格（MainWindow + 主要 View）
      → ViewModel 接続 → 周辺機能」の順。 -->
