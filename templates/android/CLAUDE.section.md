## 環境: Android（Kotlin + Jetpack Compose）

### 技術スタック

- Kotlin / Jetpack Compose（Material 3）
- Gradle Kotlin DSL（`.gradle.kts`）+ Version Catalog（`gradle/libs.versions.toml`）
- 単一 Activity + Navigation Compose
- ViewModel + Kotlin Flow（`StateFlow` で UI 状態を公開する）

<!-- TODO: 永続化（Room / DataStore）・DI・ネットワーク・バックグラウンド処理など、
     実際に採用したライブラリを記入する。採用していないものは消す。 -->

**アプリケーション ID**: `{{APPLICATION_ID}}`
**アプリモジュール**: `{{MODULE_NAME}}`

<!-- TODO: minSdk / targetSdk / compileSdk を記入する。
     **どの API レベル以降を対象にするか**は互換コードの要否を左右するので必ず書く。 -->

### プロジェクト構成

```
{{MODULE_NAME}}/src/main/
├── AndroidManifest.xml        # 権限・コンポーネント宣言
└── java/<パッケージ>/          # 例: {{APPLICATION_ID}} をディレクトリに割ったパス
    ├── ui/                    # 画面（Composable）・ViewModel・テーマ
    │   ├── navigation/        # NavHost・ルート定義
    │   └── theme/             # Color / Type / Theme
    ├── domain/                # ドメインモデル・ユースケース（Android 非依存）
    └── data/                  # リポジトリ・DataSource・Room・DataStore
```

**依存の向きは ui → domain ← data の一方向。** `domain` は Android SDK に依存しない
（`android.*` を import しない）ことで、ユニットテストが実機なしで回る。

<!-- TODO: 実際のパッケージ構成に合わせて更新する。
     構成が固まったら docs/設計書/ の各一覧と同期する。 -->

### コマンドとゲート

`.claude/harness.config.json` の `commands` が正典（`/harness-core:build-check` が使う）。

| 用途 | コマンド（Bash / WSL） | PowerShell |
|------|----------------------|-----------|
| ビルド | `./gradlew assembleDebug` | `.\gradlew.bat assembleDebug` |
| Lint | `./gradlew lintDebug` | `.\gradlew.bat lintDebug` |
| ユニットテスト | `./gradlew testDebugUnitTest` | `.\gradlew.bat testDebugUnitTest` |
| 実機・エミュレータへ導入 | `./gradlew installDebug` | `.\gradlew.bat installDebug` |

> **コミット前ゲートは既定で空**（`gates.preCommit: []`）。Gradle ビルドは数十秒〜数分かかり、
> 毎回のコミットを詰まらせるため。**必要になったらプロジェクト側で足す**
> （`"preCommit": ["build"]`）。足したら実際にコミットして待ち時間を確かめること。

> ⚠️ **アプリをアンインストールしない。** `adb uninstall` / `./gradlew uninstallDebug` は
> **アプリのローカルデータ（DataStore・SharedPreferences・Room）を全て消す**。
> 更新は**上書きインストール**（`adb install -r` / `installDebug`）で行う。
> 署名が変わった場合とマイグレーション不能なスキーマ変更のときだけ例外。
> `harness-android` のフックが `adb uninstall` を捕まえて確認を求める。

### 実装ルール

Kotlin / Compose の規約は `.claude/rules/` にパス条件付きで置いてある
（該当ファイルを読んだ時点で自動ロードされるため、手動で読む必要はない）。

| ルール | 発火条件（`paths`） |
|--------|-------------------|
| `kotlin.md` | `{{MODULE_NAME}}/src/**/*.kt` |
| `compose-ui.md` | `{{MODULE_NAME}}/src/main/**/ui/**` |
| `android-data.md` | `{{MODULE_NAME}}/src/main/**/data/**` |
| `docs.md` | `docs/features/**`, `docs/設計書/**` |

要点だけ再掲する:

- **UI 状態は ViewModel が `StateFlow` で公開し、Composable は状態を受け取るだけにする**
- **DataStore・Room・OkHttp などの重いクライアントは必ずシングルトンにする**
  （画面ごとに作ると設定が復元されない・同期が二重に走る）
- **権限は「使う直前に要求し、拒否されたときの画面を必ず用意する」**

### 環境固有スキル

| スキル | 用途 |
|--------|------|
| `/harness-android:capture-screenshots` | 実機・エミュレータのスクリーンショットを adb で撮影する（プライバシー保護チェック込み） |

- `product-advisor` エージェントは `/harness-core:design-review feature` が
  code-reviewer と並列で起動する（企画・UX 体験観点）
- 動作確認（`verification.skill`）は `capture-screenshots`。
  **画面を伴う変更は、撮った画像を自分で確認してから完了報告すること**

### 実装順序

<!-- TODO: このプロジェクトの実装順序を記入する。推奨は
     「ドメインモデル定義 → データ層（Room/DataStore とリポジトリ）→ ViewModel
      → 画面（Composable）→ ナビゲーション接続 → 権限まわり」の順。 -->
