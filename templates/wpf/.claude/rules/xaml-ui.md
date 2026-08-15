---
paths:
  - "{{UI_PROJECT}}/Views/**"
  - "{{UI_PROJECT}}/Themes/**"
  - "{{UI_PROJECT}}/Converters/**"
  - "{{UI_PROJECT}}/App.xaml"
---

# XAML / デザインシステムのルール

<!-- 移設元: 旧 WPF テンプレート（アーカイブ済み）の 03_library_docs/01_wpf_guide.md（XAML・バインディング・
     リソース）と 02_design_system/（デザイントークン・コンポーネント設計指針）。
     ViewModel 側の規約は mvvm-viewmodel.md、スレッド関連は csharp-wpf.md を参照。 -->

前提: **.NET 8 / WPF + ModernWpfUI**。UWP/WinUI ではないため **`x:Bind` は存在しない**。
バインディングはすべて `{Binding}`（実行時バインディング）を使う。

## 大原則

1. **見た目はコードビハインドで変えない** — Style / Trigger / Converter / DataTemplate で表現する
2. **色・余白・フォントを直書きしない** — 必ずデザイントークンを参照する
3. **色は `DynamicResource`** — テーマ切替に追従させるため（`StaticResource` で固定すると追従しない）
4. **1つの UserControl / View は1つの責務**に限定する

## バインディング

```xml
<!-- 双方向・即時反映（検索欄や入力欄） -->
<TextBox Text="{Binding FilterText, Mode=TwoWay, UpdateSourceTrigger=PropertyChanged}"/>

<!-- 表示のみ（既定 OneWay でも可、明示推奨） -->
<TextBlock Text="{Binding StatusText, Mode=OneWay}"/>
```

| Mode | 用途 |
|------|------|
| `OneWay` | ViewModel → View の表示のみ |
| `TwoWay` | 入力コントロール（TextBox / CheckBox / ComboBox.SelectedItem） |
| `OneTime` | 起動後変化しない値 |

- `UpdateSourceTrigger`: `PropertyChanged`（1文字ごと・即時反映）/ `LostFocus`（**TextBox の既定**）/ `Explicit`
- **`DataTemplate` 内では DataContext が項目 ViewModel になる。** 親のコマンドは
  `{Binding DataContext.AddCommand, RelativeSource={RelativeSource AncestorType=TabControl}}` で辿る
- View と ViewModel の結び付けは `DataTemplate`（`DataType="{x:Type vm:ItemViewModel}"`）による自動割当を推奨する

## リソースとスタイル

```
{{UI_PROJECT}}/
├── App.xaml                      # ThemeResources / XamlControlsResources のマージ、グローバル辞書
├── Converters/                   # IValueConverter 群（App.xaml でインスタンス登録）
└── Themes/
    ├── SemanticColors.xaml       # セマンティックカラー（ThemeDictionaries: Light/Dark）
    ├── Spacing.xaml              # 余白トークン（Thickness）
    ├── Typography.xaml           # TextBlock スタイル拡張
    └── Controls.xaml             # 共通コントロールスタイルの差分
```

- アプリ全体で使うリソースは `App.xaml` の `MergedDictionaries` に登録する。画面固有は当該 View の `Resources` へ
- **`DynamicResource` vs `StaticResource`**: テーマ追従が要る色・ブラシは `DynamicResource`。
  不変の定数（`Thickness` 等）は `StaticResource` で可
- 暗黙スタイル（`x:Key` なし + `TargetType` 指定）はスコープ内の全該当コントロールに適用される

### ModernWpfUI のセットアップ

```xml
<ResourceDictionary.MergedDictionaries>
  <ui:ThemeResources />                 <!-- ライト/ダーク・アクセント色 -->
  <ui:XamlControlsResources />          <!-- ModernWpfUI コントロールスタイル -->
  <ResourceDictionary Source="Themes/SemanticColors.xaml"/>
  <ResourceDictionary Source="Themes/Spacing.xaml"/>
  <ResourceDictionary Source="Themes/Typography.xaml"/>
</ResourceDictionary.MergedDictionaries>
```

- 標準コントロールは ModernWpfUI の暗黙スタイルをそのまま使い、**独自スタイルは差分のみ**定義する
- 角丸・アクセント色・フォーカス表現は既定に従い、過度なカスタムを避ける
- アクセントカラーは Windows のシステム設定に追従させる（`ThemeResources` の既定動作）
- テーマ既定は**システム設定に追従**（`RequestedTheme` 未指定）。実行時切替は
  `ModernWpf.ThemeManager.Current.ApplicationTheme = ApplicationTheme.Dark;`
- Window は `ui:WindowHelper.UseModernWindowStyle="True"` でモダンな枠にできる

## デザイントークン

### セマンティックカラー

「意味を持つ色」をトークンとして定義し、ライト/ダークの2系統を持つ。
ライトは濃いめ、ダークは明るめにしてどちらの地色でもコントラストを確保する。

| 用途 | トークン名 |
|------|-----------|
| 成功（正常完了） | `SuccessBrush` |
| 警告（注意が必要） | `WarningBrush` |
| エラー（失敗・異常） | `ErrorBrush` |
| 情報（通知・補足） | `InfoBrush` |

```xml
<ui:ThemeResources.ThemeDictionaries>
  <ResourceDictionary x:Key="Light">
    <SolidColorBrush x:Key="SuccessBrush" Color="#2E7D32"/>
    <SolidColorBrush x:Key="WarningBrush" Color="#E65100"/>
    <SolidColorBrush x:Key="ErrorBrush"   Color="#C62828"/>
    <SolidColorBrush x:Key="InfoBrush"    Color="#1565C0"/>
  </ResourceDictionary>
  <ResourceDictionary x:Key="Dark">
    <SolidColorBrush x:Key="SuccessBrush" Color="#81C784"/>
    <SolidColorBrush x:Key="WarningBrush" Color="#FFB74D"/>
    <SolidColorBrush x:Key="ErrorBrush"   Color="#EF5350"/>
    <SolidColorBrush x:Key="InfoBrush"    Color="#64B5F6"/>
  </ResourceDictionary>
</ui:ThemeResources.ThemeDictionaries>
```

> ⚠️ **WPF 標準の `ResourceDictionary.ThemeDictionaries` は UWP/WinUI 専用で、クラシック WPF では
> ビルドエラー（MC3074）になる。** ModernWpfUI が提供する `ui:ThemeResources.ThemeDictionaries`
> （`xmlns:ui="http://schemas.modernwpf.com/2019"`）を使うこと。

- 地・文字・境界などの基本色は ModernWpfUI のシステムブラシ（`SystemControlBackgroundAltHighBrush` 等）を
  `DynamicResource` で参照する。独自色は最小限にする
- **色のハードコードは XAML・コンバータのいずれでも禁止。** 必ずトークン経由で参照する

### スペーシング（4px グリッド）

| トークン | 値 | 用途 |
|---------|-----|------|
| `SpacingXS` | 4 | アイコンとラベルの間など最小余白 |
| `SpacingS` | 8 | コントロール内の標準パディング |
| `SpacingM` | 12 | フォーム項目間 |
| `SpacingL` | 16 | セクション間・ペイン外周 |
| `SpacingXL` | 24 | 画面外周・大きなブロック区切り |

### タイポグラフィ

ModernWpfUI の `TextBlock` スタイルを流用する。

| 用途 | スタイル | サイズ目安 |
|------|---------|-----------|
| 画面タイトル | `TitleTextBlockStyle` | 20 |
| セクション見出し | `SubtitleTextBlockStyle` | 16 |
| 本文・ラベル | `BodyTextBlockStyle` | 14 |
| 補助テキスト・タイムスタンプ | `CaptionTextBlockStyle` | 12 |

- コード・数値など桁の整列が重要な箇所は等幅フォント（`Consolas` / `Cascadia Mono`）を検討する

### アクセシビリティ

- 状態インジケーターは**色＋テキスト（またはアイコン）で二重に表現**し、色覚に依存させない
- 強調は色だけに頼らず、マーク・太字等と併用する

## IValueConverter

```csharp
public object Convert(object value, Type targetType, object? parameter, CultureInfo culture)
{
    var key = value switch
    {
        ItemStatus.Active   => "SuccessBrush",
        ItemStatus.Archived => "WarningBrush",
        _                   => "InfoBrush",
    };
    return Application.Current.TryFindResource(key) ?? Brushes.Gray;
}
```

- 意味（enum 等）→ ブラシの変換はコンバータで行い、**呼び出しのたびにトークン名で解決する**
- ⚠️ **解決したブラシを `Freeze()` して使い回したり、フィールドにキャッシュしたりしない。**
  `Frozen` なブラシはテーマ切替時に再評価されず、**表示済みの要素が再着色されない**
  （新規描画分だけ新テーマ色になり色ズレが起きる）。テーマ追従を保証するのは
  `DynamicResource` / `TryFindResource` の毎回解決であって、値のキャッシュではない
- `ConvertBack` が不要なら `throw new NotSupportedException()`

## 再利用コンポーネント

- **公開パラメータは `DependencyProperty` で定義**し、`{Binding}` 可能にする
- 状態・コマンドは ViewModel から流し込む（コードビハインドにロジックを書かない）
- リスト行は `DataTemplate` で定義し、`DataType` を項目 ViewModel に紐づける。
  状態による行の見た目変化は `DataTrigger` で表現する
- **大量データを表示する `ListView` / `ItemsControl` は仮想化（`VirtualizingStackPanel`）を有効にする。**
  表示件数の上限は ViewModel 側で管理する

## よくある落とし穴

- **`x:Bind` を書く** → WPF には無い。`{Binding}` を使う
- **色を `StaticResource` で固定** → テーマ切替に追従しない。色は `DynamicResource`
- **`UpdateSourceTrigger` 未指定の TextBox で即時反映を期待** → 既定は `LostFocus`
- **`INotifyPropertyChanged` 未実装プロパティをバインド** → 更新が反映されない（`[ObservableProperty]` を使う）
- **別スレッドから `ObservableCollection` に Add** → 例外・破損（`csharp-wpf.md` のマーシャリング参照）
- **コードビハインドで見た目を変更** → Style / Trigger / Converter で表現する
- **Window を閉じてもバックグラウンドタスクが残る** → `OnClosing` で `Cancel()` と `StopAsync`

<!-- TODO: このアプリ固有のセマンティックカラー・再利用コンポーネント・画面レイアウト規約を追記する。
     まとまったデザイン方針は .claude/02_design_system/ へ。 -->
