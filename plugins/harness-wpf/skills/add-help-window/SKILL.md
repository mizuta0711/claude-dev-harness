---
name: add-help-window
description: WPF アプリに、同梱の利用マニュアル（web/manual）を表示するヘルプ窓（WebView2）を組み込む。F1 キーと「ヘルプ」ボタンで、いま表示している画面の説明ページを開き、マニュアルを出力フォルダの Help\ へ同梱する設定まで入れる。「ヘルプ画面を付けたい」「F1 でマニュアルを開きたい」「アプリの中でマニュアルを見られるようにしたい」「ヘルプボタンを付けたい」と依頼されたら使う。配布サイトとマニュアルの枠は add-distribution-site、インストーラーは add-installer が受け持つ。
allowed-tools: "Bash, PowerShell, Read, Write, Edit, Glob, Grep"
---

# ヘルプ窓を組み込む（WebView2・F1・同梱）

## 何を作るか

| 作るもの | 中身 |
|---------|------|
| ヘルプ窓 | 同梱のマニュアルを WebView2 で表示するだけの窓。専用のスレッドで動き、アプリでモーダルな窓が開いていても操作できる |
| F1 と「ヘルプ」ボタン | いま表示している画面の説明ページ（節まで）を開く。開いていれば同じ窓を前に出してページを変える |
| 飛び先の表 | 画面の名前 → マニュアルのパス（`manual/…html#id`）の対応を 1 か所に置く（`HelpTargets.cs`） |
| 同梱の設定 | csproj で `web/manual/**` と `web/assets/**`（`assets/img/site/` を除く）を出力の `Help\` へ写す |
| 代わりの開き方 | WebView2 が使えないときは同梱の同じページを既定のブラウザで、同梱物が無いときは配布サイトのマニュアルを開く |

雛形は `${CLAUDE_PLUGIN_ROOT}/skills/add-help-window/templates/` にある。

| 雛形 | 写す先 |
|------|--------|
| `templates/Services/HelpService.cs` | `{{UI_PROJECT_DIR}}/Services/HelpService.cs` |
| `templates/Services/HelpTargets.cs` | `{{UI_PROJECT_DIR}}/Services/HelpTargets.cs`（**この場所は変えない**。下の「飛び先の表の約束」） |
| `templates/Views/HelpWindow.xaml`・`HelpWindow.xaml.cs` | `{{UI_PROJECT_DIR}}/Views/` |
| `templates/csproj-snippet.xml` | `{{UI_CSPROJ}}` の `<Project>` の中へ足す |

雛形のファイルは写して値を差し替えるだけでよい。**既存のコードへの組み込み（起動時の設定・F1・ボタン・終了時の後始末）は、プロジェクトの構造を読んで手で行う**（手順 4）。プロジェクトごとに作りが違うため、雛形で上書きしない。

## 前提と 3 つのスキルの関係

- **WPF（.NET 6 以降の `net*-windows`）。** 雛形は `#nullable enable` と明示の `using` を持つので、`Nullable`・`ImplicitUsings` の設定に関係なくビルドできる。C# 10 以降（.NET 6 の既定）
- **依存は `Microsoft.Web.WebView2` だけ。** MVVM のライブラリ（CommunityToolkit.Mvvm など）やテーマのライブラリ（ModernWpfUI など）には頼らない。プロジェクトがそれらを使っていれば、組み込みの側でそれに合わせる
- 利用者の PC に **WebView2 ランタイム**が要る（Windows 11 には入っている。無ければ既定のブラウザで開く作りなので、アプリは止まらない）

harness-wpf の配布一式は 3 つのスキルに分かれている。**推奨の順は次のとおり。**

| 順 | スキル | 受け持ち |
|----|--------|---------|
| 1 | `add-distribution-site` | `web/` の配布サイト・`web/manual/` のマニュアルの枠・検査 `tools/check-web.mjs` |
| 2 | **`add-help-window`（これ）** | ヘルプ窓・F1・「ヘルプ」ボタン・`Help\` への同梱 |
| 3 | `add-installer` | インストーラー。完了画面で同梱の `Help\manual\getting-started.html` を開く |

**`web/manual/index.html` が無ければ、先に `add-distribution-site` を勧める。** 無いまま進めても
ビルドは通るが、`Help\` が空になり、F1 は「同梱されていない」扱いで配布サイトへ落ちる。
利用者が「先にヘルプ窓だけ」と決めたなら進めてよい（そのときは受け入れ基準の同梱の項目が確かめられないことを報告する）。

マニュアルの本文は書かない。本文は harness-doc（`/harness-doc:plan-doc`）で書く。

## 差し替える値の一覧

プレースホルダは 3 スキル共通で `{{UPPER_SNAKE}}`。**値は最初にまとめて決め、利用者に確認してから写す。**

| プレースホルダ | 意味 | 例・決め方 | 使う場所 |
|---------------|------|-----------|---------|
| `{{UI_CSPROJ}}` | WPF の UI プロジェクトの csproj | `src/MyApp/MyApp.csproj` | 手順（写す先） |
| `{{UI_PROJECT_DIR}}` | その csproj があるフォルダ | `src/MyApp` | 手順（写す先） |
| `{{ROOT_NAMESPACE}}` | UI プロジェクトの名前空間の根 | csproj の `RootNamespace`、無ければアセンブリ名。既存の `App.xaml` の `x:Class` と同じ根 | 雛形 4 ファイルの `namespace`・`x:Class`・`using` |
| `{{APP_NAME}}` | 画面に出すアプリ名 | `MyApp`。ヘルプ窓の題名は「`{{APP_NAME}}` ヘルプ」になる | `HelpWindow.xaml`・`HelpService.cs`（スレッド名） |
| `{{SITE_URL}}` | 配布サイトのトップ。**末尾 `/`** | `https://myapp.example.com/`。マニュアルは `{{SITE_URL}}manual/…` で公開されている前提（`add-distribution-site` の作り） | `HelpService.cs`（同梱物が無いときの落ち先） |
| `{{HELP_HOST}}` | 同梱物を見せる仮想ホスト名 | `myapp.example`。小文字。**実在しうるドメインは使わない**（実在のサイトと同じ名前だと、その名前への通信が同梱物に置き換わる）。末尾は予約されていて実在しない `.example`・`.test`・`.invalid` にする（`.manual` のような名前は将来実在しうる） | `HelpWindow.xaml.cs` |
| `{{WEB_DIR_FROM_UI}}` | `{{UI_PROJECT_DIR}}` から見た `web/` の相対パス（`\` 区切り） | csproj がリポジトリ直下の 1 段下なら `..\web`、2 段下なら `..\..\web`、直下なら `web` | `csproj-snippet.xml` |
| `{{DATA_DIR_EXPR}}` | アプリのデータの置き場を返す C# の式 | 下の「データの置き場」 | 手順 4-1（`App.xaml.cs` に書く） |

`{{EXE_NAME}}` は 3 スキル共通の名前だが、このスキルでは使わない。

### データの置き場（`{{DATA_DIR_EXPR}}`）

WebView2 は作業フォルダ（UserDataFolder。キャッシュ・Cookie など）を必要とし、
**指定しないと exe の隣に `<exe 名>.WebView2\` を作る。** このスキルは、データの置き場の下の `webview2\` に作らせる。

- **プロジェクトに、データの置き場を返す仕組み（設定の保存先・環境変数での切り替え・起動引数など）がすでにあれば、それが返す値を使う。** 起動時に 1 回解決した値をそのまま渡し、ヘルプ側で計算し直さない（切り替えの仕組みとずれるため）
- 無ければ、既定の例は次の式:

  ```csharp
  Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "{{APP_NAME}}")
  ```

**exe の隣に保存しない理由:**

- インストーラーが `Program Files` に入れると、利用者の権限では書き込めない
- `%LOCALAPPDATA%\Programs\<アプリ名>` に入れた場合も、上書きインストールやアンインストールでフォルダごと置き換え・削除の対象になる。アンインストール後に作業ファイルが残る原因にもなる
- アプリのフォルダは「配ったものだけ」にしておくと、何を配ったかが分かりやすい

## 手順

### 1. 値を確かめる

1. `{{UI_CSPROJ}}` を探す（`UseWPF` が `true` の csproj。複数あれば利用者に聞く）
2. `web/manual/index.html` があるかを見る。無ければ「前提と 3 つのスキルの関係」のとおり `add-distribution-site` を勧める
3. 次を読み、組み込む箇所の見当を付ける
   - `App.xaml.cs`（起動の処理。`OnStartup` か `Startup` のハンドラ。データの置き場を決めている処理があるか）
   - メインウィンドウ（`MainWindow.xaml(.cs)`）: 画面の切り替え方（`CurrentPage` のような ViewModel か、`Frame` か、タブか）・左メニューやツールバーの有無・閉じるときの処理（`OnClosing`・`Closing`）
   - コマンドの作り（MVVM のライブラリ・自前の `ICommand`・コードビハインド）
   - 記録（ログ）の仕組みと、利用者への知らせ方（画面の帯・ステータスバー・メッセージボックス）
   - すでに `Microsoft.Web.WebView2` を参照しているか
4. 「差し替える値の一覧」を埋めて利用者に見せ、確認を取る

### 2. 写す

雛形 4 ファイルを「写す先」へ写す。**写す先に同じ名前のファイルがあれば上書きせず止めて、利用者に聞く。**
プロジェクトが `Services/`・`Views/` を使っていなければ、既存の置き方に合わせてフォルダと名前空間を変えてよい。
**ただし `HelpTargets.cs` は `{{UI_PROJECT_DIR}}/Services/HelpTargets.cs` に置く**（検査がこのパスを読む）。
変えるなら、`tools/check-web.mjs` が読むパスも同じコミットで変える。

文字コードは UTF-8、改行は既存のファイルに合わせる。

### 3. 値を差し替える

写したファイルの `{{…}}` を、手順 1 で決めた値に置き換える。

### 4. 既存のコードへ組み込む

#### 4-1. 起動時に `Configure` を呼ぶ（`App.xaml.cs`）

メインウィンドウを出す前に 1 回呼ぶ。

```csharp
// using System; using System.IO; using {{ROOT_NAMESPACE}}.Services; が要る
HelpService.Configure(
    {{DATA_DIR_EXPR}},                       // データの置き場。WebView2 の作業フォルダはこの下の webview2\
    text => /* 同梱物が無いときの知らせ */,  // 画面の帯やステータスバーがあればそこへ。無ければ null（知らせずにブラウザで開く）
    (message, ex) => /* 記録 */);            // プロジェクトのログへ。null なら Trace に出る
```

- データの置き場をすでに解決している変数があれば、それを渡す（`{{DATA_DIR_EXPR}}` を書かない）
- 知らせはメインの UI スレッドで呼ばれる。記録はどのスレッドからも呼ばれる（ヘルプ窓のスレッドからも来る）ので、スレッドに縛られない書き方にする

#### 4-2. 飛び先の表を作る（`HelpTargets.cs`）

1. `web/manual/` の画面ごとのページと節の `id` を読み、画面（とその中の状態）ごとに飛び先の名前を決める
2. `Paths` の辞書に `[名前] = "manual/…html#id"` を書く。**マニュアルに実在するページと id だけを書く**（雛形の `main` は `add-distribution-site` の枠にある `manual/screens/main.html` を指す例。画面ごとのページに置き換える）
3. `ForPage` を、プロジェクトの「いまの画面」の表し方に合わせて書き換える（ViewModel の型で分ける・画面のキーで分ける・編集中など状態で節を分ける）。分からない画面は `Index`（入口）に落ちる

ページや節が足りなければ、本文は harness-doc で書く（ここでは書かない）。

#### 4-3. F1 と「ヘルプ」ボタン（メインウィンドウ）

プロジェクトのコマンドの作りに合わせて、どちらかで組む。

**MVVM（メインの ViewModel にコマンドを置いている）の場合:**

```csharp
// メインの ViewModel。CurrentPage は「いま表示している画面」を表すもの（プロジェクトの名前に合わせる）
public ICommand OpenHelpCommand { get; }   // プロジェクトのコマンドの作り（RelayCommand など）で作る
private void OpenHelp() => HelpService.Open(HelpTargets.ForPage(CurrentPage));
```

ViewModel をテストしているプロジェクトでは、`HelpService` を直接呼ばず、既存のダイアログ用のサービス（インターフェース）に `OpenHelp(string target)` を足して経由させる。

```xml
<Window.InputBindings>
    <KeyBinding Key="F1" Command="{Binding OpenHelpCommand}"/>
</Window.InputBindings>
```

**コードビハインドの場合:**

```xml
<Window.CommandBindings>
    <CommandBinding Command="ApplicationCommands.Help" Executed="OnHelpExecuted"/>
</Window.CommandBindings>
<Window.InputBindings>
    <KeyBinding Key="F1" Command="ApplicationCommands.Help"/>
</Window.InputBindings>
```

```csharp
private void OnHelpExecuted(object sender, ExecutedRoutedEventArgs e) =>
    HelpService.Open(HelpTargets.ForPage(/* いまの画面 */));
```

**「ヘルプ」ボタン:**

- 置き場所: 左メニューがあれば**その最下段**（画面の一覧には入れない。押しても選択と右の画面を変えない）。無ければツールバーかメニューの「ヘルプ」。下段に実行中の表示などがあれば、その下に置く
- `ToolTip` と `AutomationProperties.Name` を「ヘルプ（F1）」にする（読み上げで名前が読める）
- アイコンを付けるなら Segoe MDL2 Assets / Segoe Fluent Icons の `&#xE897;`（Help）。メニューを細く閉じる作りなら、閉じたときはアイコンだけにし、開閉ボタンと同じ幅の枠の中央に置く（開閉で位置がずれない）
- `Command` は F1 と同じもの（`{Binding OpenHelpCommand}` か `ApplicationCommands.Help`）

```xml
<Button Command="ApplicationCommands.Help" ToolTip="ヘルプ（F1）" AutomationProperties.Name="ヘルプ（F1）">
    <StackPanel Orientation="Horizontal">
        <TextBlock Text="&#xE897;" FontFamily="Segoe MDL2 Assets" VerticalAlignment="Center" Margin="0,0,8,0"/>
        <TextBlock Text="ヘルプ"/>
    </StackPanel>
</Button>
```

**別の窓（設定の窓など、モーダルで開く窓）に専用の説明の節があるとき**は、その窓にも F1 の `KeyBinding` を付け、その窓の飛び先の名前で `HelpService.Open` を呼ぶ。
**確認のメッセージ（OK／キャンセルの小窓）には付けない**（確認中に F1 で別の窓が開くと、どちらに答えているかが分かりにくくなる）。

#### 4-4. アプリを閉じるときの後始末（メインウィンドウ）

**閉じることが決まった時点**で `HelpService.RequestClose()` を 1 回呼ぶ。待たない。

- 閉じる前に確認を出す作りなら、**確認で「閉じる」になった後**に呼ぶ（キャンセルされたのに後からヘルプが開けなくなるのを防ぐ。`RequestClose` の後は新しく開かない）
- 実行中の処理の終わりを待ってから閉じる作りなら、**待つ前**に呼ぶ
- 確認も待ちも無ければ、`OnClosing` で `e.Cancel` が立っていないときに呼べばよい

```csharp
protected override void OnClosing(CancelEventArgs e)
{
    base.OnClosing(e);
    if (!e.Cancel) HelpService.RequestClose();
}
```

Windows のログオフ・シャットダウン（セッションの終了）の経路では呼ばなくてよい。ヘルプ窓のスレッドは背景スレッドなので、プロセスとともに消える。

#### 4-5. csproj

`templates/csproj-snippet.xml` の 2 つの `ItemGroup` を `{{UI_CSPROJ}}` に足す。

- すでに `Microsoft.Web.WebView2` を参照していれば、`PackageReference` は足さない（版を下げない）
- 雛形の版は作成時点のもの。新しく足すときは、そのときの安定版にしてよい

### 5. 残りのプレースホルダが無いことを確かめる

```bash
grep -rn "{{" <{{UI_PROJECT_DIR}}> --include=*.cs --include=*.xaml --include=*.csproj
```

1 件でも出たら、手順 3 に戻る。

### 6. ビルドする

```bash
dotnet build <{{UI_CSPROJ}}>
```

ビルドの後、出力フォルダに次があることを見る。

- `Help\manual\index.html`
- `Help\assets\…`（`web/assets` があれば）
- `Help\assets\img\site\` が**無い**こと

`tools/check-web.mjs` があれば流す（使い方は `add-distribution-site` の SKILL.md）。
飛び先の表のパスがマニュアルに無ければ、ここで止まる。

### 7. 実機で確かめる

下の「受け入れ基準」を実機で確かめる。

**UI Automation や SendKeys で F1 を送るときは、先にアプリの窓を前に出し、窓の中を 1 度クリックしてから送る。**
アプリにフォーカスが無いと、F1 は前にある別のアプリ（Edge なら Edge のヘルプ）に届く。
送る前に前面の窓がアプリであることを確かめ、違えば送らずに止める。
窓の操作と撮影の道具は `/harness-wpf:capture-screenshots` の `ui-capture.ps1` にある。

## 守ること（なぜ込み）

| 守ること | なぜ |
|---------|------|
| **ヘルプ窓は専用の STA スレッド（背景スレッド）で動かす**（雛形のまま） | WPF のモーダルな窓は、同じスレッドの他の窓を操作できなくする。メインのスレッドで確認の窓や設定の窓が開いていても、ヘルプ窓を開いて読めるようにするため。背景スレッドなので、メインが終わればプロセスが残らない |
| ヘルプ窓のスレッドの未処理の例外は、そのスレッドで受けて記録し、ヘルプ窓だけを閉じる（雛形のまま） | アプリの例外の受け皿（`DispatcherUnhandledException`）はメインのスレッドにしか効かない。ヘルプの不具合でアプリ全体を落とさない |
| `HelpWindow.xaml` でアプリのリソース（`App.xaml` のスタイル・テーマのライブラリ）を参照しない | アプリのリソースはメインのスレッドに結びついており、別スレッドの窓から使うと例外になりうる |
| **WebView2 の作業フォルダはデータの置き場の下**にする。`Configure` の前は WebView2 を使わず、ブラウザで開く（雛形のまま） | 既定のままだと exe の隣に作られる（「データの置き場」の理由）。`Configure` 前に作ると相対パス（exe の隣になりうる）に作ってしまう |
| **同梱物は仮想ホスト（`https://{{HELP_HOST}}/`）で見せる**。仮想ホストの外へのリンクは `http`・`https` だけ既定のブラウザに渡し、`file:`・`javascript:`・`mailto:` などは何もしない。新しい窓の要求も窓を増やさない（雛形のまま） | `file:///` で直接開くより `localStorage` などが安定する。ヘルプ窓の中で外のサイトを開くと、アドレスバーの無い窓で外のページを見せることになる |
| **WebView2 が使えないとき**（ランタイムが無い・環境の作成や初期化の失敗）は、窓を出さずに同梱の同じページを `file:///` で既定のブラウザに開く。同梱物そのものが無いときは配布サイトのマニュアルを開く（雛形のまま） | 利用者が説明を読めない状態にしない。節（`#id`）は Windows の関連付け次第で落ち、ページの先頭が開くことがある（受け入れる） |
| **後始末の穴を作らない**: 閉じた窓へ後から届いた F1 で `Show` しない・窓のスレッドの準備を無期限に待たない（10 秒で諦めてブラウザ）・窓を出す途中で失敗したら窓を閉じてからブラウザで開く（雛形のまま） | 元にした実装のコードレビューで見つかった穴。閉じた窓を出し直すと例外になる。無期限に待つとメインの UI が固まる。窓とブラウザの二重表示を防ぐ |
| **csproj は `web/manual/**` と `web/assets/**`（`assets/img/site/` を除く）を `Help\` へワイルドカードで写す** | マニュアルの元を `web/` の 1 か所にし、手で 2 か所を直さない。ページを足しても csproj を直さなくてよい。`assets/img/site/` は配布サイトだけで使う大きな画像で、入れるとインストーラーが大きくなる |
| **飛び先の表の約束を守る**（次の節） | マニュアルの節を消すと F1 が入口に落ちる。人の目では気づきにくいので、機械で守る |

### 飛び先の表の約束（`check-web.mjs` との契約）

`add-distribution-site` の検査 `tools/check-web.mjs` は、**`{{UI_PROJECT_DIR}}/Services/HelpTargets.cs` から
`"manual/….html"`（節があれば `#id` つき）の形の文字列リテラルを正規表現で拾い**、`web/` に
そのファイルと `id` があるかを確かめる。飛び先の表を設計書とコードの 2 か所に持たないためである。

- `HelpTargets.cs` の場所を変えない（変えるなら `check-web.mjs` の読む先も同じコミットで直す）
- パスは `[名前] = "manual/…html#id"` の形で、**二重引用符の文字列リテラルにそのまま書く**。定数の連結・文字列補間・別ファイルへの切り出しをすると、検査から漏れる
- 入口 `IndexPath = "manual/index.html"` も同じ形で書く（入口が無いのも検査で止める）
- マニュアルのページ名や節の `id` を変えたら、`HelpTargets.cs` も同じコミットで直す

### 本文にフォーカスがあるときの Esc

ヘルプ窓の Esc は、WPF の `PreviewKeyDown` で受けて閉じる。WebView2 の部品は、本文にフォーカスがあるときの
Esc・F1 などのキー（アクセラレータ キー）を WPF のキー入力に変えて送ってくる。
**届かなかったときの予備として、本文に Esc を拾うスクリプトを入れ、`chrome.webview.postMessage` で窓に知らせる**
（`HelpWindow.xaml.cs` の `EscapeScript`）。WPF 側で受けたときは本文に Esc が届かないので、二重には閉じない。

確かめたこと（2026-11-11、Windows 11・WebView2 ランタイム 157.0.4341.46・SDK 1.0.4022.49。最小の WPF アプリに雛形を入れて UI Automation で操作）:

- 本文（Document）にフォーカスがある状態で Esc → `PreviewKeyDown` で受けて閉じた（予備のスクリプトは動かなかった）
- `PreviewKeyDown` の Esc の処理を外した版 → 予備のスクリプトの知らせで閉じた

**確かめたのはこの 1 台・この版だけである。** プロジェクトごとに受け入れ基準で実機で確かめる。

## 受け入れ基準（実機で確かめる項目）

組み込んだら、次を実機で確かめて結果を報告する。確かめられなかった項目は「未確認」と書き、確かめたように書かない。
プロジェクトが試作フローや機能設計書を使っているなら、その受け入れ基準に写す。

**開く・飛び先**

- [ ] 「ヘルプ」ボタンを押すとヘルプ窓が開き、マニュアルが表示される（確認: 実機で操作して目視）
- [ ] 「ヘルプ」を押しても、メニューの選択と表示中の画面は変わらない（確認: 実機で操作して目視）
- [ ] 「ヘルプ」ボタンは、窓を最小の大きさにしても、メニューを細く閉じても欠けずに見え、ツールチップに「ヘルプ（F1）」と出る（確認: 実機で目視）
- [ ] 「ヘルプ」ボタンは読み上げの名前「ヘルプ（F1）」を持ち、Tab で移って Enter／Space で押せる（確認: UI Automation か Accessibility Insights で名前を読み、キーボードで操作）
- [ ] 飛び先の表の各行について、その画面（状態）で F1 を押すと、表のページ（節）が出る。同じページの別の節へ移る F1 でも、節まで動く（確認: 実機で表の全行を 1 行ずつ）
- [ ] 起動直後、どこもクリックしていない状態で F1 を押してもヘルプ窓が開く（確認: 実機で起動してすぐ F1。開かなければ、起動時にメインウィンドウの中の要素へフォーカスを置く）
- [ ] 確認のメッセージ（OK／キャンセルの小窓）が出ているときに F1 を押しても、ヘルプ窓は開かない（確認: 実機で確認を出して F1）

**1 つの窓・モーダルとの関係**

- [ ] ヘルプ窓を開いたまま別の画面で F1 を押すと、ヘルプ窓は 1 つのまま前に出て、ページがその画面のものに変わる（確認: 実機で操作し、タスクバーで窓の数を見る）
- [ ] ヘルプ窓を最小化し、モーダルの窓を開いた状態で F1 を押すと、ヘルプ窓が前に出て、スクロールやリンクの操作ができる（確認: 実機で操作）

**閉じる・後始末**

- [ ] ヘルプ窓を開いたままアプリを閉じると、ヘルプ窓も閉じ、プロセスが残らない（確認: 実機で操作し、タスク マネージャーで確かめる）
- [ ] 閉じる確認でキャンセルしたあとも、F1 でヘルプ窓が開く（閉じる確認がある作りのとき）（確認: 実機で操作）
- [ ] ヘルプ窓の中で想定外のエラーが起きても、アプリは落ちず、ヘルプ窓だけが閉じて記録が残る（確認: ヘルプ窓を開いたままタスク マネージャーで `msedgewebview2.exe` を終わらせる）

**キーボード**

- [ ] ヘルプ窓はキーボードだけで目次から本文のリンクまで移れる（確認: 実機で Tab を繰り返し、Enter）
- [ ] **本文（ページの中）にフォーカスがあるときに Esc でヘルプ窓が閉じる**。目次のリンクにフォーカスがあるときも閉じる（確認: 実機で本文をクリックしてから Esc。リンクへ Tab で移ってから Esc）
- [ ] ヘルプ窓の中で F1 を押しても何も起きない（確認: 実機で操作）

**表示・リンク**

- [ ] ネットワークを切った状態でも、ヘルプ窓にマニュアルの本文ページが表示される（確認: ネットワークを切って実機確認）
- [ ] ヘルプ窓の中の外部サイトへのリンク（配布サイトのトップなど）は、ヘルプ窓の中ではなく既定のブラウザで開く。**ヘルプ窓の中が外のページへ移っていないことも見る**（確認: 実機でリンクを押して目視。⚠️ 元にしたアプリの、この雛形を作った後の作業中の変更に「`NavigationStarting` の取り消しだけでは窓の中が外のページへ移ることが実機であった」とある〔未確定・2026-11-11〕。起きたら、本文側のスクリプトでリンクの押下を止めて `postMessage` で窓へ知らせる形を足す）
- [ ] ヘルプ窓には、配布サイト共通の上部メニュー（ダウンロード・更新履歴など）が出ない（確認: 実機で目視。出るならマニュアルの枠の作りを見直す）

**代わりの開き方**

- [ ] 飛び先のページが同梱物に無いときは、マニュアルの入口が出る（確認: 出力フォルダの `Help\manual\` から 1 ページを消して F1）
- [ ] 同梱物（`Help\`）が無いときは、その旨を知らせ、配布サイトのマニュアルを既定のブラウザで開く（確認: 出力フォルダの `Help\` を消して F1）
- [ ] WebView2 が使えないときは、ヘルプ窓を出さずに同梱の同じページを既定のブラウザで開く（確認: 環境変数 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` を存在しないフォルダにしてアプリを起動し F1。コードに試験用の切り替えは入れない）

**作業ファイル・同梱**

- [ ] ヘルプを開いた後、アプリのフォルダ（exe の隣）に WebView2 の作業フォルダ（`*.WebView2\`）が無く、データの置き場の下に `webview2\` がある（確認: 両方のフォルダの一覧を見る）
- [ ] 出力フォルダの `Help\` に `manual\` と `assets\` が入り、`assets\img\site\` は入らない（確認: `dotnet build` と `dotnet publish` の出力を見る）

## やらないこと

- **マニュアルの本文・配布サイトを作らない。** 枠と検査は `add-distribution-site`、本文は harness-doc（`/harness-doc:plan-doc`）
- **インストーラーを作らない。** `add-installer` が受け持つ
- 既存の `App.xaml.cs`・`MainWindow.xaml(.cs)` を雛形で上書きしない。組み込みは手順 4 のとおり、必要な箇所だけ足す
- ヘルプ窓をアプリのテーマ（明るい／暗い）に合わせない。見た目はマニュアル（`web/assets` の CSS）が決める
- アプリ全体のキー入力を横取りして F1 を拾わない（入力欄の F1 まで奪う）。F1 は窓ごとの `KeyBinding` で受ける
- 試験用の切り替え（WebView2 を失敗させるフラグなど）をコードに入れない。失敗は環境変数やプロセスの停止で起こす
