# View-ViewModel-Service対応表

## 概要

WPF View（XAML）↔ ViewModel ↔ 利用する `{{CORE_PROJECT}}` サービス の対応関係をまとめた表（実態）。

- 関連方針: [.claude/rules/csharp-wpf.md](../../.claude/rules/csharp-wpf.md)、[.claude/rules/mvvm-viewmodel.md](../../.claude/rules/mvvm-viewmodel.md)

実装状況の凡例: ✅ 実装済 / 🔵 設計済（未実装）

> このファイルは「実態の一覧」です。View/ViewModel の追加・変更時に `/harness-core:update-docs` で同期します。
> 初期状態は空です。

---

## 対応表

| View | ファイル | ViewModel | 利用するサービス | 主な責務 | 実装状況 |
|------|----------|-----------|------------------|---------|---------|
| <!-- 例: MainWindow --> | <!-- Views/MainWindow.xaml --> | <!-- MainViewModel --> | <!-- 利用サービス --> | <!-- 責務 --> | 🔵 |

---

## 補足

- View ↔ ViewModel は `DataContext` バインディングで接続する。
- ViewModel ↔ サービスは依存性注入またはコンストラクタ経由でアクセスする。
- Core 層のイベントは ViewModel 側で UI スレッドにマーシャリングし、`ObservableCollection` に反映する。

### サービス→View 逆引き

| サービス | 主に利用する View / ViewModel |
|---------|------------------------------|
| <!-- 例: SampleService --> | <!-- MainWindow / MainViewModel --> |

---

## 改訂履歴
| 版数 | 日付 | コミット | 内容 | 担当 |
|------|------|---------|------|------|
| 1.0 | yyyy-mm-dd | (テンプレート) | 初版（空スケルトン） | |
