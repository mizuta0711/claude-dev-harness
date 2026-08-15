---
paths:
  - "{{UI_PROJECT}}/ViewModels/**"
  - "{{UI_PROJECT}}/Views/**"
---

# MVVM / ViewModel 実装のルール

<!-- 移設元: 旧 WPF テンプレート（アーカイブ済み）の CLAUDE.md「ViewModels」と
     03_library_docs/02_mvvm_guide.md。
     パス条件付きルールにすることで、該当ファイルを読んだ時だけ自動ロードされる。 -->

## 基本方針

1. **View はロジックを持たない** — 状態・コマンドは ViewModel に置き、View は `{Binding}` で接続する
2. **Core をラップする** — ViewModel は Core のモデル/サービスを保持し、UI 用のプロパティ・コマンドを公開する
3. **Source Generator を使う** — `[ObservableProperty]` / `[RelayCommand]` を使い、手書きの `OnPropertyChanged` は最小化する
4. **`partial class` 必須** — Generator がコードを追記するため ViewModel は必ず `partial` で宣言する
   （忘れるとビルドが通らない）
5. ViewModel からサービスを直接 `new` しない（コンストラクタで受け取る）

## `[ObservableProperty]`

```csharp
public partial class ItemViewModel : ObservableObject
{
    [ObservableProperty]
    private string name = "";                    // → 公開プロパティ Name が生成される

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(StatusText))]   // 連動して変更通知したい別プロパティ
    private ItemStatus status;

    public string StatusText => Status switch { ... };
}
```

- **命名規則**: フィールド `name` → プロパティ `Name`（先頭大文字化、`_` / `m_` プレフィックスは除去）
- セッターは `SetProperty` を呼び、`PropertyChanged` を自動発火する
- `partial void OnNameChanged(string value)` / `OnNameChanging(...)` を定義すると変更フックを差し込める

## `[RelayCommand]`

```csharp
[RelayCommand(CanExecute = nameof(CanSave))]
private void Save() { /* ... */ }

private bool CanSave() => !string.IsNullOrEmpty(Name) && !IsBusy;
```

- メソッド `Save` → `SaveCommand` が生成される
- **`CanExecute` の判定値が変わったら `SaveCommand.NotifyCanExecuteChanged()` を呼ぶ**。
  呼ばないとボタンの有効/無効が更新されない。`OnXxxChanged` フックから呼ぶのが定石:

```csharp
partial void OnIsBusyChanged(bool value) => SaveCommand.NotifyCanExecuteChanged();
```

## 非同期コマンド

I/O を伴う処理（保存・読み込み等）は `async` の `[RelayCommand]` を使う（生成型は `IAsyncRelayCommand`）。

```csharp
[RelayCommand(CanExecute = nameof(CanSave))]
private async Task SaveAsync(CancellationToken ct)   // ct は自動で渡される
{
    try
    {
        await _service.SaveAsync(_item, ct).ConfigureAwait(false);
    }
    catch (OperationCanceledException) { /* 正常キャンセル。ログ不要 */ }
    catch (Exception ex)
    {
        AppendLog(LogLevel.Error, ex.Message);       // 例外はここでログ化する
    }
}
```

- メソッド末尾に `CancellationToken` を取ると、コマンドが自動でトークンを供給する
- `IAsyncRelayCommand` は実行中 `IsRunning` を持ち再入を防ぐ（`AllowConcurrentExecutions` 既定 false）
- `[RelayCommand(IncludeCancelCommand = true)]` で `SaveCancelCommand`（実行中タスクの取消）も生成できる
- **例外は ViewModel でハンドリングしログ化する。Core 層ではキャッチしない**

## Core イベントの UI 反映

Core のイベントはバックグラウンドスレッドから発火してよい。**UI へ反映する時に ViewModel が Dispatcher で切り替える。**

```csharp
_service.StateChanged += (_, s) =>
    Application.Current.Dispatcher.BeginInvoke(() => Status = s);
```

- 表示件数の上限があるコレクション（ログ・履歴等）は追加メソッド内で
  `while (Logs.Count > 1000) Logs.RemoveAt(0);` のように管理する
- スレッドの詳細は `csharp-wpf.md` の「非同期とスレッド」を参照

## ViewModel 間の通信（Messenger）

ViewModel を直接参照せずに通知する場合は `WeakReferenceMessenger` を使う。

```csharp
public sealed class ItemCreatedMessage(Item item) : ValueChangedMessage<Item>(item);

WeakReferenceMessenger.Default.Send(new ItemCreatedMessage(created));

WeakReferenceMessenger.Default.Register<ItemCreatedMessage>(this, (recipient, msg) => { ... });
```

- **受信登録した ViewModel の破棄時は `Unregister` する**（または `ObservableRecipient` の `IsActive` を使う）

## View（XAML）

- コードビハインドにロジックを書かない（初期化・フォーカス制御などビュー固有処理のみ）
- 双方向入力は `Mode=TwoWay`、即時反映が必要なテキストは `UpdateSourceTrigger=PropertyChanged`
  （`TextBox` の既定は `LostFocus`）
- 表示専用の変換は `Converters/` の `IValueConverter` で行う
- スタイル・色・余白の規約は `xaml-ui.md` を参照

## チェックリスト

- [ ] ViewModel は `partial class : ObservableObject`（または `ObservableRecipient`）
- [ ] 状態は `[ObservableProperty]`、手書き通知は最小限
- [ ] コマンドは `[RelayCommand]`、非同期は `async Task` ＋ `CancellationToken`
- [ ] `CanExecute` 変化時に `NotifyCanExecuteChanged()`
- [ ] Core イベント → UI 反映は Dispatcher 経由
- [ ] 例外は ViewModel でハンドリングしログ化（Core ではキャッチしない）
- [ ] Messenger を使ったら破棄時に `Unregister`

## 新しい画面（View）を追加する場合の一般手順

1. `{{UI_PROJECT}}/Views/` に XAML、`{{UI_PROJECT}}/ViewModels/` に ViewModel を作成
2. `docs/設計書/ViewModel・コマンド一覧.md` と `View-ViewModel-Service対応表.md` を更新
3. ModernWpfUI のスタイル・テーマに準拠していることを確認

## 新しいサービスを追加する場合の一般手順

1. `{{CORE_PROJECT}}/Services/`（または該当フォルダ）にクラスを作成。
   `async` + `CancellationToken`、イベント通知、冪等な Start/Stop/Dispose を守る
2. `docs/設計書/サービス一覧.md` にメソッド・イベントを追記
3. 利用する ViewModel と `docs/設計書/View-ViewModel-Service対応表.md` を更新
