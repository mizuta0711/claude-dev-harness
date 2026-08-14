---
paths:
  - "{{UI_PROJECT}}/ViewModels/**"
  - "{{UI_PROJECT}}/Views/**"
---

# MVVM / ViewModel 実装のルール

<!-- 移設元: WPF テンプレートの CLAUDE.md「ViewModels（テンプレート既定）」と
     .claude/03_library_docs/02_mvvm_guide.md の要点。 -->

## ViewModel

- **`CommunityToolkit.Mvvm` の Source Generator を使用する**（`[ObservableProperty]`, `[RelayCommand]`）
- ViewModel はモデル/サービスをラップし、UI バインディング用プロパティ・コマンドを公開する
- **大量に増えるコレクション（ログ等）は最大表示件数を設け、超過分は古い順に削除する**
- ViewModel からサービスを直接 new しない（コンストラクタで受け取る）

## View（XAML）

- ModernWpfUI のスタイル・テーマに準拠する
- コードビハインドにロジックを書かない（バインディングとコマンドで表現する）
- 表示専用の変換は `Converters/` の `IValueConverter` で行う

## 新しい画面（View）を追加する場合の一般手順

1. `{{UI_PROJECT}}/Views/` に XAML、`{{UI_PROJECT}}/ViewModels/` に ViewModel を作成
   （`[ObservableProperty]` / `[RelayCommand]`）
2. `docs/設計書/ViewModel・コマンド一覧.md` と `View-ViewModel-Service対応表.md` を更新
3. ModernWpfUI のスタイル・テーマに準拠していることを確認

## 新しいサービスを追加する場合の一般手順

1. `{{CORE_PROJECT}}/Services/`（または該当フォルダ）にクラスを作成。
   `async` + `CancellationToken`、イベント通知、冪等な Start/Stop/Dispose を守る
2. `docs/設計書/サービス一覧.md` にメソッド・イベントを追記
3. 利用する ViewModel と `docs/設計書/View-ViewModel-Service対応表.md` を更新
