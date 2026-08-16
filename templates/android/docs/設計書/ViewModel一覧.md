# ViewModel 一覧

## 概要

ViewModel と、それが公開する UI 状態・イベントの一覧（実態）。

- 関連方針: [.claude/rules/compose-ui.md](../../.claude/rules/compose-ui.md)
- 対応する画面は [画面一覧.md](画面一覧.md)

実装状況の凡例: ✅ 実装済 / 🔵 設計済（未実装） / ⚪ 将来フェーズ

> このファイルは「実態の一覧」です。実装の追加・変更時に `/harness-core:update-docs` で同期します。
> 初期状態は空です。最初の ViewModel を実装したら下表に追記してください。

---

## ViewModel 一覧（サマリ）

| ViewModel | ファイル | 対応画面 | 保持するスコープ | 実装状況 |
|-----------|---------|---------|----------------|---------|
| <!-- 例: HomeViewModel --> | <!-- ui/home/HomeViewModel.kt --> | <!-- ホーム --> | <!-- 画面 / ナビグラフ --> | 🔵 |

---

<!-- ViewModel ごとに以下の節を追加する（例）

## 1. HomeViewModel（🔵）

ファイル: `{{MODULE_NAME}}/src/main/java/<パッケージ>/ui/home/HomeViewModel.kt`

| 公開するもの | 型 | 内容 |
|------------|----|------|
| `uiState` | `StateFlow<HomeUiState>` | 画面状態（読み込み中・空・エラーを含む） |
| `onRefresh()` | `fun` | 再取得 |

依存: <!-- リポジトリ等 -->

-->

---

## 改訂履歴
| 版数 | 日付 | コミット | 内容 | 担当 |
|------|------|---------|------|------|
| 1.0 | yyyy-mm-dd | (テンプレート) | 初版（空スケルトン） | |
