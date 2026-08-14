# ViewModel・コマンド一覧

## 概要

`{{UI_PROJECT}}` の ViewModel と、各 ViewModel が公開する `[RelayCommand]` / `[ObservableProperty]` の一覧（実態）。
CommunityToolkit.Mvvm の Source Generator を使用する。

- 関連方針: [.claude/rules/mvvm-viewmodel.md](../../.claude/rules/mvvm-viewmodel.md)

実装状況の凡例: ✅ 実装済 / 🔵 設計済（未実装）

> このファイルは「実態の一覧」です。ViewModel の追加・変更時に `/harness-core:update-docs` で同期します。
> 初期状態は空です。最初の ViewModel を実装したら下表に追記してください。

---

## ViewModel 一覧（サマリ）

| ViewModel | ファイル | 対応 View | 責務 | 実装状況 |
|-----------|----------|-----------|------|---------|
| <!-- 例: MainViewModel --> | <!-- ViewModels/MainViewModel.cs --> | <!-- MainWindow --> | <!-- 1行で責務 --> | 🔵 |

---

<!-- ViewModel ごとに以下の節を追加する（例）

## 1. MainViewModel（🔵）

| メンバ | 種別 | 想定シグネチャ | 責務 |
|--------|------|---------------|------|
| `Items` | ObservableProperty | `ObservableCollection<...>` | 一覧 |
| `AddCommand` | RelayCommand | `void Add()` | 追加 |

-->

---

## 改訂履歴
| 版数 | 日付 | コミット | 内容 | 担当 |
|------|------|---------|------|------|
| 1.0 | yyyy-mm-dd | (テンプレート) | 初版（空スケルトン） | |
