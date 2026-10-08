<!--
  このファイルはハーネス（claude-dev-harness）が所有する。
  `CLAUDE.md` から `@.claude/harness/environment.md` で読み込まれ、起動時に展開される。

  **プロジェクト側では編集しない。** 編集するとハーネス更新のたびに「競合」になる。
  **このプロジェクトだけの規律は `CLAUDE.md` に書く**（所有の一覧は `core.md` の冒頭）。
-->

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

**`.claude/harness.config.json` の `commands` が正典**（`/harness-core:build-check` が一括実行する）。
**コマンドはここに再掲しない。** PowerShell から直接叩くときだけ
`./gradlew` を `.\gradlew.bat` に読み替える。

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
（該当ファイルを読んだ時点で自動ロードされるため、手動で読む必要はない。
**発火条件は各ファイルの frontmatter `paths` が正**）。

要点だけ再掲する:

- **UI 状態は ViewModel が `StateFlow` で公開し、Composable は状態を受け取るだけにする**
- **DataStore・Room・OkHttp などの重いクライアントは必ずシングルトンにする**
  （画面ごとに作ると設定が復元されない・同期が二重に走る）
- **権限は「使う直前に要求し、拒否されたときの画面を必ず用意する」**

### 環境固有の挙動

- **動作確認（`verification.skill`）は `/harness-android:capture-screenshots`**（adb で撮影・
  プライバシー保護チェック込み）。**画面を伴う変更は、撮った画像を自分で確認してから完了報告する**

### 実装順序

<!-- TODO: このプロジェクトの実装順序を記入する。推奨は
     「ドメインモデル定義 → データ層（Room/DataStore とリポジトリ）→ ViewModel
      → 画面（Composable）→ ナビゲーション接続 → 権限まわり」の順。 -->
