---
paths:
  - "{{MODULE_NAME}}/src/**/*.kt"
---

# Kotlin 実装のルール

## レイヤ分離（最重要）

- **依存の向きは `ui` → `domain` ← `data` の一方向。** `domain` から `ui` / `data` を参照しない
- **`domain` は Android SDK に依存しない**（`android.*` / `androidx.*` を import しない）。
  依存させると、その時点で実機なしのユニットテストができなくなる
- Android のフレームワーク型（`Context` / `Uri` / `Cursor`）を `domain` の
  シグネチャへ漏らさない。境界で自前のモデルへ変換する

## Kotlin の書き方

- **`!!` を使わない。** `?.` / `?:` / `requireNotNull(x) { "理由" }` で意図を示す
- 公開 API は可視性を明示する（既定の `public` に頼らない）。モジュール内限定は `internal`
- データの入れ物は `data class`、状態の候補が閉じているものは `sealed interface` / `enum`
- 分岐で状態を扱うときは `when` を**網羅**させる（`else` を書かない）。
  状態が増えたときに**コンパイルエラーで気づける**
- スコープ関数（`let` / `run` / `apply` / `also`）はネストさせない。2段までを目安にする

## コルーチンと Flow

1. **スコープを持つ側で起動する。** ViewModel なら `viewModelScope`、Composable なら
   `LaunchedEffect` / `rememberCoroutineScope`。**`GlobalScope` は使わない**（画面を離れても走り続ける）
2. **ブロッキング I/O は `withContext(Dispatchers.IO)` で包む。** ディスク・DB・ネットワークが対象
3. **UI 状態は `StateFlow` で公開する。** `MutableStateFlow` は `private`、公開側は
   `asStateFlow()`。イベント（1回だけ消費するもの）は `Channel` / `SharedFlow`
4. UI での購読は**ライフサイクルを意識した形**にする（`collectAsStateWithLifecycle()`）。
   素の `collectAsState()` は**画面が背面にあっても購読を続ける**
5. **`CancellationException` を握り潰さない。**
   `try { ... } catch (e: Exception) { ... }` は**キャンセルまで飲み込む**。
   `catch (e: CancellationException) { throw e }` を先に置くか、`runCatching` の結果を
   `onFailure` で選別する

```kotlin
try {
    repository.sync()
} catch (e: CancellationException) {
    throw e                       // キャンセルは正常系。必ず再スローする
} catch (e: IOException) {
    _uiState.update { it.copy(error = e.toMessage()) }
}
```

## コレクションの安全な扱い

- **反復中に元のコレクションを変更しない**（`ConcurrentModificationException`）。
  変更しうる場合は `toList()` でコピーしてから回す
- 共有される可変コレクションを複数のコルーチンから触らない。
  `StateFlow` の値を**まるごと差し替える**（`update { it + item }`）形にする

## ログ

- **個人情報・認証情報・本文をログに出さない**（端末のログは他アプリからは読めないが、
  `adb logcat` や不具合報告経由で外へ出る）
- リリースビルドでは詳細ログを落とす。ログの有無で挙動が変わる書き方をしない
- 例外は握り潰さず、**その場で扱えないなら上位へ伝える**

## 外部入力の扱い

ファイル・ネットワーク・他アプリ（Intent / ContentProvider）から来たデータは
信頼できないものとして扱う。パース時のバリデーション、サイズ・長さの上限、
例外処理を必ず入れる（constitution.md セキュリティ原則）。

- `Intent` の extra は**存在しない・型が違う**前提で読む
- 外部から受け取った `Uri` は、そのまま権限を渡さない（`takePersistableUriPermission` の要否を判断する）

## 参照

- 画面の実態: [docs/設計書/画面一覧.md](../../docs/設計書/画面一覧.md)
- 永続データの実態: [docs/設計書/データモデル・DAO一覧.md](../../docs/設計書/データモデル・DAO一覧.md)

<!-- TODO: このアプリ固有の実装ルール（中核ドメインの不変条件・状態遷移・命名の約束など）を
     追記する。ここに置くのは「実装時に毎回思い出す必要がある短い注意点」のみ（目安5〜6項目まで）。
     まとまった設計方針は .claude/01_development_docs/ へ。 -->
