# アーキテクチャ設計

> このファイルは**骨格**である。`{{PROJECT_NAME}}` の実態に合わせて書き換えること。
> 書き方と役割分担は [README.md](./README.md) を参照。

## 技術スタック

- .NET 8 / WPF
- ModernWpfUI（Fluent Design）
- CommunityToolkit.Mvvm（Source Generator）

<!-- TODO: 追加で採用したライブラリ・永続化方式・外部連携を記入する。 -->

## プロジェクト構成（推奨・既定）

コアロジック（WPF 非依存）と WPF UI を分離した2プロジェクト構成を基本とする。

```
{{PROJECT_NAME}}.sln
├── {{CORE_PROJECT}}/     # ビジネスロジック（System.Windows 禁止）
│   ├── Models/           # ドメインモデル・DTO
│   └── Services/         # アプリケーションサービス
└── {{UI_PROJECT}}/       # WPF + ModernWpfUI
    ├── Views/            # XAML
    ├── ViewModels/       # CommunityToolkit.Mvvm
    ├── Converters/       # IValueConverter
    ├── Themes/           # ResourceDictionary（色・余白・スタイル）
    └── Services/         # UI 寄りのサービス
```

**依存の向きは UI → Core の一方向。逆参照は禁止。**

- UI スレッドへのマーシャリングは ViewModel の責務（Core では行わない）
- 例外は Core でキャッチせず、イベントで通知して ViewModel でハンドリングする

<!-- TODO: プロジェクトを増減した場合（Tests / 拡張など）はこの図と参照規則を書き換える。 -->

## 中核概念

<!-- TODO: このアプリのドメインの中心にある概念（セッション・接続・ジョブ等）と、
     その状態遷移・不変条件を書く。ここが設計判断の土台になる。 -->

## 非同期・スレッドの基本方針

`async/await` + `CancellationToken` を徹底し、起動/停止/破棄は冪等に実装する
（詳細規約は `.claude/rules/csharp-wpf.md`）。

<!-- TODO: このアプリ固有のスレッド方針（常駐タスク・タイマー周期・停止順序）を書く。 -->

## 拡張の考え方

<!-- TODO: 新しい機能・新しい種類の部品を追加するときに従う手順や制約を書く。
     動的コード実行・プラグイン機構を持つ場合は、rules/csharp-wpf.md の
     「動的コード実行・プラグインを扱う場合」を満たす方針をここに明記する。 -->

## 改訂履歴

| 版数 | 日付 | 内容 | 担当 |
|------|------|------|------|
| 1.0 | yyyy-mm-dd | 初版作成（テンプレート適用） | |
